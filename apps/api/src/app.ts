import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import { corsOrigins, env } from './lib/env.js';
import authPlugin from './plugins/auth.js';
import infraPlugin from './plugins/infra.js';
import { adminAuthRoutes, adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { contentRoutes } from './routes/content.js';
import { deviceRoutes } from './routes/devices.js';
import { diffRoutes } from './routes/diff.js';
import { realtimeRoutes } from './routes/realtime.js';
import { subscriptionRoutes } from './routes/subscription.js';

export const API_VERSION = '0.1.0';

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'test' ? 'silent' : 'info', redact: ['req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || corsOrigins.includes(origin) || (env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) cb(null, true);
      else cb(Object.assign(new Error('origin not allowed'), { statusCode: 403 }), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id', 'X-Fingerprint'],
    exposedHeaders: ['X-Sha256', 'Content-Disposition']
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  await app.register(websocket);
  await app.register(infraPlugin);
  await app.register(authPlugin);

  app.get('/health', async () => {
    let db: 'ok' | 'down' = 'ok';
    let redis: 'ok' | 'down' = 'ok';
    try {
      await app.db.execute(sql`select 1`);
    } catch {
      db = 'down';
    }
    try {
      if (app.redis.status !== 'ready') throw new Error('redis');
      await app.redis.ping();
    } catch {
      redis = 'down';
    }
    return { status: db === 'ok' ? 'ok' : 'degraded', version: API_VERSION, db, redis, domain: env.API_DOMAIN, time: new Date().toISOString() };
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validation?: unknown };
    if (e.validation) return reply.code(400).send({ success: false, error: 'validation', details: e.validation });
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error(e);
    reply.code(status).send({ success: false, error: status >= 500 ? 'internal' : e.message, telegram: status >= 500 ? env.TELEGRAM_CONTACT : undefined });
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(subscriptionRoutes);
      await api.register(deviceRoutes);
      await api.register(catalogRoutes);
      await api.register(diffRoutes);
      await api.register(contentRoutes);
      await api.register(realtimeRoutes);
      await api.register(adminAuthRoutes);
      await api.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/api' }
  );

  return app;
}
