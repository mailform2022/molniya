import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { db, schema, sql } from '../db/index.js';
import { env } from '../lib/env.js';

export type RealtimeEvent = { channel: string; type: string; payload: unknown };

declare module 'fastify' {
  interface FastifyInstance {
    db: typeof db;
    redis: Redis;
    audit: (req: FastifyRequest, action: string, target?: string, meta?: Record<string, unknown>) => Promise<void>;
    usage: (userId: string | null, event: string, meta?: Record<string, unknown>) => Promise<void>;
    publish: (ev: RealtimeEvent) => Promise<void>;
    subscribe: (cb: (ev: RealtimeEvent) => void) => () => void;
    flag: <T>(key: string, fallback: T) => Promise<T>;
  }
  interface FastifyRequest {
    fingerprint?: string;
  }
}

const RT_CHANNEL = 'vtx:realtime';

export default fp(async (app) => {
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  const subRedis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  let redisOk = false;
  try {
    await redis.connect();
    await subRedis.connect();
    await subRedis.subscribe(RT_CHANNEL);
    redisOk = true;
  } catch (e) {
    app.log.warn({ err: e }, 'redis unavailable — running with in-process realtime only');
  }

  const listeners = new Set<(ev: RealtimeEvent) => void>();
  subRedis.on('message', (_ch: string, msg: string) => {
    try {
      const ev = JSON.parse(msg) as RealtimeEvent;
      for (const l of listeners) l(ev);
    } catch {
      /* ignore */
    }
  });

  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('publish', async (ev: RealtimeEvent) => {
    if (redisOk) await redis.publish(RT_CHANNEL, JSON.stringify(ev)).catch(() => undefined);
    else for (const l of listeners) l(ev);
  });
  app.decorate('subscribe', (cb: (ev: RealtimeEvent) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  });

  app.decorateRequest('fingerprint', undefined);
  app.addHook('onRequest', async (req) => {
    const fp = req.headers['x-fingerprint'];
    if (typeof fp === 'string' && fp.length <= 128) req.fingerprint = fp;
  });

  app.decorate('audit', async (req: FastifyRequest, action: string, target?: string, meta?: Record<string, unknown>) => {
    const actorId = (req.user as { sub?: string } | undefined)?.sub ?? null;
    await db.insert(schema.auditLog).values({ actorId, action, target, ip: req.ip, fingerprint: req.fingerprint, meta }).catch((e) => app.log.error(e));
  });

  app.decorate('usage', async (userId: string | null, event: string, meta?: Record<string, unknown>) => {
    await db.insert(schema.usageLogs).values({ userId, event, meta }).catch((e) => app.log.error(e));
  });

  const flagCache = new Map<string, { v: unknown; t: number }>();
  app.decorate('flag', async <T,>(key: string, fallback: T): Promise<T> => {
    const c = flagCache.get(key);
    if (c && Date.now() - c.t < 10_000) return c.v as T;
    const [row] = await db.select().from(schema.featureFlags).where(eq(schema.featureFlags.key, key));
    const v = row ? (row.value as T) : fallback;
    flagCache.set(key, { v, t: Date.now() });
    return v;
  });

  app.addHook('onClose', async () => {
    redis.disconnect();
    subRedis.disconnect();
    await sql.end({ timeout: 5 });
  });
});
