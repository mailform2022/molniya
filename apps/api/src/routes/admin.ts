import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { CODE_TYPES, generateCode, toEncoderForm } from '../lib/codes.js';
import { decryptSecret, encryptSecret, hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { analyzeDiff, vtxTableDiff } from '../lib/diff.js';
import { env } from '../lib/env.js';
import type { JwtUser } from '../plugins/auth.js';

const uuid = z.object({ id: z.string().uuid() });

/** Admin auth lives on a custom login path (env ADMIN_LOGIN_PATH) and requires TOTP. */
export const adminAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(env.ADMIN_LOGIN_PATH, { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }, schema: { body: z.object({ email: z.string().email(), password: z.string(), totp: z.string().min(6).max(16).optional() }) } }, async (req, reply) => {
    const [user] = await app.db.select().from(schema.users).where(and(eq(schema.users.email, req.body.email.toLowerCase()), eq(schema.users.role, 'admin')));
    if (!user || !verifyPassword(req.body.password, user.passwordHash)) {
      await app.audit(req, 'admin.login_failed', req.body.email);
      return reply.code(401).send({ success: false, error: 'invalid_credentials' });
    }
    if (user.totpEnabled) {
      if (!req.body.totp) return reply.code(401).send({ success: false, error: 'totp_required' });
      const secret = decryptSecret(user.totpSecretEnc!);
      let ok = authenticator.check(req.body.totp, secret);
      if (!ok && req.body.totp.length >= 8) {
        // offline backup code (single use)
        const h = sha256(req.body.totp.toUpperCase());
        const codes = user.backupCodesHash ?? [];
        if (codes.includes(h)) {
          ok = true;
          await app.db.update(schema.users).set({ backupCodesHash: codes.filter((c) => c !== h) }).where(eq(schema.users.id, user.id));
        }
      }
      if (!ok) {
        await app.audit(req, 'admin.totp_failed', user.id);
        return reply.code(401).send({ success: false, error: 'invalid_totp' });
      }
    }
    const payload: JwtUser = { sub: user.id, email: user.email, role: 'admin', sessionRole: 'operator', sid: randomToken(8), adminOk: user.totpEnabled };
    await app.audit(req, 'admin.login', user.id, { totp: user.totpEnabled });
    return { success: true, token: app.jwt.sign(payload, { expiresIn: '4h' }), totpEnabled: user.totpEnabled, needsTotpSetup: !user.totpEnabled };
  });

  /** First-time 2FA enrolment: allowed with a password-only admin token when TOTP is not yet enabled. */
  app.post('/admin/2fa/setup', { preHandler: app.authenticate }, async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ success: false, error: 'forbidden' });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, req.user.sub));
    if (user!.totpEnabled && !req.user.adminOk) return reply.code(403).send({ success: false, error: 'admin_2fa_required' });
    const secret = authenticator.generateSecret();
    await app.db.update(schema.users).set({ totpSecretEnc: encryptSecret(secret) }).where(eq(schema.users.id, user!.id));
    return { success: true, secret, otpauth: authenticator.keyuri(user!.email, 'VTX Services Admin', secret) };
  });

  app.post('/admin/2fa/confirm', { preHandler: app.authenticate, schema: { body: z.object({ totp: z.string().length(6) }) } }, async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ success: false, error: 'forbidden' });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, req.user.sub));
    if (!user?.totpSecretEnc || !authenticator.check(req.body.totp, decryptSecret(user.totpSecretEnc))) return reply.code(400).send({ success: false, error: 'invalid_totp' });
    const backup = Array.from({ length: 8 }, () => randomToken(4).toUpperCase());
    await app.db.update(schema.users).set({ totpEnabled: true, backupCodesHash: backup.map(sha256) }).where(eq(schema.users.id, user.id));
    await app.audit(req, 'admin.2fa_enabled', user.id);
    const payload: JwtUser = { ...req.user, adminOk: true };
    return { success: true, backupCodes: backup, token: app.jwt.sign(payload, { expiresIn: '4h' }) };
  });
};

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  // ---- /admin/stats ----
  app.get('/stats', async () => {
    const since30 = sql`now() - interval '30 days'`;
    const [users] = await app.db.select({ n: count() }).from(schema.users);
    const [mau] = await app.db.select({ n: sql<number>`count(distinct ${schema.usageLogs.userId})` }).from(schema.usageLogs).where(gte(schema.usageLogs.createdAt, since30));
    const [subs] = await app.db.select({ n: count() }).from(schema.subscriptions).where(and(eq(schema.subscriptions.status, 'active'), gte(schema.subscriptions.expiresAt, new Date())));
    const flashesPerDay = await app.db
      .select({ day: sql<string>`date_trunc('day', ${schema.autoflashRuns.startedAt})::date`, n: count() })
      .from(schema.autoflashRuns)
      .where(gte(schema.autoflashRuns.startedAt, since30))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const [pendingVtx] = await app.db.select({ n: count() }).from(schema.vtxSubmissions).where(eq(schema.vtxSubmissions.status, 'pending_review'));
    const [openReports] = await app.db.select({ n: count() }).from(schema.vtxReports).where(eq(schema.vtxReports.status, 'open'));
    return { success: true, users: users!.n, mau: Number(mau!.n), activeSubscriptions: subs!.n, flashesPerDay, pendingVtxSubmissions: pendingVtx!.n, openReports: openReports!.n };
  });

  // ---- /admin/users ----
  app.get('/users', { schema: { querystring: z.object({ q: z.string().optional(), limit: z.coerce.number().default(50), offset: z.coerce.number().default(0) }) } }, async (req) => {
    const rows = await app.db
      .select({ id: schema.users.id, email: schema.users.email, role: schema.users.role, fingerprint: schema.users.fingerprint, registeredIp: schema.users.registeredIp, isBlocked: schema.users.isBlocked, emailVerified: schema.users.emailVerified, createdAt: schema.users.createdAt })
      .from(schema.users)
      .where(req.query.q ? sql`${schema.users.email} ilike ${'%' + req.query.q + '%'} or ${schema.users.fingerprint} = ${req.query.q}` : undefined)
      .orderBy(desc(schema.users.createdAt))
      .limit(req.query.limit)
      .offset(req.query.offset);
    return { success: true, users: rows };
  });
  app.get('/users/:id', { schema: { params: uuid } }, async (req) => {
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, req.params.id));
    const subs = await app.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, req.params.id)).orderBy(desc(schema.subscriptions.createdAt));
    const devs = await app.db.select().from(schema.devices).where(eq(schema.devices.userId, req.params.id));
    const audit = await app.db.select().from(schema.auditLog).where(eq(schema.auditLog.actorId, req.params.id)).orderBy(desc(schema.auditLog.id)).limit(100);
    return { success: true, user: user && { ...user, passwordHash: undefined, totpSecretEnc: undefined, backupCodesHash: undefined }, subscriptions: subs, devices: devs, audit };
  });
  app.patch('/users/:id', { schema: { params: uuid, body: z.object({ isBlocked: z.boolean().optional(), role: z.enum(['user', 'admin']).optional(), fingerprint: z.string().nullable().optional() }) } }, async (req) => {
    await app.db.update(schema.users).set(req.body).where(eq(schema.users.id, req.params.id));
    await app.audit(req, 'admin.user_update', req.params.id, req.body);
    return { success: true };
  });
  app.post('/users/:id/subscription', { schema: { params: uuid, body: z.object({ planCode: z.string(), days: z.number().int().min(1).max(3650), deviceLimit: z.number().int().min(1).max(100) }) } }, async (req, reply) => {
    const [plan] = await app.db.select().from(schema.plans).where(eq(schema.plans.code, req.body.planCode));
    if (!plan) return reply.code(404).send({ success: false, error: 'plan_not_found' });
    await app.db.insert(schema.subscriptions).values({ userId: req.params.id, planId: plan.id, source: 'manual', expiresAt: new Date(Date.now() + req.body.days * 86400_000), deviceLimit: req.body.deviceLimit });
    await app.audit(req, 'admin.grant_subscription', req.params.id, req.body);
    await app.publish({ channel: `user:${req.params.id}:session`, type: 'access.updated', payload: {} });
    return { success: true };
  });

  // ---- /admin/plans ----
  const planBody = z.object({ code: z.string().max(32), name: z.string().max(64), durationDays: z.number().int(), deviceLimit: z.number().int(), priceRub: z.number().int(), features: z.record(z.union([z.boolean(), z.number(), z.string()])), isActive: z.boolean().default(true) });
  app.get('/plans', async () => ({ success: true, plans: await app.db.select().from(schema.plans), addons: await app.db.select().from(schema.planAddons) }));
  app.post('/plans', { schema: { body: planBody } }, async (req, reply) => {
    const [p] = await app.db.insert(schema.plans).values(req.body).returning();
    await app.publish({ channel: 'plans', type: 'plans.updated', payload: {} });
    return reply.code(201).send({ success: true, plan: p });
  });
  app.put('/plans/:id', { schema: { params: uuid, body: planBody.partial().extend({ applyToExisting: z.boolean().default(false) }) } }, async (req) => {
    const { applyToExisting, ...data } = req.body;
    await app.db.update(schema.plans).set({ ...data, updatedAt: new Date() }).where(eq(schema.plans.id, req.params.id));
    if (applyToExisting && data.deviceLimit !== undefined) {
      await app.db.update(schema.subscriptions).set({ deviceLimit: data.deviceLimit }).where(and(eq(schema.subscriptions.planId, req.params.id), eq(schema.subscriptions.status, 'active')));
    }
    await app.audit(req, 'admin.plan_update', req.params.id, req.body);
    await app.publish({ channel: 'plans', type: 'plans.updated', payload: { applyToExisting } });
    return { success: true };
  });
  const addonBody = z.object({ code: z.string().max(32), name: z.string().max(64), kind: z.enum(['extra_device', 'extra_time']), amount: z.number().int().min(1), priceRub: z.number().int().min(0), isActive: z.boolean().default(true) });
  app.post('/addons', { schema: { body: addonBody } }, async (req, reply) => reply.code(201).send({ success: true, addon: (await app.db.insert(schema.planAddons).values(req.body).returning())[0] }));
  app.put('/addons/:id', { schema: { params: uuid, body: addonBody.partial() } }, async (req) => {
    await app.db.update(schema.planAddons).set(req.body).where(eq(schema.planAddons.id, req.params.id));
    return { success: true };
  });

  // ---- /admin/codes (CodeGenerator) ----
  app.get('/codes', { schema: { querystring: z.object({ limit: z.coerce.number().default(100) }) } }, async (req) => {
    const codes = await app.db.select().from(schema.activationCodes).orderBy(desc(schema.activationCodes.createdAt)).limit(req.query.limit);
    const [stats] = await app.db.select({ total: count(), redeemed: sql<number>`sum(${schema.activationCodes.redemptions})` }).from(schema.activationCodes);
    return { success: true, codes, stats };
  });
  app.post(
    '/codes',
    { schema: { body: z.object({ type: z.enum(CODE_TYPES), planCode: z.string().max(32), durationDays: z.number().int().min(1).max(3650), deviceLimit: z.number().int().min(1).max(99), count: z.number().int().min(1).max(200).default(1), maxRedemptions: z.number().int().min(1).default(1), note: z.string().max(255).optional(), expiresInDays: z.number().int().optional() }) } },
    async (req, reply) => {
      const [plan] = await app.db.select().from(schema.plans).where(eq(schema.plans.code, req.body.planCode.toUpperCase()));
      if (!plan) return reply.code(404).send({ success: false, error: 'plan_not_found' });
      const generated = Array.from({ length: req.body.count }, () => generateCode(req.body.type, plan.code, req.body.durationDays, req.body.deviceLimit));
      await app.db.insert(schema.activationCodes).values(
        generated.map((g) => ({
          code: g.code,
          type: g.type,
          planCode: plan.code,
          durationDays: g.durationDays,
          deviceLimit: g.devices,
          maxRedemptions: req.body.maxRedemptions,
          createdBy: req.user.sub,
          note: req.body.note,
          expiresAt: req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86400_000) : null
        }))
      );
      await app.audit(req, 'admin.codes_generate', plan.code, { count: req.body.count, type: req.body.type });
      return reply.code(201).send({ success: true, codes: generated.map((g) => ({ code: g.code, encoderForm: toEncoderForm(g) })) });
    }
  );
  app.post('/codes/:id/revoke', { schema: { params: uuid } }, async (req) => {
    await app.db.update(schema.activationCodes).set({ isRevoked: true }).where(eq(schema.activationCodes.id, req.params.id));
    await app.audit(req, 'admin.code_revoke', req.params.id);
    return { success: true };
  });

  // ---- /admin/models ----
  const boardBody = z.object({ code: z.string().max(64), name: z.string().max(128), fcTarget: z.string().max(64), totalPins: z.number().int().min(1).max(64), description: z.string().optional(), defaultDiffTemplateId: z.string().uuid().nullable().optional(), isActive: z.boolean().default(true), meta: z.record(z.unknown()).optional() });
  const txBody = z.object({ code: z.string().max(64), name: z.string().max(128), platform: z.string().max(32), firmwareTarget: z.string().max(64).optional(), display: z.string().max(64).optional(), channels: z.number().int().default(16), isActive: z.boolean().default(true), meta: z.record(z.unknown()).optional() });
  app.get('/models', async () => ({ success: true, boards: await app.db.select().from(schema.boardModels), transmitters: await app.db.select().from(schema.transmitterModels), layouts: await app.db.select().from(schema.boardPinLayouts) }));
  app.post('/models/boards', { schema: { body: boardBody } }, async (req, reply) => reply.code(201).send({ success: true, model: (await app.db.insert(schema.boardModels).values(req.body).returning())[0] }));
  app.put('/models/boards/:id', { schema: { params: uuid, body: boardBody.partial() } }, async (req) => {
    await app.db.update(schema.boardModels).set(req.body).where(eq(schema.boardModels.id, req.params.id));
    return { success: true };
  });
  app.post('/models/transmitters', { schema: { body: txBody } }, async (req, reply) => reply.code(201).send({ success: true, model: (await app.db.insert(schema.transmitterModels).values(req.body).returning())[0] }));
  app.put('/models/transmitters/:id', { schema: { params: uuid, body: txBody.partial() } }, async (req) => {
    await app.db.update(schema.transmitterModels).set(req.body).where(eq(schema.transmitterModels.id, req.params.id));
    return { success: true };
  });

  // ---- /admin/board-layouts ----
  const layoutBody = z.object({ boardModelId: z.string().uuid().nullable().optional(), fcTarget: z.string().max(64), imagePath: z.string().optional(), totalPins: z.number().int().min(1).max(64), pins: z.array(z.object({ pin: z.string(), x: z.number(), y: z.number(), role: z.string(), rcChannel: z.number().int().optional(), range: z.tuple([z.number(), z.number()]).optional(), signal: z.enum(['pwm', 'digital', 'servo']).optional() })), status: z.enum(['draft', 'published']).default('draft') });
  app.post('/board-layouts', { schema: { body: layoutBody } }, async (req, reply) => reply.code(201).send({ success: true, layout: (await app.db.insert(schema.boardPinLayouts).values(req.body).returning())[0] }));
  app.put('/board-layouts/:id', { schema: { params: uuid, body: layoutBody.partial() } }, async (req) => {
    await app.db.update(schema.boardPinLayouts).set({ ...req.body, updatedAt: new Date() }).where(eq(schema.boardPinLayouts.id, req.params.id));
    return { success: true };
  });

  // ---- /admin/firmware ----
  app.get('/firmware', async () => ({ success: true, firmware: await app.db.select().from(schema.firmwareVersions).orderBy(desc(schema.firmwareVersions.createdAt)) }));
  app.post('/firmware', async (req, reply) => {
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let file: { name: string; buf: Buffer } | null = null;
    for await (const part of parts) {
      if (part.type === 'file') file = { name: part.filename, buf: await part.toBuffer() };
      else fields[part.fieldname] = String(part.value);
    }
    const meta = z.object({ kind: z.enum(['fc', 'transmitter', 'configurator']), target: z.string().max(64), version: z.string().max(32), changelog: z.string().optional(), isPublished: z.coerce.boolean().default(false), modelIds: z.string().optional() }).safeParse(fields);
    if (!meta.success || !file) return reply.code(400).send({ success: false, error: 'bad_request', issues: meta.success ? ['file required'] : meta.error.issues });
    const dir = path.join(env.FIRMWARE_DIR, meta.data.kind, meta.data.target);
    await mkdir(dir, { recursive: true });
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    const filePath = path.join(dir, `${meta.data.version}-${safeName}`);
    await writeFile(filePath, file.buf);
    const [fw] = await app.db
      .insert(schema.firmwareVersions)
      .values({ ...meta.data, fileName: safeName, filePath, sha256: createHash('sha256').update(file.buf).digest('hex'), sizeBytes: file.buf.length, modelIds: meta.data.modelIds ? meta.data.modelIds.split(',') : [], createdBy: req.user.sub })
      .returning();
    await app.audit(req, 'admin.firmware_upload', fw!.id, { target: fw!.target, version: fw!.version });
    return reply.code(201).send({ success: true, firmware: fw });
  });
  /**
   * Release gate: isPublished=true requires verification=flight_tested and at least one crash report with
   * userVerdict=ok when the build fixes a crash. `withdrawn` unpublishes immediately.
   */
  app.patch(
    '/firmware/:id',
    { schema: { params: uuid, body: z.object({ isPublished: z.boolean().optional(), changelog: z.string().optional(), modelIds: z.array(z.string()).optional(), verification: z.enum(['experimental', 'diagnostic', 'flight_tested', 'withdrawn']).optional(), section: z.string().max(64).nullable().optional(), fixesCrashReportId: z.string().uuid().nullable().optional(), withdrawnReason: z.string().max(2000).optional() }) } },
    async (req, reply) => {
      const [fw] = await app.db.select().from(schema.firmwareVersions).where(eq(schema.firmwareVersions.id, req.params.id));
      if (!fw) return reply.code(404).send({ success: false, error: 'not_found' });
      const next = { ...fw, ...req.body };
      if (next.verification === 'withdrawn') {
        if (!req.body.withdrawnReason && !fw.withdrawnReason) return reply.code(400).send({ success: false, error: 'withdrawn_reason_required' });
        next.isPublished = false;
      }
      if (next.verification === 'flight_tested' && fw.verification !== 'flight_tested') {
        const [ok] = await app.db.select({ n: count() }).from(schema.firmwareFeedback).where(and(eq(schema.firmwareFeedback.firmwareId, fw.id), eq(schema.firmwareFeedback.outcome, 'flew_ok')));
        const [crashOk] = next.fixesCrashReportId ? await app.db.select({ v: schema.crashReports.userVerdict }).from(schema.crashReports).where(eq(schema.crashReports.id, next.fixesCrashReportId)) : [];
        if ((ok?.n ?? 0) === 0 && crashOk?.v !== 'ok') return reply.code(409).send({ success: false, error: 'no_flight_evidence', hint: 'Ни одного отзыва «отлетал нормально» по этой сборке и нет подтверждённого исправления крэша. Нельзя пометить как проверенную в полёте.' });
      }
      if (next.isPublished && !fw.isPublished) {
        if (next.verification !== 'flight_tested') return reply.code(409).send({ success: false, error: 'not_flight_tested', hint: 'Публикация разрешена только для verification=flight_tested.' });
        if (next.fixesCrashReportId) {
          const [cr] = await app.db.select({ v: schema.crashReports.userVerdict }).from(schema.crashReports).where(eq(schema.crashReports.id, next.fixesCrashReportId));
          if (cr?.v !== 'ok') return reply.code(409).send({ success: false, error: 'crash_fix_not_confirmed', hint: 'Пользователь ещё не подтвердил успешный полёт на исправлении.' });
        }
      }
      const { isPublished, changelog, modelIds, verification, section, fixesCrashReportId, withdrawnReason } = next;
      await app.db.update(schema.firmwareVersions).set({ isPublished, changelog, modelIds, verification, section, fixesCrashReportId, withdrawnReason }).where(eq(schema.firmwareVersions.id, req.params.id));
      await app.audit(req, 'admin.firmware_update', req.params.id, { verification: next.verification, isPublished: next.isPublished });
      if (next.isPublished && !fw.isPublished) await app.publish({ channel: 'firmware', type: 'firmware.published', payload: { id: req.params.id } });
      if (next.verification === 'withdrawn' && fw.verification !== 'withdrawn') await app.publish({ channel: 'firmware', type: 'firmware.withdrawn', payload: { id: req.params.id, reason: next.withdrawnReason } });
      return { success: true };
    }
  );

  // ---- /admin/firmware/:id/feedback + /admin/build-sets: flight evidence behind every published build ----
  app.get('/firmware/:id/feedback', { schema: { params: uuid } }, async (req) => ({
    success: true,
    feedback: await app.db
      .select({ f: schema.firmwareFeedback, email: schema.users.email })
      .from(schema.firmwareFeedback)
      .innerJoin(schema.users, eq(schema.users.id, schema.firmwareFeedback.userId))
      .where(eq(schema.firmwareFeedback.firmwareId, req.params.id))
      .orderBy(desc(schema.firmwareFeedback.createdAt))
  }));
  app.patch('/firmware-feedback/:id', { schema: { params: uuid, body: z.object({ adminNote: z.string().max(2000).nullable() }) } }, async (req, reply) => {
    const [row] = await app.db.update(schema.firmwareFeedback).set({ adminNote: req.body.adminNote }).where(eq(schema.firmwareFeedback.id, req.params.id)).returning({ id: schema.firmwareFeedback.id });
    if (!row) return reply.code(404).send({ success: false, error: 'not_found' });
    await app.audit(req, 'admin.firmware_feedback_note', row.id);
    return { success: true };
  });
  app.get('/build-sets', { schema: { querystring: z.object({ uid: z.string().max(64).optional(), userId: z.string().uuid().optional(), status: z.string().max(16).optional() }) } }, async (req) => {
    const conds = [] as ReturnType<typeof eq>[];
    if (req.query.uid) conds.push(eq(schema.buildSets.uid, req.query.uid.toLowerCase()));
    if (req.query.userId) conds.push(eq(schema.buildSets.userId, req.query.userId));
    if (req.query.status) conds.push(eq(schema.buildSets.status, req.query.status));
    const rows = await app.db
      .select({ id: schema.buildSets.id, userId: schema.buildSets.userId, email: schema.users.email, uid: schema.buildSets.uid, fcTarget: schema.buildSets.fcTarget, trust: schema.buildSets.trust, snapshotId: schema.buildSets.snapshotId, fcFirmwareId: schema.buildSets.fcFirmwareId, txFirmwareId: schema.buildSets.txFirmwareId, txModelCode: schema.buildSets.txModelCode, freqSource: schema.buildSets.freqSource, vtxModelName: schema.buildSets.vtxModelName, pairs: schema.buildSets.pairs, hashes: schema.buildSets.hashes, fcApplied: schema.buildSets.fcApplied, vtxMapWritten: schema.buildSets.vtxMapWritten, txApplied: schema.buildSets.txApplied, status: schema.buildSets.status, crashReportId: schema.buildSets.crashReportId, name: schema.buildSets.name, createdAt: schema.buildSets.createdAt })
      .from(schema.buildSets)
      .innerJoin(schema.users, eq(schema.users.id, schema.buildSets.userId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.buildSets.createdAt))
      .limit(200);
    return { success: true, buildSets: rows };
  });
  app.get('/build-sets/:id', { schema: { params: uuid } }, async (req, reply) => {
    const [row] = await app.db.select().from(schema.buildSets).where(eq(schema.buildSets.id, req.params.id));
    if (!row) return reply.code(404).send({ success: false, error: 'not_found' });
    return { success: true, buildSet: row };
  });

  // ---- /admin/verified-targets: which FC target + INAV version are flight-verified ----
  const vtBody = z.object({ fcTarget: z.string().max(64), inavVersion: z.string().max(32), boardModelId: z.string().uuid().nullable().optional(), status: z.enum(['verified', 'experimental', 'banned']).default('verified'), evidence: z.string().max(2000).optional() });
  app.get('/verified-targets', async () => ({ success: true, targets: await app.db.select().from(schema.verifiedTargets) }));
  app.post('/verified-targets', { schema: { body: vtBody } }, async (req, reply) => {
    const [t] = await app.db.insert(schema.verifiedTargets).values({ ...req.body, fcTarget: req.body.fcTarget.toUpperCase(), createdBy: req.user.sub }).onConflictDoUpdate({ target: [schema.verifiedTargets.fcTarget, schema.verifiedTargets.inavVersion], set: { status: req.body.status, evidence: req.body.evidence, boardModelId: req.body.boardModelId } }).returning();
    await app.audit(req, 'admin.verified_target', t!.id, { fcTarget: t!.fcTarget, inavVersion: t!.inavVersion, status: t!.status });
    return reply.code(201).send({ success: true, target: t });
  });
  app.delete('/verified-targets/:id', { schema: { params: uuid } }, async (req) => {
    await app.db.delete(schema.verifiedTargets).where(eq(schema.verifiedTargets.id, req.params.id));
    return { success: true };
  });

  // ---- /admin/crash-reports: review analysis, propose a fix (firmware and/or diff) ----
  app.get('/crash-reports', async () => ({ success: true, reports: await app.db.select().from(schema.crashReports).orderBy(desc(schema.crashReports.createdAt)) }));
  app.get('/crash-reports/:id', { schema: { params: uuid } }, async (req, reply) => {
    const [r] = await app.db.select().from(schema.crashReports).where(eq(schema.crashReports.id, req.params.id));
    if (!r) return reply.code(404).send({ success: false, error: 'not_found' });
    const snapshot = r.snapshotId ? (await app.db.select().from(schema.boardSnapshots).where(eq(schema.boardSnapshots.id, r.snapshotId)))[0] : null;
    const build = r.diagnosticBuildId ? (await app.db.select().from(schema.diagnosticBuilds).where(eq(schema.diagnosticBuilds.id, r.diagnosticBuildId)))[0] : null;
    return { success: true, report: r, snapshot, build };
  });
  app.post('/crash-reports/:id/fix', { schema: { params: uuid, body: z.object({ fixFirmwareId: z.string().uuid().nullable().optional(), fixDiffContent: z.string().max(256 * 1024).nullable().optional(), adminNote: z.string().max(4000).optional() }) } }, async (req, reply) => {
    if (!req.body.fixFirmwareId && !req.body.fixDiffContent) return reply.code(400).send({ success: false, error: 'fix_required' });
    if (req.body.fixDiffContent) {
      const a = analyzeDiff(req.body.fixDiffContent);
      if (a.unknown.length) return reply.code(400).send({ success: false, error: 'diff_unknown_commands', unknown: a.unknown });
    }
    await app.db.update(schema.crashReports).set({ ...req.body, status: 'fix_proposed', userVerdict: null, updatedAt: new Date() }).where(eq(schema.crashReports.id, req.params.id));
    await app.audit(req, 'admin.crash_fix', req.params.id, { firmware: req.body.fixFirmwareId ?? null });
    return { success: true };
  });
  app.patch('/crash-reports/:id', { schema: { params: uuid, body: z.object({ status: z.enum(['analyzed', 'fix_proposed', 'fixed', 'closed']).optional(), adminNote: z.string().max(4000).optional() }) } }, async (req) => {
    await app.db.update(schema.crashReports).set({ ...req.body, updatedAt: new Date() }).where(eq(schema.crashReports.id, req.params.id));
    return { success: true };
  });
  app.get('/snapshots', async () => ({ success: true, snapshots: (await app.db.select().from(schema.boardSnapshots).orderBy(desc(schema.boardSnapshots.createdAt)).limit(200)).map(({ diffAll, statusText, ...s }) => ({ ...s, hasDiff: Boolean(diffAll), hasStatus: Boolean(statusText) })) }));

  // ---- /admin/vtx-models, /admin/vtx-photos, ranges ----
  const vtxBody = z.object({ name: z.string().max(128), manufacturer: z.string().max(128).optional(), rangeId: z.string().uuid().nullable().optional(), protocol: z.string().max(32).default('smartaudio'), bands: z.number().int(), channels: z.number().int(), freqTable: z.array(z.array(z.number().int())), powerLevels: z.array(z.number()).optional(), isDisabled: z.boolean().optional(), flagged: z.boolean().optional() });
  app.get('/vtx-models', async () => ({ success: true, models: await app.db.select().from(schema.vtxModels) }));
  app.post('/vtx-models', { schema: { body: vtxBody } }, async (req, reply) => reply.code(201).send({ success: true, model: (await app.db.insert(schema.vtxModels).values(req.body).returning())[0] }));
  app.put('/vtx-models/:id', { schema: { params: uuid, body: vtxBody.partial() } }, async (req) => {
    await app.db.update(schema.vtxModels).set({ ...req.body, updatedAt: new Date() }).where(eq(schema.vtxModels.id, req.params.id));
    return { success: true };
  });
  app.post('/vtx-photos', { schema: { body: z.object({ vtxModelId: z.string().uuid(), fcTarget: z.string(), imagePath: z.string(), annotations: z.array(z.object({ x: z.number(), y: z.number(), label: z.string() })).default([]) }) } }, async (req, reply) => reply.code(201).send({ success: true, photo: (await app.db.insert(schema.vtxConnectionPhotos).values(req.body).returning())[0] }));
  // user-uploaded VTX identification photos: edit caption/annotations, hide, reorder, re-link to a model
  app.get('/vtx-model-photos', { schema: { querystring: z.object({ vtxModelId: z.string().uuid().optional(), submissionId: z.string().uuid().optional() }) } }, async (req) => {
    const where = req.query.vtxModelId ? eq(schema.vtxPhotos.vtxModelId, req.query.vtxModelId) : req.query.submissionId ? eq(schema.vtxPhotos.submissionId, req.query.submissionId) : undefined;
    return { success: true, photos: await app.db.select().from(schema.vtxPhotos).where(where).orderBy(schema.vtxPhotos.sortOrder, desc(schema.vtxPhotos.createdAt)).limit(500) };
  });
  app.patch('/vtx-model-photos/:id', { schema: { params: uuid, body: z.object({ caption: z.string().max(255).nullable().optional(), annotations: z.array(z.object({ x: z.number(), y: z.number(), label: z.string() })).optional(), isHidden: z.boolean().optional(), sortOrder: z.number().int().optional(), vtxModelId: z.string().uuid().nullable().optional() }) } }, async (req) => {
    await app.db.update(schema.vtxPhotos).set(req.body).where(eq(schema.vtxPhotos.id, req.params.id));
    return { success: true };
  });
  app.delete('/vtx-model-photos/:id', { schema: { params: uuid } }, async (req) => {
    await app.db.delete(schema.vtxPhotos).where(eq(schema.vtxPhotos.id, req.params.id));
    return { success: true };
  });
  app.put('/frequency-ranges/:id', { schema: { params: uuid, body: z.object({ status: z.enum(['active', 'in_dev', 'coming_soon']).optional(), isDefault: z.boolean().optional(), name: z.string().optional() }) } }, async (req) => {
    if (req.body.isDefault) await app.db.update(schema.frequencyRanges).set({ isDefault: false });
    await app.db.update(schema.frequencyRanges).set(req.body).where(eq(schema.frequencyRanges.id, req.params.id));
    return { success: true };
  });

  // ---- moderation: /admin/vtx-submissions, /admin/board-submissions, /admin/reports ----
  app.get('/vtx-submissions', async () => ({ success: true, submissions: await app.db.select().from(schema.vtxSubmissions).orderBy(desc(schema.vtxSubmissions.createdAt)) }));
  app.post('/vtx-submissions/:id/decision', { schema: { params: uuid, body: z.object({ action: z.enum(['approve', 'reject', 'request_info', 'merge']), note: z.string().optional(), mergeIntoVtxModelId: z.string().uuid().optional() }) } }, async (req, reply) => {
    const [s] = await app.db.select().from(schema.vtxSubmissions).where(eq(schema.vtxSubmissions.id, req.params.id));
    if (!s) return reply.code(404).send({ success: false, error: 'not_found' });
    let resultVtxModelId: string | null = s.resultVtxModelId;
    let generatedDiff: string | undefined;
    if (req.body.action === 'approve') {
      const [m] = await app.db
        .insert(schema.vtxModels)
        .values({ name: s.name, manufacturer: s.manufacturer, rangeId: s.rangeId, protocol: s.protocol ?? 'smartaudio', bands: s.freqTable.length, channels: Math.max(...s.freqTable.map((b) => b.length)), freqTable: s.freqTable, rawStatusSample: s.cliStatusHex, sourceSubmissionId: s.id })
        .returning();
      resultVtxModelId = m!.id;
      generatedDiff = vtxTableDiff(s.freqTable);
      const [t] = await app.db.insert(schema.diffTemplates).values({ name: `VTX ${s.name} — vtxtable`, isPublic: true, createdBy: req.user.sub }).returning();
      const [v] = await app.db.insert(schema.diffTemplateVersions).values({ templateId: t!.id, version: '1.0.0', content: generatedDiff, changelog: 'auto-generated from approved submission', parsed: analyzeDiff(generatedDiff) }).returning();
      await app.db.update(schema.diffTemplates).set({ currentVersionId: v!.id }).where(eq(schema.diffTemplates.id, t!.id));
      await app.publish({ channel: `user:${s.userId}:session`, type: 'vtx-submission.approved', payload: { id: s.id, vtxModelId: m!.id } });
    } else if (req.body.action === 'merge' && req.body.mergeIntoVtxModelId) {
      resultVtxModelId = req.body.mergeIntoVtxModelId;
    }
    const status = { approve: 'approved', reject: 'rejected', request_info: 'info_requested', merge: 'merged' }[req.body.action];
    await app.db.update(schema.vtxSubmissions).set({ status, moderatorNote: req.body.note, resultVtxModelId, updatedAt: new Date() }).where(eq(schema.vtxSubmissions.id, s.id));
    await app.audit(req, 'admin.vtx_submission', s.id, { action: req.body.action });
    return { success: true, status, resultVtxModelId, generatedDiff };
  });

  app.get('/board-submissions', async () => ({ success: true, submissions: await app.db.select().from(schema.boardSubmissions).orderBy(desc(schema.boardSubmissions.createdAt)) }));
  app.post('/board-submissions/:id/decision', { schema: { params: uuid, body: z.object({ action: z.enum(['approve', 'reject', 'request_info']), note: z.string().optional(), boardCode: z.string().optional() }) } }, async (req, reply) => {
    const [s] = await app.db.select().from(schema.boardSubmissions).where(eq(schema.boardSubmissions.id, req.params.id));
    if (!s) return reply.code(404).send({ success: false, error: 'not_found' });
    if (req.body.action === 'approve') {
      const [layout] = s.layoutId ? await app.db.select().from(schema.boardPinLayouts).where(eq(schema.boardPinLayouts.id, s.layoutId)) : [];
      const [m] = await app.db.insert(schema.boardModels).values({ code: req.body.boardCode ?? s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: s.name, fcTarget: s.fcTarget ?? 'UNKNOWN', totalPins: layout?.totalPins ?? 12 }).returning();
      if (layout) await app.db.update(schema.boardPinLayouts).set({ boardModelId: m!.id, status: 'published' }).where(eq(schema.boardPinLayouts.id, layout.id));
    }
    const status = { approve: 'approved', reject: 'rejected', request_info: 'info_requested' }[req.body.action];
    await app.db.update(schema.boardSubmissions).set({ status, moderatorNote: req.body.note }).where(eq(schema.boardSubmissions.id, s.id));
    return { success: true, status };
  });

  app.get('/reports', async () => ({ success: true, reports: await app.db.select().from(schema.vtxReports).orderBy(desc(schema.vtxReports.createdAt)) }));
  app.post('/reports/:id/action', { schema: { params: uuid, body: z.object({ action: z.enum(['fix', 'disable_vtx', 'disable_range', 'reply', 'close']), reply: z.string().optional() }) } }, async (req, reply) => {
    const [r] = await app.db.select().from(schema.vtxReports).where(eq(schema.vtxReports.id, req.params.id));
    if (!r) return reply.code(404).send({ success: false, error: 'not_found' });
    if (req.body.action === 'disable_vtx' && r.vtxModelId) await app.db.update(schema.vtxModels).set({ isDisabled: true }).where(eq(schema.vtxModels.id, r.vtxModelId));
    if (req.body.action === 'disable_range' && r.vtxModelId) {
      const [m] = await app.db.select({ rangeId: schema.vtxModels.rangeId }).from(schema.vtxModels).where(eq(schema.vtxModels.id, r.vtxModelId));
      if (m?.rangeId) await app.db.update(schema.frequencyRanges).set({ status: 'in_dev' }).where(eq(schema.frequencyRanges.id, m.rangeId));
    }
    const status = req.body.action === 'close' || req.body.action === 'fix' ? 'closed' : req.body.action === 'reply' ? 'answered' : 'in_progress';
    await app.db.update(schema.vtxReports).set({ status, adminReply: req.body.reply ?? r.adminReply }).where(eq(schema.vtxReports.id, r.id));
    await app.audit(req, 'admin.report_action', r.id, { action: req.body.action });
    return { success: true, status };
  });

  // ---- /admin/diff ----
  app.get('/diff', async () => ({ success: true, templates: await app.db.select().from(schema.diffTemplates), versions: await app.db.select().from(schema.diffTemplateVersions).orderBy(desc(schema.diffTemplateVersions.createdAt)) }));
  app.post('/diff', { schema: { body: z.object({ name: z.string().max(128), boardModelId: z.string().uuid().nullable().optional(), version: z.string().regex(/^\d+\.\d+\.\d+$/), content: z.string().max(200_000), changelog: z.string().optional(), isDefault: z.boolean().default(false), isPublic: z.boolean().default(true) }) } }, async (req, reply) => {
    const parsed = analyzeDiff(req.body.content);
    const t = await app.db.transaction(async (tx) => {
      const [t] = await tx.insert(schema.diffTemplates).values({ name: req.body.name, boardModelId: req.body.boardModelId, isDefault: req.body.isDefault, isPublic: req.body.isPublic, createdBy: req.user.sub }).returning();
      const [v] = await tx.insert(schema.diffTemplateVersions).values({ templateId: t!.id, version: req.body.version, content: req.body.content, changelog: req.body.changelog, parsed }).returning();
      await tx.update(schema.diffTemplates).set({ currentVersionId: v!.id }).where(eq(schema.diffTemplates.id, t!.id));
      if (req.body.isDefault && req.body.boardModelId) await tx.update(schema.boardModels).set({ defaultDiffTemplateId: t!.id }).where(eq(schema.boardModels.id, req.body.boardModelId));
      return { ...t!, currentVersionId: v!.id };
    });
    return reply.code(201).send({ success: true, template: t, parsed });
  });
  app.post('/diff/:id/versions', { schema: { params: uuid, body: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), content: z.string().max(200_000), changelog: z.string().optional(), publish: z.boolean().default(true) }) } }, async (req, reply) => {
    const parsed = analyzeDiff(req.body.content);
    const [v] = await app.db.insert(schema.diffTemplateVersions).values({ templateId: req.params.id, version: req.body.version, content: req.body.content, changelog: req.body.changelog, parsed }).returning();
    if (req.body.publish) {
      await app.db.update(schema.diffTemplates).set({ currentVersionId: v!.id, updatedAt: new Date() }).where(eq(schema.diffTemplates.id, req.params.id));
      const [t] = await app.db.select().from(schema.diffTemplates).where(eq(schema.diffTemplates.id, req.params.id));
      await app.db.insert(schema.newsPosts).values({ slug: `diff-${t!.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${req.body.version.replace(/\./g, '-')}`, title: `Обновлён diff «${t!.name}» ${req.body.version}`, body: req.body.changelog ?? 'Опубликована новая версия эталонного diff.', tags: ['diff'], publishedAt: new Date(), createdBy: req.user.sub }).onConflictDoNothing();
      await app.publish({ channel: 'diff', type: 'diff-template.published', payload: { id: req.params.id, version: req.body.version } });
    }
    return reply.code(201).send({ success: true, version: v, parsed });
  });
  app.post('/diff/:id/rollback/:versionId', { schema: { params: z.object({ id: z.string().uuid(), versionId: z.string().uuid() }) } }, async (req) => {
    await app.db.update(schema.diffTemplates).set({ currentVersionId: req.params.versionId, updatedAt: new Date() }).where(eq(schema.diffTemplates.id, req.params.id));
    return { success: true };
  });

  // ---- /admin/news, /admin/feedback ----
  const newsBody = z.object({ slug: z.string().max(128), title: z.string().max(255), body: z.string(), tags: z.array(z.string()).default([]), firmwareVersion: z.string().optional(), publishedAt: z.string().datetime().nullable().optional() });
  app.get('/news', async () => ({ success: true, posts: await app.db.select().from(schema.newsPosts).orderBy(desc(schema.newsPosts.createdAt)) }));
  app.post('/news', { schema: { body: newsBody } }, async (req, reply) => reply.code(201).send({ success: true, post: (await app.db.insert(schema.newsPosts).values({ ...req.body, publishedAt: req.body.publishedAt ? new Date(req.body.publishedAt) : null, createdBy: req.user.sub }).returning())[0] }));
  app.put('/news/:id', { schema: { params: uuid, body: newsBody.partial() } }, async (req) => {
    await app.db.update(schema.newsPosts).set({ ...req.body, publishedAt: req.body.publishedAt === undefined ? undefined : req.body.publishedAt ? new Date(req.body.publishedAt) : null, updatedAt: new Date() }).where(eq(schema.newsPosts.id, req.params.id));
    return { success: true };
  });
  app.delete('/news/:id', { schema: { params: uuid } }, async (req) => {
    await app.db.delete(schema.newsPosts).where(eq(schema.newsPosts.id, req.params.id));
    return { success: true };
  });
  app.get('/feedback', async () => ({ success: true, messages: await app.db.select().from(schema.feedbackMessages).orderBy(desc(schema.feedbackMessages.createdAt)) }));
  app.patch('/feedback/:id', { schema: { params: uuid, body: z.object({ status: z.enum(['new', 'in_progress', 'answered', 'closed']).optional(), adminReply: z.string().optional() }) } }, async (req) => {
    await app.db.update(schema.feedbackMessages).set({ ...req.body, updatedAt: new Date() }).where(eq(schema.feedbackMessages.id, req.params.id));
    return { success: true };
  });

  // ---- audit / sync logs / flags / cms / quick-fix ----
  app.get('/audit', { schema: { querystring: z.object({ limit: z.coerce.number().default(200) }) } }, async (req) => ({ success: true, entries: await app.db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.id)).limit(req.query.limit) }));
  app.get('/vtx-sync-logs', async () => ({ success: true, entries: await app.db.select().from(schema.vtxSyncLog).orderBy(desc(schema.vtxSyncLog.createdAt)).limit(500) }));
  app.get('/flags', async () => ({ success: true, flags: await app.db.select().from(schema.featureFlags) }));
  app.put('/flags/:key', { schema: { params: z.object({ key: z.string().max(64) }), body: z.object({ value: z.unknown(), description: z.string().optional() }) } }, async (req) => {
    await app.db.insert(schema.featureFlags).values({ key: req.params.key, value: req.body.value, description: req.body.description }).onConflictDoUpdate({ target: schema.featureFlags.key, set: { value: req.body.value, description: req.body.description, updatedAt: new Date() } });
    await app.publish({ channel: 'config', type: 'flags.updated', payload: { key: req.params.key } });
    return { success: true };
  });
  app.put('/cms/:key', { schema: { params: z.object({ key: z.string().max(64) }), body: z.object({ content: z.unknown(), locale: z.string().default('ru') }) } }, async (req) => {
    await app.db.insert(schema.cmsContent).values({ key: req.params.key, content: req.body.content, locale: req.body.locale }).onConflictDoUpdate({ target: schema.cmsContent.key, set: { content: req.body.content, updatedAt: new Date() } });
    await app.publish({ channel: 'config', type: 'cms.updated', payload: { key: req.params.key } });
    return { success: true };
  });
  /** Targeted fixes without a deploy: flip a flag, patch CMS text, or set a plan value. */
  app.post('/quick-fix', { schema: { body: z.object({ kind: z.enum(['flag', 'cms', 'plan_feature']), key: z.string(), value: z.unknown(), planCode: z.string().optional() }) } }, async (req, reply) => {
    if (req.body.kind === 'flag') await app.db.insert(schema.featureFlags).values({ key: req.body.key, value: req.body.value }).onConflictDoUpdate({ target: schema.featureFlags.key, set: { value: req.body.value, updatedAt: new Date() } });
    else if (req.body.kind === 'cms') await app.db.insert(schema.cmsContent).values({ key: req.body.key, content: req.body.value }).onConflictDoUpdate({ target: schema.cmsContent.key, set: { content: req.body.value, updatedAt: new Date() } });
    else {
      if (!req.body.planCode) return reply.code(400).send({ success: false, error: 'planCode required' });
      const [p] = await app.db.select().from(schema.plans).where(eq(schema.plans.code, req.body.planCode));
      if (!p) return reply.code(404).send({ success: false, error: 'plan_not_found' });
      await app.db.update(schema.plans).set({ features: { ...p.features, [req.body.key]: req.body.value as boolean | number | string } }).where(eq(schema.plans.id, p.id));
    }
    await app.audit(req, 'admin.quick_fix', req.body.key, { kind: req.body.kind });
    await app.publish({ channel: 'config', type: 'quick-fix', payload: req.body });
    return { success: true };
  });

  /** Bootstrap helper: create another admin. */
  app.post('/admins', { schema: { body: z.object({ email: z.string().email(), password: z.string().min(12) }) } }, async (req, reply) => {
    const [u] = await app.db.insert(schema.users).values({ email: req.body.email.toLowerCase(), passwordHash: hashPassword(req.body.password), role: 'admin', emailVerified: true }).returning({ id: schema.users.id });
    await app.audit(req, 'admin.create_admin', u!.id);
    return reply.code(201).send({ success: true, id: u!.id });
  });
};
