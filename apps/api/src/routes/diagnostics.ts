/**
 * Unverified-board workflow:
 *   POST /snapshots            — store the read-only FC snapshot taken in the browser (identity, diff all, capability)
 *   POST /snapshots/:id/image  — attach an externally dumped firmware image (dfu-util / STM32CubeProg)
 *   GET  /snapshots[/:id]
 *   POST /diagnostic-builds    — deterministic logging CLI script for a snapshot + base firmware
 *   POST /crash-reports        — multipart: diff_after + blackbox/host logs; runs analysis immediately
 *   GET  /crash-reports[/:id], POST /crash-reports/:id/verdict
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { analyzeFirmwareImage, imageMatchesBoard, parseDiff } from '@vtx/msp';
import { schema } from '../db/index.js';
import { analyzeCrash, buildDiagnosticScript, classifyTrust, type CrashFile } from '../lib/diagnostics.js';
import { env } from '../lib/env.js';

const uuid = z.object({ id: z.string().uuid() });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

const snapshotBody = z.object({
  uid: z.string().regex(/^[0-9a-fA-F]{8,64}$/),
  fcVariant: z.string().max(8),
  fcVersion: z.string().max(32),
  fcTarget: z.string().max(64),
  boardId: z.string().max(8).optional(),
  transport: z.object({ vid: z.number().int().optional(), pid: z.number().int().optional(), label: z.string().max(128) }).optional(),
  diffAll: z.string().max(512 * 1024).nullable(),
  diffError: z.string().max(512).nullable().optional(),
  statusText: z.string().max(64 * 1024).nullable().optional(),
  vtxConfig: z.record(z.number()).nullable().optional(),
  vtxMap: z.array(z.record(z.number())).nullable().optional(),
  capability: z.record(z.unknown()).optional(),
  note: z.string().max(1024).optional()
});

export const diagnosticsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /** Trust classification only (used by the wizard before the user decides to snapshot). */
  app.get('/verified-targets', async () => ({ success: true, targets: await app.db.select().from(schema.verifiedTargets) }));
  app.get('/trust', { schema: { querystring: z.object({ fcTarget: z.string(), fcVersion: z.string() }) } }, async (req) => {
    const rows = await app.db.select().from(schema.verifiedTargets);
    return { success: true, trust: classifyTrust(req.query.fcTarget, req.query.fcVersion, rows) };
  });

  app.post('/snapshots', { schema: { body: snapshotBody } }, async (req, reply) => {
    const rows = await app.db.select().from(schema.verifiedTargets);
    const trust = classifyTrust(req.body.fcTarget, req.body.fcVersion, rows);
    const [device] = await app.db.select({ id: schema.devices.id }).from(schema.devices).where(and(eq(schema.devices.uid, req.body.uid.toLowerCase()), eq(schema.devices.userId, req.user.sub)));
    const { diffError, ...b } = req.body;
    const [snap] = await app.db
      .insert(schema.boardSnapshots)
      .values({
        ...b,
        uid: b.uid.toLowerCase(),
        userId: req.user.sub,
        deviceId: device?.id ?? null,
        trust,
        diffSha256: b.diffAll ? sha(Buffer.from(b.diffAll)) : null,
        note: [b.note, diffError ? `diff all error: ${diffError}` : null].filter(Boolean).join('\n') || null
      })
      .returning();
    await app.audit(req, 'snapshot.create', snap!.id, { uid: snap!.uid, trust, target: snap!.fcTarget });
    return reply.code(201).send({ success: true, snapshot: snap, trust });
  });

  app.get('/snapshots', async (req) => ({
    success: true,
    snapshots: (await app.db.select().from(schema.boardSnapshots).where(eq(schema.boardSnapshots.userId, req.user.sub)).orderBy(desc(schema.boardSnapshots.createdAt))).map(({ diffAll, statusText, ...s }) => ({ ...s, hasDiff: Boolean(diffAll), hasStatus: Boolean(statusText) }))
  }));

  app.get('/snapshots/:id', { schema: { params: uuid } }, async (req, reply) => {
    const [s] = await app.db.select().from(schema.boardSnapshots).where(and(eq(schema.boardSnapshots.id, req.params.id), eq(schema.boardSnapshots.userId, req.user.sub)));
    if (!s) return reply.code(404).send({ success: false, error: 'not_found' });
    return { success: true, snapshot: s, parsedDiff: s.diffAll ? parseDiff(s.diffAll) : null };
  });

  /** Firmware image cannot be read over MSP; user dumps it with dfu-util/STM32CubeProg and uploads here (once). */
  app.post('/snapshots/:id/image', { schema: { params: uuid } }, async (req, reply) => {
    const [s] = await app.db.select().from(schema.boardSnapshots).where(and(eq(schema.boardSnapshots.id, req.params.id), eq(schema.boardSnapshots.userId, req.user.sub)));
    if (!s) return reply.code(404).send({ success: false, error: 'not_found' });
    if (s.imagePath) return reply.code(409).send({ success: false, error: 'image_already_attached' });
    let source = 'other';
    let file: { name: string; buf: Buffer } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') file = { name: part.filename, buf: await part.toBuffer() };
      else if (part.fieldname === 'source') source = String(part.value).slice(0, 32);
    }
    if (!file || file.buf.length < 1024) return reply.code(400).send({ success: false, error: 'image_required', hint: 'Прикрепите raw-дамп flash (.bin, обычно 1 МиБ для F405). Файл меньше 1 КиБ образом прошивки быть не может.' });
    const info = analyzeFirmwareImage(new Uint8Array(file.buf.buffer, file.buf.byteOffset, file.buf.byteLength));
    if (!info.vectorTableOk) return reply.code(400).send({ success: false, error: 'not_a_flash_dump', hint: info.warnings.join(' ') });
    const mismatch = imageMatchesBoard(info, { target: s.fcTarget, version: s.fcVersion, variant: s.fcVariant });
    if (mismatch.length) return reply.code(409).send({ success: false, error: 'image_board_mismatch', hint: `Дамп не от этого борта: ${mismatch.join('; ')}` });
    const dir = path.join(env.UPLOAD_DIR, 'snapshots', s.id);
    await mkdir(dir, { recursive: true });
    const imagePath = path.join(dir, safeName(file.name));
    await writeFile(imagePath, file.buf);
    const imageInfo = { ...info, regions: info.regions.map((r) => ({ start: r.start, end: r.end })) };
    await app.db
      .update(schema.boardSnapshots)
      .set({ imagePath, imageSha256: sha(file.buf), imageSizeBytes: file.buf.length, imageSource: source, imageInfo })
      .where(eq(schema.boardSnapshots.id, s.id));
    return { success: true, sha256: sha(file.buf), sizeBytes: file.buf.length, info };
  });

  app.post(
    '/diagnostic-builds',
    {
      schema: {
        body: z.object({
          snapshotId: z.string().uuid(),
          baseFirmwareId: z.string().uuid().optional(),
          logPath: z.enum(['flash', 'sdcard', 'serial_host']),
          rateDenom: z.number().int().min(1).max(255).default(2),
          debugMode: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).default('NONE'),
          serialPort: z.number().int().min(0).max(7).optional(),
          userDiff: z.string().max(256 * 1024).optional()
        })
      }
    },
    async (req, reply) => {
      const [s] = await app.db.select().from(schema.boardSnapshots).where(and(eq(schema.boardSnapshots.id, req.body.snapshotId), eq(schema.boardSnapshots.userId, req.user.sub)));
      if (!s) return reply.code(404).send({ success: false, error: 'snapshot_not_found' });
      if (s.trust === 'banned') return reply.code(403).send({ success: false, error: 'target_banned' });
      const cap = (s.capability ?? {}) as { flash?: { supported?: boolean }; sdcard?: { supported?: boolean; ready?: boolean } };
      if (req.body.logPath === 'flash' && cap.flash?.supported === false) return reply.code(400).send({ success: false, error: 'no_onboard_flash', hint: 'На этом борту нет dataflash: выберите sdcard или serial_host.' });
      if (req.body.logPath === 'sdcard' && cap.sdcard?.supported === false) return reply.code(400).send({ success: false, error: 'no_sdcard', hint: 'SD-карта не обнаружена.' });
      if (req.body.logPath === 'serial_host' && req.body.serialPort === undefined) return reply.code(400).send({ success: false, error: 'serial_port_required' });
      if (req.body.baseFirmwareId) {
        const [fw] = await app.db.select().from(schema.firmwareVersions).where(eq(schema.firmwareVersions.id, req.body.baseFirmwareId));
        if (!fw || fw.kind !== 'fc') return reply.code(404).send({ success: false, error: 'firmware_not_found' });
        if (fw.target.toUpperCase() !== s.fcTarget.toUpperCase()) return reply.code(400).send({ success: false, error: 'firmware_target_mismatch', hint: `Прошивка для ${fw.target}, борт ${s.fcTarget}.` });
      }
      const versionLine = s.diffAll ? parseDiff(s.diffAll).versionLine : null;
      const { snapshotId, baseFirmwareId, ...options } = req.body;
      const cliScript = buildDiagnosticScript(options, versionLine);
      const [b] = await app.db.insert(schema.diagnosticBuilds).values({ userId: req.user.sub, snapshotId, baseFirmwareId: baseFirmwareId ?? null, logPath: options.logPath, options, cliScript }).returning();
      await app.audit(req, 'diagnostic_build.create', b!.id, { snapshotId, logPath: options.logPath });
      return reply.code(201).send({ success: true, build: b });
    }
  );

  app.get('/diagnostic-builds', async (req) => ({ success: true, builds: await app.db.select().from(schema.diagnosticBuilds).where(eq(schema.diagnosticBuilds.userId, req.user.sub)).orderBy(desc(schema.diagnosticBuilds.createdAt)) }));
  app.patch('/diagnostic-builds/:id', { schema: { params: uuid, body: z.object({ status: z.enum(['applied', 'flown', 'crashed']) }) } }, async (req) => {
    await app.db.update(schema.diagnosticBuilds).set({ status: req.body.status, updatedAt: new Date() }).where(and(eq(schema.diagnosticBuilds.id, req.params.id), eq(schema.diagnosticBuilds.userId, req.user.sub)));
    return { success: true };
  });

  /**
   * multipart fields: snapshotId?, diagnosticBuildId?, uid?, fcTarget?, description?, diffAfter?
   * files (fieldname = kind): blackbox | host_log | photo | other
   */
  app.post('/crash-reports', async (req, reply) => {
    const fields: Record<string, string> = {};
    const files: CrashFile[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const kind = ['blackbox', 'host_log', 'photo', 'other'].includes(part.fieldname) ? part.fieldname : 'other';
        files.push({ kind, name: safeName(part.filename), bytes: new Uint8Array(await part.toBuffer()) });
      } else fields[part.fieldname] = String(part.value);
    }
    const meta = z
      .object({ snapshotId: z.string().uuid().optional(), diagnosticBuildId: z.string().uuid().optional(), uid: z.string().max(64).optional(), fcTarget: z.string().max(64).optional(), description: z.string().max(4000).optional(), diffAfter: z.string().max(512 * 1024).optional() })
      .safeParse(fields);
    if (!meta.success) return reply.code(400).send({ success: false, error: 'bad_request', issues: meta.error.issues });
    let snap: typeof schema.boardSnapshots.$inferSelect | undefined;
    if (meta.data.snapshotId) {
      [snap] = await app.db.select().from(schema.boardSnapshots).where(and(eq(schema.boardSnapshots.id, meta.data.snapshotId), eq(schema.boardSnapshots.userId, req.user.sub)));
      if (!snap) return reply.code(404).send({ success: false, error: 'snapshot_not_found' });
    }
    const [report] = await app.db
      .insert(schema.crashReports)
      .values({ userId: req.user.sub, snapshotId: snap?.id ?? null, diagnosticBuildId: meta.data.diagnosticBuildId ?? null, uid: meta.data.uid?.toLowerCase() ?? snap?.uid ?? null, fcTarget: meta.data.fcTarget ?? snap?.fcTarget ?? null, description: meta.data.description ?? null, diffAfter: meta.data.diffAfter ?? null })
      .returning();
    const dir = path.join(env.UPLOAD_DIR, 'crash', report!.id);
    await mkdir(dir, { recursive: true });
    const stored: Array<{ kind: string; name: string; path: string; sha256: string; sizeBytes: number }> = [];
    for (const f of files) {
      const p = path.join(dir, `${f.kind}-${f.name}`);
      await writeFile(p, f.bytes);
      stored.push({ kind: f.kind, name: f.name, path: p, sha256: sha(f.bytes), sizeBytes: f.bytes.length });
    }
    const analysis = analyzeCrash(snap?.diffAll ?? null, meta.data.diffAfter ?? null, files);
    await app.db.update(schema.crashReports).set({ files: stored, analysis: analysis as unknown as Record<string, unknown>, status: 'analyzed', updatedAt: new Date() }).where(eq(schema.crashReports.id, report!.id));
    if (meta.data.diagnosticBuildId) await app.db.update(schema.diagnosticBuilds).set({ status: 'crashed', updatedAt: new Date() }).where(and(eq(schema.diagnosticBuilds.id, meta.data.diagnosticBuildId), eq(schema.diagnosticBuilds.userId, req.user.sub)));
    await app.audit(req, 'crash_report.create', report!.id, { files: stored.length, critical: analysis.findings.filter((f) => f.severity === 'critical').length });
    return reply.code(201).send({ success: true, report: { ...report, files: stored, analysis, status: 'analyzed' } });
  });

  app.get('/crash-reports', async (req) => ({ success: true, reports: await app.db.select().from(schema.crashReports).where(eq(schema.crashReports.userId, req.user.sub)).orderBy(desc(schema.crashReports.createdAt)) }));
  app.get('/crash-reports/:id', { schema: { params: uuid } }, async (req, reply) => {
    const [r] = await app.db.select().from(schema.crashReports).where(and(eq(schema.crashReports.id, req.params.id), eq(schema.crashReports.userId, req.user.sub)));
    if (!r) return reply.code(404).send({ success: false, error: 'not_found' });
    return { success: true, report: r };
  });
  /** User feedback after flying the proposed fix — this is what gates publication. */
  app.post('/crash-reports/:id/verdict', { schema: { params: uuid, body: z.object({ verdict: z.enum(['ok', 'still_crashes', 'not_flown']), comment: z.string().max(2000).optional() }) } }, async (req, reply) => {
    const [r] = await app.db.select().from(schema.crashReports).where(and(eq(schema.crashReports.id, req.params.id), eq(schema.crashReports.userId, req.user.sub)));
    if (!r) return reply.code(404).send({ success: false, error: 'not_found' });
    if (!r.fixFirmwareId && !r.fixDiffContent) return reply.code(409).send({ success: false, error: 'no_fix_proposed' });
    await app.db.update(schema.crashReports).set({ userVerdict: req.body.verdict, status: req.body.verdict === 'ok' ? 'fixed' : 'fix_proposed', description: req.body.comment ? `${r.description ?? ''}\n\n[отзыв] ${req.body.comment}`.trim() : r.description, updatedAt: new Date() }).where(eq(schema.crashReports.id, r.id));
    await app.audit(req, 'crash_report.verdict', r.id, { verdict: req.body.verdict });
    return { success: true };
  });
};
