import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { buildAccessResponse } from '../lib/access.js';
import { deviceAuthToken, sha256 } from '../lib/crypto.js';

const uid = z.string().regex(/^[0-9a-fA-F]{8,64}$/);

export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/devices', { preHandler: app.authenticate }, async (req) => {
    const list = await app.db.select().from(schema.devices).where(eq(schema.devices.userId, req.user.sub));
    const access = await buildAccessResponse(req.user.sub);
    return { success: true, devices: list.map(({ authTokenHash: _h, backup: _b, ...d }) => ({ ...d, hasBackup: Boolean(_b) })), access: access.access };
  });

  /** Register a transmitter/board after reading its UID over MSP. Transmitters count against device_limit; boards are unlimited. */
  app.post(
    '/devices',
    {
      preHandler: app.requireRole(['operator', 'technician']),
      schema: { body: z.object({ kind: z.enum(['transmitter', 'board']), uid, name: z.string().max(64).optional(), modelId: z.string().uuid().optional(), firmwareVersion: z.string().max(32).optional() }) }
    },
    async (req, reply) => {
      const [exists] = await app.db.select().from(schema.devices).where(eq(schema.devices.uid, req.body.uid.toLowerCase()));
      if (exists) {
        if (exists.userId !== req.user.sub) return reply.code(409).send({ success: false, error: 'uid_belongs_to_other_account' });
        return { success: true, device: exists, existing: true };
      }
      const access = await buildAccessResponse(req.user.sub);
      if (req.body.kind === 'transmitter') {
        if (access.access.type === 'none') return reply.code(402).send({ ...access, success: false, error: 'subscription_required' });
        if (access.access.devices_used >= access.access.device_limit) {
          return reply.code(402).send({ ...access, success: false, error: 'device_limit_reached', hint: 'POST /api/subscription/purchase-addon { addonCode: "extra_device" }' });
        }
      }
      const [device] = await app.db
        .insert(schema.devices)
        .values({ userId: req.user.sub, kind: req.body.kind, uid: req.body.uid.toLowerCase(), name: req.body.name, modelId: req.body.modelId, firmwareVersion: req.body.firmwareVersion })
        .returning();
      await app.audit(req, 'device.register', device!.id, { kind: device!.kind });
      await app.usage(req.user.sub, 'device.register', { kind: device!.kind });
      return reply.code(201).send({ success: true, device });
    }
  );

  /** Called when a transmitter is plugged in: tariff, expires_at, per-device auth status. */
  app.get('/devices/:uid/status', { preHandler: app.authenticate, schema: { params: z.object({ uid }) } }, async (req, reply) => {
    const [d] = await app.db.select().from(schema.devices).where(and(eq(schema.devices.uid, req.params.uid.toLowerCase()), eq(schema.devices.userId, req.user.sub)));
    if (!d) return reply.code(404).send({ success: false, error: 'not_registered' });
    const access = await buildAccessResponse(req.user.sub);
    const expires = access.access.expires_at ? new Date(access.access.expires_at) : null;
    const remainingSec = expires ? Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)) : 0;
    return {
      success: true,
      device: { id: d.id, uid: d.uid, kind: d.kind, name: d.name, firmwareVersion: d.firmwareVersion, authExpiresAt: d.authExpiresAt, lastSyncAt: d.lastSyncAt },
      access: access.access,
      remainingSec,
      progress: expires && access.access.plan ? Math.min(1, remainingSec / (30 * 86400)) : 0
    };
  });

  /** Issue auth token to write into the transmitter via MSP2 0x2F21 (SET_AUTH_TOKEN). */
  app.post('/devices/:uid/auth-token', { preHandler: app.requireRole(['operator', 'technician']), schema: { params: z.object({ uid }) } }, async (req, reply) => {
    const [d] = await app.db.select().from(schema.devices).where(and(eq(schema.devices.uid, req.params.uid.toLowerCase()), eq(schema.devices.userId, req.user.sub)));
    if (!d) return reply.code(404).send({ success: false, error: 'not_registered' });
    const access = await buildAccessResponse(req.user.sub);
    if (access.access.type === 'none' || !access.access.expires_at || !access.access.plan) return reply.code(402).send({ ...access, success: false, error: 'subscription_required' });
    const expiresUnix = Math.floor(new Date(access.access.expires_at).getTime() / 1000);
    const token = deviceAuthToken(d.uid, access.access.plan, expiresUnix);
    await app.db.update(schema.devices).set({ authTokenHash: sha256(token), authExpiresAt: new Date(expiresUnix * 1000), lastSyncAt: new Date() }).where(eq(schema.devices.id, d.id));
    await app.db.insert(schema.vtxSyncLog).values({ userId: req.user.sub, deviceId: d.id, direction: 'to_tx', payload: { kind: 'auth_token', expiresUnix } });
    await app.audit(req, 'device.auth_token', d.id);
    return { success: true, token: token.toString('hex'), expiresAt: expiresUnix, plan: access.access.plan, deviceLimit: access.access.device_limit, devicesUsed: access.access.devices_used };
  });

  app.put('/devices/:uid/backup', { preHandler: app.requireRole(['technician', 'operator']), schema: { params: z.object({ uid }), body: z.record(z.unknown()) } }, async (req, reply) => {
    const [d] = await app.db
      .update(schema.devices)
      .set({ backup: { ...req.body, savedAt: new Date().toISOString() } })
      .where(and(eq(schema.devices.uid, req.params.uid.toLowerCase()), eq(schema.devices.userId, req.user.sub)))
      .returning({ id: schema.devices.id });
    if (!d) return reply.code(404).send({ success: false, error: 'not_registered' });
    await app.audit(req, 'device.backup', d.id);
    return { success: true };
  });

  app.get('/devices/:uid/backup', { preHandler: app.authenticate, schema: { params: z.object({ uid }) } }, async (req, reply) => {
    const [d] = await app.db.select({ backup: schema.devices.backup }).from(schema.devices).where(and(eq(schema.devices.uid, req.params.uid.toLowerCase()), eq(schema.devices.userId, req.user.sub)));
    if (!d?.backup) return reply.code(404).send({ success: false, error: 'no_backup' });
    return { success: true, backup: d.backup };
  });

  app.patch('/devices/:id', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ name: z.string().max(64).optional(), firmwareVersion: z.string().max(32).optional(), modelId: z.string().uuid().nullable().optional() }) } }, async (req) => {
    await app.db.update(schema.devices).set(req.body).where(and(eq(schema.devices.id, req.params.id), eq(schema.devices.userId, req.user.sub)));
    return { success: true };
  });

  app.delete('/devices/:id', { preHandler: app.requireRole(['operator']), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await app.db.delete(schema.devices).where(and(eq(schema.devices.id, req.params.id), eq(schema.devices.userId, req.user.sub)));
    await app.audit(req, 'device.delete', req.params.id);
    return { success: true };
  });

  app.post('/vtx-sync-log', { preHandler: app.authenticate, schema: { body: z.object({ deviceId: z.string().uuid().optional(), direction: z.enum(['to_fc', 'to_tx', 'from_fc']), payload: z.record(z.unknown()), ok: z.boolean().default(true) }) } }, async (req) => {
    await app.db.insert(schema.vtxSyncLog).values({ userId: req.user.sub, ...req.body });
    return { success: true };
  });
};
