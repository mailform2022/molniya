import { and, desc, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export interface AccessResponse {
  success: boolean;
  access: {
    type: 'subscription' | 'trial' | 'none';
    plan: string | null;
    expires_at: string | null;
    device_limit: number;
    devices_used: number;
    features: Record<string, unknown>;
    source: string | null;
  };
}

/** Single source of truth for "what can this user do right now". */
export async function buildAccessResponse(userId: string): Promise<AccessResponse> {
  const now = new Date();
  const [sub] = await db
    .select({ s: schema.subscriptions, p: schema.plans })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(and(eq(schema.subscriptions.userId, userId), eq(schema.subscriptions.status, 'active'), gt(schema.subscriptions.expiresAt, now)))
    .orderBy(desc(schema.subscriptions.expiresAt))
    .limit(1);

  const txCount = await db.$count(schema.devices, and(eq(schema.devices.userId, userId), eq(schema.devices.kind, 'transmitter')));

  if (!sub) {
    return {
      success: true,
      access: { type: 'none', plan: null, expires_at: null, device_limit: 0, devices_used: txCount, features: {}, source: null }
    };
  }
  return {
    success: true,
    access: {
      type: sub.s.source === 'trial' ? 'trial' : 'subscription',
      plan: sub.p.code,
      expires_at: sub.s.expiresAt.toISOString(),
      device_limit: sub.s.deviceLimit,
      devices_used: txCount,
      features: sub.p.features,
      source: sub.s.source
    }
  };
}
