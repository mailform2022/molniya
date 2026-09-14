import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '../db/index.js';
import type { JwtUser } from '../plugins/auth.js';

/**
 * WS /api/realtime?token=JWT — multi-session channel `user:{id}:session` plus global channels
 * (plans, firmware, diff, config). Tracks active sessions for the header indicator.
 */
export const realtimeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/realtime', { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token;
    let user: JwtUser;
    try {
      user = app.jwt.verify<JwtUser>(token ?? '');
    } catch {
      socket.close(4001, 'unauthorized');
      return;
    }
    const mine = `user:${user.sub}:session`;
    const label = String(req.headers['user-agent'] ?? '').slice(0, 128);
    const [row] = await app.db.insert(schema.activeSessions).values({ userId: user.sub, sessionId: user.sid, role: user.sessionRole, deviceLabel: label }).returning();

    const broadcastPresence = async () => {
      const list = await app.db.select().from(schema.activeSessions).where(eq(schema.activeSessions.userId, user.sub));
      await app.publish({ channel: mine, type: 'presence', payload: list.map((s) => ({ sid: s.sessionId, role: s.role, device: s.deviceLabel, lastSeenAt: s.lastSeenAt })) });
    };

    const off = app.subscribe((ev) => {
      if (ev.channel === mine || ['plans', 'firmware', 'diff', 'config'].includes(ev.channel)) {
        socket.send(JSON.stringify({ ...ev, self: (ev.payload as { by?: string } | null)?.by === user.sid }));
      }
    });
    socket.send(JSON.stringify({ channel: mine, type: 'hello', payload: { sid: user.sid, role: user.sessionRole } }));
    await broadcastPresence();

    const ping = setInterval(() => {
      app.db.update(schema.activeSessions).set({ lastSeenAt: new Date() }).where(eq(schema.activeSessions.id, row!.id)).catch(() => undefined);
    }, 30_000);

    socket.on('message', (raw: Buffer) => {
      // Client-originated events (e.g. local state changes) are relayed to the user's other sessions: last-write-wins.
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; payload: unknown };
        if (typeof msg.type === 'string' && msg.type.length < 64) {
          void app.publish({ channel: mine, type: msg.type, payload: { ...(msg.payload as object), by: user.sid } });
        }
      } catch {
        /* ignore */
      }
    });

    socket.on('close', async () => {
      clearInterval(ping);
      off();
      await app.db.delete(schema.activeSessions).where(eq(schema.activeSessions.id, row!.id)).catch(() => undefined);
      await broadcastPresence().catch(() => undefined);
    });
  });
};
