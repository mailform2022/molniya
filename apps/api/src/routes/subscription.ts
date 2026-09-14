import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { buildAccessResponse } from '../lib/access.js';
import { parseCode } from '../lib/codes.js';
import { env } from '../lib/env.js';
import { getProvider } from '../lib/payments.js';

export const subscriptionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/plans', async () => {
    const list = await app.db.select().from(schema.plans).where(eq(schema.plans.isActive, true));
    const addons = await app.db.select().from(schema.planAddons).where(eq(schema.planAddons.isActive, true));
    return { success: true, plans: list, addons };
  });

  app.get('/subscription', { preHandler: app.authenticate }, async (req) => {
    const history = await app.db
      .select({ s: schema.subscriptions, plan: schema.plans.code })
      .from(schema.subscriptions)
      .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
      .where(eq(schema.subscriptions.userId, req.user.sub))
      .orderBy(desc(schema.subscriptions.createdAt));
    return { ...(await buildAccessResponse(req.user.sub)), history };
  });

  /** CodeRedeemer: MLN-{TYPE}-{PLAN}-{DURATION}-{DEVICES}-{SIG} */
  app.post('/subscription/redeem', { preHandler: app.authenticate, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }, schema: { body: z.object({ code: z.string().max(64) }) } }, async (req, reply) => {
    const parsed = parseCode(req.body.code);
    if (!parsed) {
      await app.audit(req, 'code.redeem_invalid', req.body.code.slice(0, 64));
      return reply.code(400).send({ success: false, error: 'invalid_code' });
    }
    const [row] = await app.db.select().from(schema.activationCodes).where(eq(schema.activationCodes.code, parsed.code));
    if (!row || row.isRevoked) return reply.code(400).send({ success: false, error: 'code_revoked_or_unknown' });
    if (row.redemptions >= row.maxRedemptions) return reply.code(400).send({ success: false, error: 'code_used' });
    if (row.expiresAt && row.expiresAt < new Date()) return reply.code(400).send({ success: false, error: 'code_expired' });
    const [plan] = await app.db.select().from(schema.plans).where(eq(schema.plans.code, row.planCode));
    if (!plan) return reply.code(400).send({ success: false, error: 'plan_missing' });

    const now = new Date();
    const [current] = await app.db
      .select()
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.userId, req.user.sub), eq(schema.subscriptions.status, 'active'), gt(schema.subscriptions.expiresAt, now)))
      .orderBy(desc(schema.subscriptions.expiresAt))
      .limit(1);

    await app.db.transaction(async (tx) => {
      if (row.type === 'EXT' && current) {
        await tx
          .update(schema.subscriptions)
          .set({ expiresAt: new Date(current.expiresAt.getTime() + row.durationDays * 86400_000), deviceLimit: Math.max(current.deviceLimit, row.deviceLimit) })
          .where(eq(schema.subscriptions.id, current.id));
      } else {
        const start = current && current.source !== 'trial' ? current.expiresAt : now;
        if (current?.source === 'trial') await tx.update(schema.subscriptions).set({ status: 'cancelled' }).where(eq(schema.subscriptions.id, current.id));
        await tx.insert(schema.subscriptions).values({
          userId: req.user.sub,
          planId: plan.id,
          source: 'code',
          startsAt: start,
          expiresAt: new Date(start.getTime() + row.durationDays * 86400_000),
          deviceLimit: row.deviceLimit
        });
      }
      await tx.update(schema.activationCodes).set({ redemptions: sql`${schema.activationCodes.redemptions} + 1` }).where(eq(schema.activationCodes.id, row.id));
      await tx.insert(schema.codeRedemptions).values({ codeId: row.id, userId: req.user.sub, ip: req.ip, fingerprint: req.fingerprint });
    });
    await app.audit(req, 'code.redeem', row.id, { type: row.type });
    const access = await buildAccessResponse(req.user.sub);
    await app.publish({ channel: `user:${req.user.sub}:session`, type: 'access.updated', payload: access.access });
    return access;
  });

  /** AddDeviceDialog: «3 из 3» → «+1» → оплата → лимит обновлён */
  app.post(
    '/subscription/purchase-addon',
    { preHandler: app.authenticate, schema: { body: z.object({ addonCode: z.string(), provider: z.enum(['yookassa', 'stripe', 'manual']).default('manual') }) } },
    async (req, reply) => {
      const [addon] = await app.db.select().from(schema.planAddons).where(and(eq(schema.planAddons.code, req.body.addonCode), eq(schema.planAddons.isActive, true)));
      if (!addon) return reply.code(404).send({ success: false, error: 'addon_not_found' });
      const [current] = await app.db
        .select()
        .from(schema.subscriptions)
        .where(and(eq(schema.subscriptions.userId, req.user.sub), eq(schema.subscriptions.status, 'active'), gt(schema.subscriptions.expiresAt, new Date())))
        .orderBy(desc(schema.subscriptions.expiresAt))
        .limit(1);
      if (!current) return reply.code(400).send({ success: false, error: 'no_active_subscription' });

      const provider = getProvider(req.body.provider, { stripe: env.STRIPE_SECRET_KEY, yookassa: env.YOOKASSA_SECRET_KEY });
      const pay = await provider.createPayment(addon.priceRub, addon.name, { userId: req.user.sub, addon: addon.code });
      const [payment] = await app.db
        .insert(schema.payments)
        .values({ userId: req.user.sub, provider: provider.name, providerPaymentId: pay.paymentId, amountRub: addon.priceRub, status: pay.status, purpose: { kind: 'addon', id: addon.id } })
        .returning();
      if (!pay.ok) return reply.code(402).send({ success: false, error: 'payment_unavailable', message: pay.message, paymentId: payment!.id });

      // Manual provider or zero-price: apply immediately. Real providers apply in webhook.
      if (provider.name === 'manual' || addon.priceRub === 0) {
        await app.db.transaction(async (tx) => {
          if (addon.kind === 'extra_device') await tx.update(schema.subscriptions).set({ deviceLimit: current.deviceLimit + addon.amount }).where(eq(schema.subscriptions.id, current.id));
          else await tx.update(schema.subscriptions).set({ expiresAt: new Date(current.expiresAt.getTime() + addon.amount * 86400_000) }).where(eq(schema.subscriptions.id, current.id));
          await tx.insert(schema.addonPurchases).values({ userId: req.user.sub, subscriptionId: current.id, addonId: addon.id, paymentId: payment!.id });
          await tx.update(schema.payments).set({ status: 'succeeded' }).where(eq(schema.payments.id, payment!.id));
        });
      }
      await app.audit(req, 'addon.purchase', addon.code, { provider: provider.name });
      const access = await buildAccessResponse(req.user.sub);
      await app.publish({ channel: `user:${req.user.sub}:session`, type: 'access.updated', payload: access.access });
      return { ...access, payment: { id: payment!.id, status: pay.status, redirectUrl: pay.redirectUrl, message: pay.message } };
    }
  );

  app.post('/payments/webhook/:provider', { schema: { params: z.object({ provider: z.enum(['yookassa', 'stripe']) }) } }, async (req, reply) => {
    const provider = getProvider(req.params.provider, { stripe: env.STRIPE_SECRET_KEY, yookassa: env.YOOKASSA_SECRET_KEY });
    const res = await provider.handleWebhook(req.body, req.headers);
    if (!res) return reply.code(202).send({ success: true, ignored: true });
    await app.db.update(schema.payments).set({ status: res.status, updatedAt: new Date() }).where(eq(schema.payments.providerPaymentId, res.paymentId));
    return { success: true };
  });
};
