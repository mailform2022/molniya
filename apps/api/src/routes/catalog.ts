import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { schema } from '../db/index.js';

/** Public/user-facing catalog: models, firmware, VTX models, ranges, submissions, reports. */
export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/models', async () => {
    const boards = await app.db.select().from(schema.boardModels).where(eq(schema.boardModels.isActive, true));
    const transmitters = await app.db.select().from(schema.transmitterModels).where(eq(schema.transmitterModels.isActive, true));
    const layouts = await app.db.select().from(schema.boardPinLayouts).where(eq(schema.boardPinLayouts.status, 'published'));
    return { success: true, boards, transmitters, layouts };
  });

  app.get('/firmware', { schema: { querystring: z.object({ kind: z.enum(['fc', 'transmitter', 'configurator']).optional(), target: z.string().optional() }) } }, async (req) => {
    const conds = [eq(schema.firmwareVersions.isPublished, true)];
    if (req.query.kind) conds.push(eq(schema.firmwareVersions.kind, req.query.kind));
    if (req.query.target) conds.push(eq(schema.firmwareVersions.target, req.query.target));
    const list = await app.db
      .select({
        id: schema.firmwareVersions.id,
        kind: schema.firmwareVersions.kind,
        target: schema.firmwareVersions.target,
        version: schema.firmwareVersions.version,
        fileName: schema.firmwareVersions.fileName,
        sha256: schema.firmwareVersions.sha256,
        sizeBytes: schema.firmwareVersions.sizeBytes,
        changelog: schema.firmwareVersions.changelog,
        modelIds: schema.firmwareVersions.modelIds,
        createdAt: schema.firmwareVersions.createdAt
      })
      .from(schema.firmwareVersions)
      .where(and(...conds))
      .orderBy(desc(schema.firmwareVersions.createdAt));
    return { success: true, firmware: list };
  });

  app.get('/firmware/:id/download', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const [fw] = await app.db.select().from(schema.firmwareVersions).where(and(eq(schema.firmwareVersions.id, req.params.id), eq(schema.firmwareVersions.isPublished, true)));
    if (!fw) return reply.code(404).send({ success: false, error: 'not_found' });
    const st = await stat(fw.filePath).catch(() => null);
    if (!st) return reply.code(410).send({ success: false, error: 'file_missing' });
    await app.usage(req.user.sub, 'firmware.download', { id: fw.id, target: fw.target, version: fw.version });
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${fw.fileName}"`)
      .header('X-Sha256', fw.sha256)
      .header('Content-Length', String(st.size))
      .send(createReadStream(fw.filePath));
  });

  app.get('/frequency-ranges', async () => ({ success: true, ranges: await app.db.select().from(schema.frequencyRanges).orderBy(schema.frequencyRanges.sortOrder) }));

  app.get('/vtx-models', { schema: { querystring: z.object({ rangeId: z.string().uuid().optional() }) } }, async (req) => {
    const conds = [eq(schema.vtxModels.isDisabled, false)];
    if (req.query.rangeId) conds.push(eq(schema.vtxModels.rangeId, req.query.rangeId));
    const models = await app.db.select().from(schema.vtxModels).where(and(...conds));
    const photos = await app.db.select().from(schema.vtxConnectionPhotos);
    return { success: true, models, photos };
  });

  /** CrowdSourceWizard → pending_review */
  app.post(
    '/vtx-submissions',
    {
      preHandler: app.requireRole(['operator', 'technician']),
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        body: z.object({
          name: z.string().min(2).max(128),
          manufacturer: z.string().max(128).optional(),
          rangeId: z.string().uuid().optional(),
          protocol: z.string().max(32).optional(),
          freqTable: z.array(z.array(z.number().int().min(1000).max(8000)).min(1).max(16)).min(1).max(8),
          cliStatusHex: z.string().max(4096).optional(),
          parsedStatus: z.record(z.unknown()).optional(),
          autoDetection: z.record(z.unknown()).optional()
        })
      }
    },
    async (req, reply) => {
      const flat = req.body.freqTable.flat();
      if (new Set(flat).size !== flat.length) return reply.code(400).send({ success: false, error: 'duplicate_frequencies' });
      const [s] = await app.db.insert(schema.vtxSubmissions).values({ userId: req.user.sub, ...req.body }).returning();
      await app.audit(req, 'vtx.submit', s!.id);
      return reply.code(201).send({ success: true, submission: s });
    }
  );

  app.get('/vtx-submissions/mine', { preHandler: app.authenticate }, async (req) => ({
    success: true,
    submissions: await app.db.select().from(schema.vtxSubmissions).where(eq(schema.vtxSubmissions.userId, req.user.sub)).orderBy(desc(schema.vtxSubmissions.createdAt))
  }));

  /** AutoDetectVTXWizard result log (for matching + prefill analytics). */
  app.post(
    '/vtx-auto-detections',
    { preHandler: app.authenticate, schema: { body: z.object({ fcTarget: z.string().max(64).optional(), fcVersion: z.string().max(32).optional(), vtxConfig: z.record(z.unknown()).optional(), vtxInfo: z.record(z.unknown()).optional(), log: z.array(z.string()).max(500).default([]) }) } },
    async (req) => {
      // match by frequency table overlap
      const freqs = ((req.body.vtxInfo?.freqTable as number[] | undefined) ?? []).slice(0, 64);
      let matchedVtxModelId: string | undefined;
      if (freqs.length) {
        const models = await app.db.select({ id: schema.vtxModels.id, freqTable: schema.vtxModels.freqTable }).from(schema.vtxModels).where(eq(schema.vtxModels.isDisabled, false));
        let best = 0;
        for (const m of models) {
          const set = new Set(m.freqTable.flat());
          const hits = freqs.filter((f) => set.has(f)).length / freqs.length;
          if (hits > best && hits >= 0.8) {
            best = hits;
            matchedVtxModelId = m.id;
          }
        }
      }
      const [d] = await app.db.insert(schema.vtxAutoDetections).values({ userId: req.user.sub, ...req.body, matchedVtxModelId }).returning();
      return { success: true, detection: d, matchedVtxModelId: matchedVtxModelId ?? null };
    }
  );

  app.post(
    '/reports',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: { body: z.object({ vtxModelId: z.string().uuid().optional(), category: z.enum(['channels', 'frequency', 'autodetect', 'firmware', 'config', 'other']), message: z.string().min(3).max(4000), context: z.record(z.unknown()).optional() }) }
    },
    async (req, reply) => {
      const [r] = await app.db.insert(schema.vtxReports).values({ userId: req.user.sub, ...req.body }).returning();
      if (req.body.vtxModelId) {
        // auto-trigger: 3+ reports on a VTX in 7 days → flag
        const n = await app.db.$count(schema.vtxReports, and(eq(schema.vtxReports.vtxModelId, req.body.vtxModelId), gte(schema.vtxReports.createdAt, sql`now() - interval '7 days'`)));
        if (n >= 3) await app.db.update(schema.vtxModels).set({ flagged: true }).where(eq(schema.vtxModels.id, req.body.vtxModelId));
      }
      return reply.code(201).send({ success: true, report: r });
    }
  );

  /** BoardSubmissionWizard */
  app.post(
    '/board-submissions',
    { preHandler: app.requireRole(['operator', 'technician']), schema: { body: z.object({ name: z.string().min(2).max(128), fcTarget: z.string().max(64).optional(), detected: z.record(z.unknown()).optional(), totalPins: z.number().int().min(1).max(64).optional(), pins: z.array(z.object({ pin: z.string(), x: z.number(), y: z.number(), role: z.string(), rcChannel: z.number().int().optional(), range: z.tuple([z.number(), z.number()]).optional(), signal: z.enum(['pwm', 'digital', 'servo']).optional() })).optional() }) } },
    async (req, reply) => {
      let layoutId: string | undefined;
      if (req.body.pins && req.body.totalPins) {
        const [l] = await app.db.insert(schema.boardPinLayouts).values({ fcTarget: req.body.fcTarget ?? 'UNKNOWN', totalPins: req.body.totalPins, pins: req.body.pins, status: 'draft' }).returning({ id: schema.boardPinLayouts.id });
        layoutId = l!.id;
      }
      const [s] = await app.db.insert(schema.boardSubmissions).values({ userId: req.user.sub, name: req.body.name, fcTarget: req.body.fcTarget, detected: req.body.detected, layoutId }).returning();
      return reply.code(201).send({ success: true, submission: s });
    }
  );

  app.get('/vtx-profiles', { preHandler: app.authenticate }, async (req) => ({
    success: true,
    profiles: await app.db.select().from(schema.vtxProfiles).where(sql`${schema.vtxProfiles.userId} = ${req.user.sub} or ${schema.vtxProfiles.isPublic} = true`)
  }));

  const pairSchema = z.object({ band: z.number().int().min(1).max(8), channel: z.number().int().min(1).max(8), freqMhz: z.number().int(), rcChannel: z.number().int().min(5).max(16), rcLevel: z.number().int().min(900).max(2100) });
  app.post('/vtx-profiles', { preHandler: app.requireRole(['operator']), schema: { body: z.object({ name: z.string().max(128), vtxModelId: z.string().uuid().optional(), pairs: z.array(pairSchema).max(16) }) } }, async (req, reply) => {
    const [p] = await app.db.insert(schema.vtxProfiles).values({ userId: req.user.sub, ...req.body }).returning();
    return reply.code(201).send({ success: true, profile: p });
  });
  app.put('/vtx-profiles/:id', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ name: z.string().max(128).optional(), pairs: z.array(pairSchema).max(16).optional() }) } }, async (req) => {
    await app.db.update(schema.vtxProfiles).set({ ...req.body, updatedAt: new Date() }).where(and(eq(schema.vtxProfiles.id, req.params.id), eq(schema.vtxProfiles.userId, req.user.sub)));
    await app.publish({ channel: `user:${req.user.sub}:session`, type: 'vtx-profile.updated', payload: { id: req.params.id, by: req.user.sid } });
    return { success: true };
  });
};
