import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { buildAccessResponse } from '../lib/access.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import type { JwtUser } from '../plugins/auth.js';

const credentials = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  fingerprint: z.string().max(128).optional()
});

const REFRESH_DAYS = 30;

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const issue = async (user: typeof schema.users.$inferSelect, req: { ip: string; headers: Record<string, unknown>; fingerprint?: string }, sessionRole: JwtUser['sessionRole'] = 'operator') => {
    const refresh = randomToken(32);
    const [sess] = await app.db
      .insert(schema.userSessions)
      .values({
        userId: user.id,
        refreshTokenHash: sha256(refresh),
        fingerprint: req.fingerprint,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 512),
        role: sessionRole,
        expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400_000)
      })
      .returning();
    const payload: JwtUser = { sub: user.id, email: user.email, role: user.role as JwtUser['role'], sessionRole, sid: sess!.id };
    return { token: app.jwt.sign(payload), refreshToken: refresh, user: { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified } };
  };

  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }, schema: { body: credentials } }, async (req, reply) => {
    const { email, password } = req.body;
    const fingerprint = req.body.fingerprint ?? req.fingerprint;
    const lower = email.toLowerCase();
    const [existing] = await app.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, lower));
    if (existing) return reply.code(409).send({ success: false, error: 'email_taken' });
    if (fingerprint && (await app.flag('registration.one_account_per_fingerprint', true))) {
      const [fpUser] = await app.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.fingerprint, fingerprint));
      if (fpUser) return reply.code(409).send({ success: false, error: 'fingerprint_taken', message: 'На этом устройстве уже зарегистрирован аккаунт' });
    }
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: lower, passwordHash: hashPassword(password), fingerprint, registeredIp: req.ip, emailVerifyToken: randomToken(16) })
      .returning();
    await app.audit(req, 'user.register', user!.id, { fingerprint });
    // Trial: BASE for 3 days so the user can try the configurator before buying/entering a code.
    const [base] = await app.db.select().from(schema.plans).where(eq(schema.plans.code, 'BASE'));
    const trialDays = await app.flag('registration.trial_days', 3);
    if (base && trialDays > 0) {
      await app.db.insert(schema.subscriptions).values({ userId: user!.id, planId: base.id, source: 'trial', expiresAt: new Date(Date.now() + trialDays * 86400_000), deviceLimit: base.deviceLimit });
    }
    const out = await issue(user!, req);
    // Email delivery is not wired yet: the verification link is logged for the operator (see docs/OPERATIONS.md).
    app.log.info({ email: lower, verifyToken: user!.emailVerifyToken }, 'email verification token');
    return reply.code(201).send({ ...out, ...(await buildAccessResponse(user!.id)) });
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }, schema: { body: credentials } }, async (req, reply) => {
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, req.body.email.toLowerCase()));
    if (!user || !verifyPassword(req.body.password, user.passwordHash)) {
      await app.audit(req, 'user.login_failed', req.body.email);
      return reply.code(401).send({ success: false, error: 'invalid_credentials' });
    }
    if (user.isBlocked) return reply.code(403).send({ success: false, error: 'blocked' });
    await app.audit(req, 'user.login', user.id);
    return { ...(await issue(user, req)), ...(await buildAccessResponse(user.id)) };
  });

  app.post('/refresh', { schema: { body: z.object({ refreshToken: z.string().length(64) }) } }, async (req, reply) => {
    const [sess] = await app.db
      .select({ s: schema.userSessions, u: schema.users })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(and(eq(schema.userSessions.refreshTokenHash, sha256(req.body.refreshToken)), gt(schema.userSessions.expiresAt, new Date())));
    if (!sess) return reply.code(401).send({ success: false, error: 'invalid_refresh' });
    const payload: JwtUser = { sub: sess.u.id, email: sess.u.email, role: sess.u.role as JwtUser['role'], sessionRole: sess.s.role as JwtUser['sessionRole'], sid: sess.s.id };
    return { success: true, token: app.jwt.sign(payload) };
  });

  app.post('/logout', { preHandler: app.authenticate }, async (req) => {
    await app.db.delete(schema.userSessions).where(eq(schema.userSessions.id, req.user.sid));
    return { success: true };
  });

  app.get('/verify-email', { schema: { querystring: z.object({ token: z.string() }) } }, async (req, reply) => {
    const [u] = await app.db.update(schema.users).set({ emailVerified: true, emailVerifyToken: null }).where(eq(schema.users.emailVerifyToken, req.query.token)).returning({ id: schema.users.id });
    if (!u) return reply.code(400).send({ success: false, error: 'bad_token' });
    return { success: true };
  });

  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const [user] = await app.db
      .select({ id: schema.users.id, email: schema.users.email, role: schema.users.role, emailVerified: schema.users.emailVerified, profile: schema.users.profile, createdAt: schema.users.createdAt })
      .from(schema.users)
      .where(eq(schema.users.id, req.user.sub));
    const sessions = await app.db
      .select({ id: schema.userSessions.id, role: schema.userSessions.role, ip: schema.userSessions.ip, userAgent: schema.userSessions.userAgent, createdAt: schema.userSessions.createdAt })
      .from(schema.userSessions)
      .where(and(eq(schema.userSessions.userId, req.user.sub), gt(schema.userSessions.expiresAt, new Date())));
    return { user, sessionRole: req.user.sessionRole, sessions, ...(await buildAccessResponse(req.user.sub)) };
  });

  app.patch('/me/profile', { preHandler: app.authenticate, schema: { body: z.record(z.unknown()) } }, async (req) => {
    await app.db.update(schema.users).set({ profile: req.body, updatedAt: new Date() }).where(eq(schema.users.id, req.user.sub));
    await app.publish({ channel: `user:${req.user.sub}:session`, type: 'profile.updated', payload: { by: req.user.sid } });
    return { success: true };
  });

  app.patch('/sessions/:id/role', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ role: z.enum(['operator', 'technician', 'viewer']) }) } }, async (req, reply) => {
    const [s] = await app.db
      .update(schema.userSessions)
      .set({ role: req.body.role })
      .where(and(eq(schema.userSessions.id, req.params.id), eq(schema.userSessions.userId, req.user.sub)))
      .returning();
    if (!s) return reply.code(404).send({ success: false, error: 'not_found' });
    await app.publish({ channel: `user:${req.user.sub}:session`, type: 'session.role', payload: { sid: s.id, role: s.role } });
    return { success: true };
  });

  app.delete('/sessions/:id', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await app.db.delete(schema.userSessions).where(and(eq(schema.userSessions.id, req.params.id), eq(schema.userSessions.userId, req.user.sub)));
    await app.publish({ channel: `user:${req.user.sub}:session`, type: 'session.revoked', payload: { sid: req.params.id } });
    return { success: true };
  });
};
