/**
 * Build sets — the saved result of a wizard pass for one board («сохранить для следующего раза»):
 *   POST  /build-sets                      — validate inputs, resolve provenance (snapshot, firmware, VTX profile),
 *                                            generate FC CLI/JSON + TX YAML server-side, store with hashes
 *   GET   /build-sets[?uid=]               — user's sets (artifact text omitted)
 *   GET   /build-sets/:id                  — full set
 *   GET   /build-sets/:id/artifact/:kind   — download fc_cli | fc_bundle | tx_yaml (X-Sha256 header)
 *   PATCH /build-sets/:id                  — progress flags (fcApplied/vtxMapWritten/txApplied), name, status
 *   POST  /firmware/:id/feedback           — flight feedback for a firmware build (flew_ok | issue | crashed)
 *   GET   /firmware/:id/feedback           — aggregated counts (public) + own entry
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { buildArtifacts, validatePairs } from '../lib/artifacts.js';
import { classifyTrust } from '../lib/diagnostics.js';

const uuid = z.object({ id: z.string().uuid() });
const pairSchema = z.object({ band: z.number().int().min(1).max(8), channel: z.number().int().min(1).max(8), freqMhz: z.number().int(), rcChannel: z.number().int().min(5).max(16), rcLevel: z.number().int().min(900).max(2100) });

const createBody = z.object({
  uid: z.string().regex(/^[0-9a-fA-F]{8,64}$/),
  fcTarget: z.string().min(2).max(64),
  fcVersion: z.string().max(32),
  snapshotId: z.string().uuid().nullable().optional(),
  fcFirmwareId: z.string().uuid().nullable().optional(),
  txFirmwareId: z.string().uuid().nullable().optional(),
  diagnosticBuildId: z.string().uuid().nullable().optional(),
  vtxProfileId: z.string().uuid().nullable().optional(),
  vtxModelId: z.string().uuid().nullable().optional(),
  vtxModelName: z.string().max(128).nullable().optional(),
  freqSource: z.enum(['catalog', 'vtx_info', 'manual', 'file']).default('manual'),
  txModelCode: z.string().min(2).max(64),
  userDiff: z.string().max(256 * 1024).default(''),
  pairs: z.array(pairSchema).max(16),
  fcApplied: z.boolean().default(false),
  vtxMapWritten: z.boolean().default(false),
  name: z.string().max(128).optional()
});

const ARTIFACT = {
  fc_cli: { col: 'fcScript', mime: 'text/plain; charset=utf-8', ext: 'cli.txt' },
  fc_bundle: { col: 'fcBundle', mime: 'application/json', ext: 'json' },
  tx_yaml: { col: 'txYaml', mime: 'text/yaml; charset=utf-8', ext: 'yml' }
} as const;

export const buildSetRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  const own = (id: string, userId: string) => and(eq(schema.buildSets.id, id), eq(schema.buildSets.userId, userId));

  app.post('/build-sets', { preHandler: app.requireRole(['operator', 'technician']), schema: { body: createBody } }, async (req, reply) => {
    const b = req.body;
    const uid = b.uid.toLowerCase();
    const pairErr = validatePairs(b.pairs);
    if (pairErr) return reply.code(400).send({ success: false, error: 'invalid_pairs', hint: pairErr });

    const trust = classifyTrust(b.fcTarget, b.fcVersion, await app.db.select().from(schema.verifiedTargets));
    if (trust === 'banned') return reply.code(403).send({ success: false, error: 'target_banned' });

    let snapshot: { id: string; takenAt: string } | null = null;
    if (b.snapshotId) {
      const [s] = await app.db.select({ id: schema.boardSnapshots.id, uid: schema.boardSnapshots.uid, createdAt: schema.boardSnapshots.createdAt }).from(schema.boardSnapshots).where(and(eq(schema.boardSnapshots.id, b.snapshotId), eq(schema.boardSnapshots.userId, req.user.sub)));
      if (!s) return reply.code(404).send({ success: false, error: 'snapshot_not_found' });
      if (s.uid.toLowerCase() !== uid) return reply.code(400).send({ success: false, error: 'snapshot_uid_mismatch', hint: 'Снимок сделан с другого борта.' });
      snapshot = { id: s.id, takenAt: s.createdAt.toISOString() };
    }
    if (trust !== 'verified' && !snapshot) return reply.code(409).send({ success: false, error: 'snapshot_required', hint: 'Для непроверенного борта комплект без исходного снимка не сохраняется.' });

    type FwRef = { id: string; fileName: string; sha256: string; verification: string };
    type FwLookup = { ok: true; fw: FwRef | null } | { ok: false; code: number; error: string; hint?: string };
    const fw = async (id: string | null | undefined, kind: 'fc' | 'transmitter', target: string): Promise<FwLookup> => {
      if (!id) return { ok: true, fw: null };
      const [f] = await app.db.select().from(schema.firmwareVersions).where(and(eq(schema.firmwareVersions.id, id), eq(schema.firmwareVersions.isPublished, true)));
      if (!f) return { ok: false, code: 404, error: `${kind}_firmware_not_found` };
      if (f.kind !== kind) return { ok: false, code: 400, error: 'firmware_kind_mismatch' };
      if (f.target.toUpperCase() !== target.toUpperCase()) return { ok: false, code: 400, error: 'firmware_target_mismatch', hint: `Прошивка для ${f.target}, требуется ${target}.` };
      return { ok: true, fw: { id: f.id, fileName: f.fileName, sha256: f.sha256, verification: f.verification } };
    };
    const fcLookup = await fw(b.fcFirmwareId, 'fc', b.fcTarget);
    if (!fcLookup.ok) return reply.code(fcLookup.code).send({ success: false, error: fcLookup.error, hint: fcLookup.hint });
    const txLookup = await fw(b.txFirmwareId, 'transmitter', b.txModelCode);
    if (!txLookup.ok) return reply.code(txLookup.code).send({ success: false, error: txLookup.error, hint: txLookup.hint });
    const fcFirmware = fcLookup.fw;
    const txFirmware = txLookup.fw;

    let diagnostic: { id: string; logPath: string; cliScript: string } | null = null;
    if (b.diagnosticBuildId) {
      const [d] = await app.db.select().from(schema.diagnosticBuilds).where(and(eq(schema.diagnosticBuilds.id, b.diagnosticBuildId), eq(schema.diagnosticBuilds.userId, req.user.sub)));
      if (!d) return reply.code(404).send({ success: false, error: 'diagnostic_build_not_found' });
      if (snapshot && d.snapshotId !== snapshot.id) return reply.code(400).send({ success: false, error: 'diagnostic_snapshot_mismatch' });
      diagnostic = { id: d.id, logPath: d.logPath, cliScript: d.cliScript };
    }

    if (b.vtxProfileId) {
      const [p] = await app.db.select({ id: schema.vtxProfiles.id }).from(schema.vtxProfiles).where(and(eq(schema.vtxProfiles.id, b.vtxProfileId), sql`(${schema.vtxProfiles.userId} = ${req.user.sub} or ${schema.vtxProfiles.isPublic} = true)`));
      if (!p) return reply.code(404).send({ success: false, error: 'vtx_profile_not_found' });
    }
    const [txModel] = await app.db.select({ code: schema.transmitterModels.code }).from(schema.transmitterModels).where(and(eq(schema.transmitterModels.code, b.txModelCode), eq(schema.transmitterModels.isActive, true)));
    if (!txModel) return reply.code(400).send({ success: false, error: 'unknown_transmitter_model' });

    const generatedAt = new Date().toISOString();
    const art = buildArtifacts({
      target: b.fcTarget,
      uid,
      trust,
      generatedAt,
      snapshot,
      fcFirmware,
      txFirmware,
      userDiff: b.userDiff,
      diagnostic,
      vtx: { modelName: b.vtxModelName ?? null, freqSource: b.freqSource, pairs: b.pairs },
      transmitter: { code: b.txModelCode, profileId: b.vtxProfileId ?? null }
    });

    const [row] = await app.db
      .insert(schema.buildSets)
      .values({
        userId: req.user.sub,
        uid,
        fcTarget: b.fcTarget,
        trust,
        snapshotId: snapshot?.id ?? null,
        fcFirmwareId: fcFirmware?.id ?? null,
        txFirmwareId: txFirmware?.id ?? null,
        diagnosticBuildId: diagnostic?.id ?? null,
        vtxProfileId: b.vtxProfileId ?? null,
        vtxModelId: b.vtxModelId ?? null,
        vtxModelName: b.vtxModelName ?? null,
        freqSource: b.freqSource,
        txModelCode: b.txModelCode,
        userDiff: b.userDiff,
        pairs: b.pairs,
        fcScript: art.fcScript,
        fcBundle: art.fcBundle,
        txYaml: art.txYaml,
        hashes: art.hashes,
        fcApplied: b.fcApplied,
        vtxMapWritten: b.vtxMapWritten,
        name: b.name ?? `${b.fcTarget} · ${b.txModelCode} · ${b.pairs.length} пар`
      })
      .returning();
    await app.audit(req, 'build_set.create', row!.id, { uid, trust, pairs: b.pairs.length, fcFirmware: fcFirmware?.id ?? null });
    await app.usage(req.user.sub, 'build_set.create', { target: b.fcTarget, tx: b.txModelCode });
    return reply.code(201).send({ success: true, buildSet: row });
  });

  const listCols = {
    id: schema.buildSets.id,
    uid: schema.buildSets.uid,
    fcTarget: schema.buildSets.fcTarget,
    trust: schema.buildSets.trust,
    snapshotId: schema.buildSets.snapshotId,
    fcFirmwareId: schema.buildSets.fcFirmwareId,
    txFirmwareId: schema.buildSets.txFirmwareId,
    diagnosticBuildId: schema.buildSets.diagnosticBuildId,
    vtxModelName: schema.buildSets.vtxModelName,
    freqSource: schema.buildSets.freqSource,
    txModelCode: schema.buildSets.txModelCode,
    pairs: schema.buildSets.pairs,
    hashes: schema.buildSets.hashes,
    fcApplied: schema.buildSets.fcApplied,
    vtxMapWritten: schema.buildSets.vtxMapWritten,
    txApplied: schema.buildSets.txApplied,
    status: schema.buildSets.status,
    crashReportId: schema.buildSets.crashReportId,
    name: schema.buildSets.name,
    createdAt: schema.buildSets.createdAt,
    updatedAt: schema.buildSets.updatedAt
  };

  app.get('/build-sets', { schema: { querystring: z.object({ uid: z.string().max(64).optional() }) } }, async (req) => {
    const conds = [eq(schema.buildSets.userId, req.user.sub)];
    if (req.query.uid) conds.push(eq(schema.buildSets.uid, req.query.uid.toLowerCase()));
    return { success: true, buildSets: await app.db.select(listCols).from(schema.buildSets).where(and(...conds)).orderBy(desc(schema.buildSets.createdAt)).limit(100) };
  });

  app.get('/build-sets/:id', { schema: { params: uuid } }, async (req, reply) => {
    const [row] = await app.db.select().from(schema.buildSets).where(own(req.params.id, req.user.sub));
    if (!row) return reply.code(404).send({ success: false, error: 'not_found' });
    return { success: true, buildSet: row };
  });

  app.get('/build-sets/:id/artifact/:kind', { schema: { params: z.object({ id: z.string().uuid(), kind: z.enum(['fc_cli', 'fc_bundle', 'tx_yaml']) }) } }, async (req, reply) => {
    const [row] = await app.db.select().from(schema.buildSets).where(own(req.params.id, req.user.sub));
    if (!row) return reply.code(404).send({ success: false, error: 'not_found' });
    const a = ARTIFACT[req.params.kind];
    const body = row[a.col];
    const base = req.params.kind === 'tx_yaml' ? `${row.txModelCode.toUpperCase()}_VtxAuto_v3.1_${row.uid.slice(0, 8)}` : `fc-${row.fcTarget}-${row.uid.slice(0, 8)}`;
    await app.usage(req.user.sub, 'build_set.download', { id: row.id, kind: req.params.kind });
    return reply.header('Content-Type', a.mime).header('Content-Disposition', `attachment; filename="${base}.${a.ext}"`).header('X-Sha256', row.hashes[a.col]).send(body);
  });

  app.patch(
    '/build-sets/:id',
    {
      preHandler: app.requireRole(['operator', 'technician']),
      schema: { params: uuid, body: z.object({ name: z.string().max(128).optional(), fcApplied: z.boolean().optional(), vtxMapWritten: z.boolean().optional(), txApplied: z.boolean().optional(), status: z.enum(['ready', 'flown_ok', 'crashed']).optional(), crashReportId: z.string().uuid().nullable().optional() }) }
    },
    async (req, reply) => {
      const [row] = await app.db.select({ id: schema.buildSets.id }).from(schema.buildSets).where(own(req.params.id, req.user.sub));
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' });
      if (req.body.crashReportId) {
        const [cr] = await app.db.select({ id: schema.crashReports.id }).from(schema.crashReports).where(and(eq(schema.crashReports.id, req.body.crashReportId), eq(schema.crashReports.userId, req.user.sub)));
        if (!cr) return reply.code(404).send({ success: false, error: 'crash_report_not_found' });
      }
      const patch = { ...req.body, ...(req.body.crashReportId && !req.body.status ? { status: 'crashed' as const } : {}) };
      await app.db.update(schema.buildSets).set({ ...patch, updatedAt: new Date() }).where(eq(schema.buildSets.id, row.id));
      await app.audit(req, 'build_set.update', row.id, patch);
      return { success: true };
    }
  );

  // ---------------------------------------------------------------- firmware flight feedback
  app.post(
    '/firmware/:id/feedback',
    {
      preHandler: app.requireRole(['operator', 'technician']),
      schema: { params: uuid, body: z.object({ uid: z.string().regex(/^[0-9a-fA-F]{8,64}$/).optional(), buildSetId: z.string().uuid().optional(), crashReportId: z.string().uuid().optional(), outcome: z.enum(['flew_ok', 'issue', 'crashed']), flights: z.number().int().min(1).max(1000).default(1), comment: z.string().max(4000).optional() }) }
    },
    async (req, reply) => {
      const [fwRow] = await app.db.select({ id: schema.firmwareVersions.id, kind: schema.firmwareVersions.kind }).from(schema.firmwareVersions).where(eq(schema.firmwareVersions.id, req.params.id));
      if (!fwRow) return reply.code(404).send({ success: false, error: 'not_found' });
      const uid = req.body.uid?.toLowerCase() ?? '';
      if (req.body.buildSetId) {
        const [bs] = await app.db.select({ id: schema.buildSets.id, fcFirmwareId: schema.buildSets.fcFirmwareId, txFirmwareId: schema.buildSets.txFirmwareId }).from(schema.buildSets).where(own(req.body.buildSetId, req.user.sub));
        if (!bs) return reply.code(404).send({ success: false, error: 'build_set_not_found' });
        if (bs.fcFirmwareId !== fwRow.id && bs.txFirmwareId !== fwRow.id) return reply.code(400).send({ success: false, error: 'firmware_not_in_build_set', hint: 'Отзыв можно оставить только о прошивке, которая входит в этот комплект.' });
      }
      if (req.body.crashReportId) {
        const [cr] = await app.db.select({ id: schema.crashReports.id }).from(schema.crashReports).where(and(eq(schema.crashReports.id, req.body.crashReportId), eq(schema.crashReports.userId, req.user.sub)));
        if (!cr) return reply.code(404).send({ success: false, error: 'crash_report_not_found' });
      }
      if (req.body.outcome === 'crashed' && !req.body.crashReportId) return reply.code(400).send({ success: false, error: 'crash_report_required', hint: 'Падение подтверждается крэш-отчётом: сначала загрузите логи и diff после падения.' });
      const values = { firmwareId: fwRow.id, userId: req.user.sub, uid, buildSetId: req.body.buildSetId ?? null, crashReportId: req.body.crashReportId ?? null, outcome: req.body.outcome, flights: req.body.flights, comment: req.body.comment ?? null };
      const [row] = await app.db
        .insert(schema.firmwareFeedback)
        .values(values)
        .onConflictDoUpdate({ target: [schema.firmwareFeedback.firmwareId, schema.firmwareFeedback.userId, schema.firmwareFeedback.uid], set: { outcome: values.outcome, flights: values.flights, comment: values.comment, crashReportId: values.crashReportId, buildSetId: values.buildSetId } })
        .returning();
      if (req.body.buildSetId) await app.db.update(schema.buildSets).set({ status: req.body.outcome === 'flew_ok' ? 'flown_ok' : req.body.outcome === 'crashed' ? 'crashed' : 'ready', crashReportId: req.body.crashReportId ?? null, updatedAt: new Date() }).where(eq(schema.buildSets.id, req.body.buildSetId));
      await app.audit(req, 'firmware.feedback', fwRow.id, { outcome: req.body.outcome, uid });
      return reply.code(201).send({ success: true, feedback: row });
    }
  );

  app.get('/firmware/:id/feedback', { schema: { params: uuid } }, async (req) => {
    const rows = await app.db
      .select({ outcome: schema.firmwareFeedback.outcome, n: sql<number>`count(*)::int`, flights: sql<number>`coalesce(sum(${schema.firmwareFeedback.flights}),0)::int`, boards: sql<number>`count(distinct ${schema.firmwareFeedback.uid})::int` })
      .from(schema.firmwareFeedback)
      .where(eq(schema.firmwareFeedback.firmwareId, req.params.id))
      .groupBy(schema.firmwareFeedback.outcome);
    const mine = await app.db.select().from(schema.firmwareFeedback).where(and(eq(schema.firmwareFeedback.firmwareId, req.params.id), eq(schema.firmwareFeedback.userId, req.user.sub)));
    const summary = { flew_ok: { n: 0, flights: 0, boards: 0 }, issue: { n: 0, flights: 0, boards: 0 }, crashed: { n: 0, flights: 0, boards: 0 } } as Record<string, { n: number; flights: number; boards: number }>;
    for (const r of rows) summary[r.outcome] = { n: r.n, flights: r.flights, boards: r.boards };
    return { success: true, summary, mine };
  });
};
