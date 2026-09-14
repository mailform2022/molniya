import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../lib/env.js';

export interface JwtUser {
  sub: string;
  email: string;
  role: 'user' | 'admin';
  sessionRole: 'operator' | 'technician' | 'viewer';
  sid: string;
  adminOk?: boolean; // 2FA passed
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (roles: JwtUser['sessionRole'][]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '12h' } });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ success: false, error: 'unauthorized' });
    }
  });

  app.decorate('optionalAuth', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      /* anonymous */
    }
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ success: false, error: 'unauthorized' });
    }
    if (req.user.role !== 'admin' || !req.user.adminOk) return reply.code(403).send({ success: false, error: 'admin_2fa_required' });
  });

  app.decorate('requireRole', (roles: JwtUser['sessionRole'][]) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ success: false, error: 'unauthorized' });
    }
    if (req.user.role !== 'admin' && !roles.includes(req.user.sessionRole)) return reply.code(403).send({ success: false, error: 'forbidden_role', required: roles });
  });
});
