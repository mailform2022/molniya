import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { env } from '../lib/env.js';

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

/** News, RSS, feedback, contacts, CMS content, feature flags (public read). */
export const contentRoutes: FastifyPluginAsyncZod = async (app) => {
  const published = () => and(isNotNull(schema.newsPosts.publishedAt), lte(schema.newsPosts.publishedAt, new Date()));

  app.get('/news', { schema: { querystring: z.object({ tag: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) } }, async (req) => {
    let posts = await app.db.select().from(schema.newsPosts).where(published()).orderBy(desc(schema.newsPosts.publishedAt)).limit(req.query.limit);
    if (req.query.tag) posts = posts.filter((p) => p.tags?.includes(req.query.tag!));
    return { success: true, posts };
  });

  app.get('/news/:slug', { schema: { params: z.object({ slug: z.string() }) } }, async (req, reply) => {
    const [post] = await app.db.select().from(schema.newsPosts).where(and(eq(schema.newsPosts.slug, req.params.slug), published()));
    if (!post) return reply.code(404).send({ success: false, error: 'not_found' });
    return { success: true, post };
  });

  app.get('/news.rss', async (_req, reply) => {
    const posts = await app.db.select().from(schema.newsPosts).where(published()).orderBy(desc(schema.newsPosts.publishedAt)).limit(30);
    const site = 'https://vtxservices.ru';
    const items = posts
      .map(
        (p) =>
          `<item><title>${esc(p.title)}</title><link>${site}/news/${p.slug}</link><guid>${site}/news/${p.slug}</guid><pubDate>${p.publishedAt!.toUTCString()}</pubDate>${(p.tags ?? []).map((t) => `<category>${esc(t)}</category>`).join('')}<description>${esc(p.body.slice(0, 500))}</description></item>`
      )
      .join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>VTX Services — анонсы</title><link>${site}/news</link><description>Обновления прошивок и сервиса</description>${items}</channel></rss>`;
    return reply.header('Content-Type', 'application/rss+xml; charset=utf-8').send(xml);
  });

  app.post(
    '/feedback',
    {
      preHandler: app.optionalAuth,
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: { body: z.object({ email: z.string().email().optional(), subject: z.string().max(255).optional(), message: z.string().min(5).max(5000) }) }
    },
    async (req, reply) => {
      const [f] = await app.db.insert(schema.feedbackMessages).values({ userId: req.user?.sub, ...req.body }).returning({ id: schema.feedbackMessages.id });
      return reply.code(201).send({ success: true, id: f!.id });
    }
  );

  app.get('/contacts', async () => ({
    success: true,
    telegram: env.TELEGRAM_CONTACT,
    telegramUrl: `https://t.me/${env.TELEGRAM_CONTACT.replace(/^@/, '')}`
  }));

  app.get('/config', async () => {
    const flags = await app.db.select().from(schema.featureFlags);
    const cms = await app.db.select().from(schema.cmsContent);
    return {
      success: true,
      flags: Object.fromEntries(flags.filter((f) => !f.key.startsWith('registration.')).map((f) => [f.key, f.value])),
      content: Object.fromEntries(cms.map((c) => [c.key, c.content])),
      telegram: env.TELEGRAM_CONTACT
    };
  });
};
