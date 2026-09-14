import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { randomToken } from '../lib/crypto.js';
import { analyzeDiff, lineDiff } from '../lib/diff.js';

export const diffRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Public templates (admin-curated) with their current version. */
  app.get('/diff/templates', async () => {
    const rows = await app.db
      .select({ t: schema.diffTemplates, v: schema.diffTemplateVersions })
      .from(schema.diffTemplates)
      .leftJoin(schema.diffTemplateVersions, eq(schema.diffTemplateVersions.id, schema.diffTemplates.currentVersionId))
      .where(eq(schema.diffTemplates.isPublic, true));
    return { success: true, templates: rows.map(({ t, v }) => ({ ...t, version: v?.version ?? null, content: v?.content ?? '', parsed: v?.parsed ?? null })) };
  });

  app.get('/diff/templates/:id/versions', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => ({
    success: true,
    versions: await app.db.select().from(schema.diffTemplateVersions).where(eq(schema.diffTemplateVersions.templateId, req.params.id)).orderBy(desc(schema.diffTemplateVersions.createdAt))
  }));

  app.post('/diff/analyze', { schema: { body: z.object({ content: z.string().max(200_000), base: z.string().max(200_000).optional() }) } }, async (req) => ({
    success: true,
    analysis: analyzeDiff(req.body.content),
    diff: req.body.base !== undefined ? lineDiff(req.body.base, req.body.content) : undefined
  }));

  // ---- user diffs (/account/diffs) ----
  app.get('/diffs', { preHandler: app.authenticate }, async (req) => {
    const rows = await app.db
      .select({ d: schema.userDiffs, v: schema.userDiffVersions })
      .from(schema.userDiffs)
      .leftJoin(schema.userDiffVersions, eq(schema.userDiffVersions.id, schema.userDiffs.currentVersionId))
      .where(eq(schema.userDiffs.userId, req.user.sub))
      .orderBy(desc(schema.userDiffs.updatedAt));
    return { success: true, diffs: rows.map(({ d, v }) => ({ ...d, version: v?.version ?? 0, content: v?.content ?? d.draft ?? '' })) };
  });

  app.post(
    '/diffs',
    {
      preHandler: app.requireRole(['operator']),
      schema: { body: z.object({ name: z.string().max(128), boardModelId: z.string().uuid().optional(), parentTemplateId: z.string().uuid().optional(), duplicateOf: z.string().uuid().optional(), content: z.string().max(200_000).optional() }) }
    },
    async (req, reply) => {
      let content = req.body.content ?? '';
      let boardModelId = req.body.boardModelId;
      if (req.body.parentTemplateId && !content) {
        const [t] = await app.db
          .select({ content: schema.diffTemplateVersions.content, boardModelId: schema.diffTemplates.boardModelId })
          .from(schema.diffTemplates)
          .leftJoin(schema.diffTemplateVersions, eq(schema.diffTemplateVersions.id, schema.diffTemplates.currentVersionId))
          .where(eq(schema.diffTemplates.id, req.body.parentTemplateId));
        content = t?.content ?? '';
        boardModelId ??= t?.boardModelId ?? undefined;
      }
      if (req.body.duplicateOf) {
        const [src] = await app.db
          .select({ content: schema.userDiffVersions.content, d: schema.userDiffs })
          .from(schema.userDiffs)
          .leftJoin(schema.userDiffVersions, eq(schema.userDiffVersions.id, schema.userDiffs.currentVersionId))
          .where(and(eq(schema.userDiffs.id, req.body.duplicateOf), eq(schema.userDiffs.userId, req.user.sub)));
        content = src?.content ?? src?.d.draft ?? '';
        boardModelId ??= src?.d.boardModelId ?? undefined;
      }
      const diff = await app.db.transaction(async (tx) => {
        const [d] = await tx.insert(schema.userDiffs).values({ userId: req.user.sub, name: req.body.name, boardModelId, parentTemplateId: req.body.parentTemplateId, draft: content }).returning();
        const [v] = await tx.insert(schema.userDiffVersions).values({ diffId: d!.id, version: 1, content }).returning();
        await tx.update(schema.userDiffs).set({ currentVersionId: v!.id }).where(eq(schema.userDiffs.id, d!.id));
        return { ...d!, currentVersionId: v!.id, version: 1, content };
      });
      return reply.code(201).send({ success: true, diff });
    }
  );

  /** Autosave draft (every 5 s from the editor). */
  app.put('/diffs/:id/draft', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ draft: z.string().max(200_000) }) } }, async (req) => {
    await app.db.update(schema.userDiffs).set({ draft: req.body.draft, updatedAt: new Date() }).where(and(eq(schema.userDiffs.id, req.params.id), eq(schema.userDiffs.userId, req.user.sub)));
    await app.publish({ channel: `user:${req.user.sub}:session`, type: 'diff.draft', payload: { id: req.params.id, by: req.user.sid } });
    return { success: true, analysis: analyzeDiff(req.body.draft) };
  });

  /** Commit draft as a new version. */
  app.post('/diffs/:id/versions', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ content: z.string().max(200_000).optional() }) } }, async (req, reply) => {
    const [d] = await app.db.select().from(schema.userDiffs).where(and(eq(schema.userDiffs.id, req.params.id), eq(schema.userDiffs.userId, req.user.sub)));
    if (!d) return reply.code(404).send({ success: false, error: 'not_found' });
    const content = req.body.content ?? d.draft ?? '';
    const [agg] = await app.db.select({ max: sql<number>`coalesce(max(${schema.userDiffVersions.version}), 0)` }).from(schema.userDiffVersions).where(eq(schema.userDiffVersions.diffId, d.id));
    const [v] = await app.db.insert(schema.userDiffVersions).values({ diffId: d.id, version: Number(agg?.max ?? 0) + 1, content }).returning();
    await app.db.update(schema.userDiffs).set({ currentVersionId: v!.id, draft: content, updatedAt: new Date() }).where(eq(schema.userDiffs.id, d.id));
    return { success: true, version: v };
  });

  app.get('/diffs/:id/versions', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => ({
    success: true,
    versions: await app.db
      .select()
      .from(schema.userDiffVersions)
      .innerJoin(schema.userDiffs, and(eq(schema.userDiffs.id, schema.userDiffVersions.diffId), eq(schema.userDiffs.userId, req.user.sub)))
      .where(eq(schema.userDiffVersions.diffId, req.params.id))
      .orderBy(desc(schema.userDiffVersions.version))
  }));

  /** Rollback = point current to an older version. */
  app.post('/diffs/:id/rollback/:versionId', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid(), versionId: z.string().uuid() }) } }, async (req, reply) => {
    const [v] = await app.db.select().from(schema.userDiffVersions).where(and(eq(schema.userDiffVersions.id, req.params.versionId), eq(schema.userDiffVersions.diffId, req.params.id)));
    if (!v) return reply.code(404).send({ success: false, error: 'not_found' });
    await app.db.update(schema.userDiffs).set({ currentVersionId: v.id, draft: v.content, updatedAt: new Date() }).where(and(eq(schema.userDiffs.id, req.params.id), eq(schema.userDiffs.userId, req.user.sub)));
    return { success: true };
  });

  /** DiffSwitcher: one active diff per user. */
  app.post('/diffs/:id/activate', { preHandler: app.requireRole(['operator', 'technician']), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await app.db.transaction(async (tx) => {
      await tx.update(schema.userDiffs).set({ isActive: false }).where(eq(schema.userDiffs.userId, req.user.sub));
      await tx.update(schema.userDiffs).set({ isActive: true }).where(and(eq(schema.userDiffs.id, req.params.id), eq(schema.userDiffs.userId, req.user.sub)));
    });
    await app.publish({ channel: `user:${req.user.sub}:session`, type: 'diff.active', payload: { id: req.params.id, by: req.user.sid } });
    return { success: true };
  });

  app.delete('/diffs/:id', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await app.db.delete(schema.userDiffs).where(and(eq(schema.userDiffs.id, req.params.id), eq(schema.userDiffs.userId, req.user.sub)));
    return { success: true };
  });

  app.post('/diffs/:id/share', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ ttlDays: z.number().int().min(1).max(365).optional() }) } }, async (req, reply) => {
    const [d] = await app.db.select({ id: schema.userDiffs.id }).from(schema.userDiffs).where(and(eq(schema.userDiffs.id, req.params.id), eq(schema.userDiffs.userId, req.user.sub)));
    if (!d) return reply.code(404).send({ success: false, error: 'not_found' });
    const [link] = await app.db
      .insert(schema.diffShareLinks)
      .values({ diffId: d.id, token: randomToken(16), expiresAt: req.body.ttlDays ? new Date(Date.now() + req.body.ttlDays * 86400_000) : null })
      .returning();
    await app.db.insert(schema.diffUsageLog).values({ userId: req.user.sub, diffId: d.id, action: 'shared' });
    return { success: true, token: link!.token };
  });

  app.get('/diff/shared/:token', { schema: { params: z.object({ token: z.string() }) } }, async (req, reply) => {
    const [row] = await app.db
      .select({ l: schema.diffShareLinks, d: schema.userDiffs, v: schema.userDiffVersions })
      .from(schema.diffShareLinks)
      .innerJoin(schema.userDiffs, eq(schema.userDiffs.id, schema.diffShareLinks.diffId))
      .leftJoin(schema.userDiffVersions, eq(schema.userDiffVersions.id, schema.userDiffs.currentVersionId))
      .where(eq(schema.diffShareLinks.token, req.params.token));
    if (!row || (row.l.expiresAt && row.l.expiresAt < new Date())) return reply.code(404).send({ success: false, error: 'not_found' });
    return { success: true, diff: { name: row.d.name, boardModelId: row.d.boardModelId, content: row.v?.content ?? row.d.draft ?? '' } };
  });

  app.post('/diffs/usage', { preHandler: app.authenticate, schema: { body: z.object({ diffId: z.string().uuid().optional(), templateId: z.string().uuid().optional(), action: z.enum(['applied', 'exported', 'imported', 'shared']) }) } }, async (req) => {
    await app.db.insert(schema.diffUsageLog).values({ userId: req.user.sub, ...req.body });
    return { success: true };
  });

  // ---- AutoFlash presets & runs ----
  app.get('/flash-presets', { preHandler: app.authenticate }, async (req) => ({ success: true, presets: await app.db.select().from(schema.flashPresets).where(eq(schema.flashPresets.userId, req.user.sub)) }));

  const presetBody = z.object({
    name: z.string().max(128),
    allowedTargets: z.array(z.string().max(64)).max(32),
    inavVersion: z.string().max(32).default('latest'),
    firmwareId: z.string().uuid().nullable().optional(),
    diffId: z.string().uuid().nullable().optional(),
    osdProfile: z.record(z.unknown()).nullable().optional(),
    vtxProfileId: z.string().uuid().nullable().optional(),
    armingConfig: z.record(z.unknown()).nullable().optional(),
    options: z.object({ skipIfSame: z.boolean(), applyDiff: z.boolean(), applyOsd: z.boolean(), applyVtx: z.boolean(), autoEepromWrite: z.boolean(), syncTransmitter: z.boolean() }).optional()
  });
  app.post('/flash-presets', { preHandler: app.requireRole(['operator', 'technician']), schema: { body: presetBody } }, async (req, reply) => {
    const [p] = await app.db.insert(schema.flashPresets).values({ userId: req.user.sub, ...req.body }).returning();
    return reply.code(201).send({ success: true, preset: p });
  });
  app.put('/flash-presets/:id', { preHandler: app.requireRole(['operator', 'technician']), schema: { params: z.object({ id: z.string().uuid() }), body: presetBody.partial() } }, async (req) => {
    await app.db.update(schema.flashPresets).set({ ...req.body, updatedAt: new Date() }).where(and(eq(schema.flashPresets.id, req.params.id), eq(schema.flashPresets.userId, req.user.sub)));
    return { success: true };
  });
  app.delete('/flash-presets/:id', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await app.db.delete(schema.flashPresets).where(and(eq(schema.flashPresets.id, req.params.id), eq(schema.flashPresets.userId, req.user.sub)));
    return { success: true };
  });

  app.post('/autoflash/runs', { preHandler: app.requireRole(['technician', 'operator']), schema: { body: z.object({ presetId: z.string().uuid().optional(), boardUid: z.string().max(64).optional(), fcTarget: z.string().max(64).optional(), fromVersion: z.string().max(32).optional() }) } }, async (req, reply) => {
    const [r] = await app.db.insert(schema.autoflashRuns).values({ userId: req.user.sub, ...req.body }).returning();
    return reply.code(201).send({ success: true, run: r });
  });
  app.post('/autoflash/runs/:id/log', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ entries: z.array(z.object({ level: z.enum(['info', 'warn', 'error']).default('info'), step: z.string().max(32).optional(), message: z.string().max(2000) })).max(200) }) } }, async (req) => {
    if (req.body.entries.length) await app.db.insert(schema.autoflashLogEntries).values(req.body.entries.map((e) => ({ runId: req.params.id, ...e })));
    return { success: true };
  });
  app.patch('/autoflash/runs/:id', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ status: z.enum(['running', 'ok', 'failed', 'skipped']), toVersion: z.string().max(32).optional() }) } }, async (req) => {
    await app.db.update(schema.autoflashRuns).set({ ...req.body, finishedAt: req.body.status === 'running' ? null : new Date() }).where(and(eq(schema.autoflashRuns.id, req.params.id), eq(schema.autoflashRuns.userId, req.user.sub)));
    if (req.body.status !== 'running') await app.usage(req.user.sub, 'autoflash.finish', { status: req.body.status });
    return { success: true };
  });
  app.get('/autoflash/runs', { preHandler: app.authenticate, schema: { querystring: z.object({ format: z.enum(['json', 'csv']).default('json') }) } }, async (req, reply) => {
    const runs = await app.db.select().from(schema.autoflashRuns).where(eq(schema.autoflashRuns.userId, req.user.sub)).orderBy(desc(schema.autoflashRuns.startedAt)).limit(500);
    if (req.query.format === 'csv') {
      const head = 'id,started_at,finished_at,status,fc_target,board_uid,from_version,to_version';
      const rows = runs.map((r) => [r.id, r.startedAt.toISOString(), r.finishedAt?.toISOString() ?? '', r.status, r.fcTarget ?? '', r.boardUid ?? '', r.fromVersion ?? '', r.toVersion ?? ''].join(','));
      return reply.header('Content-Type', 'text/csv').header('Content-Disposition', 'attachment; filename="autoflash-log.csv"').send([head, ...rows].join('\n'));
    }
    return { success: true, runs };
  });
  app.get('/autoflash/runs/:id/log', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => ({
    success: true,
    entries: await app.db.select().from(schema.autoflashLogEntries).where(eq(schema.autoflashLogEntries.runId, req.params.id)).orderBy(schema.autoflashLogEntries.id)
  }));
};
