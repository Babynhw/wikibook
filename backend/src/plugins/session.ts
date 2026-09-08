import { randomBytes, createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env, isProduction } from '../config.js';
import { unauthorized } from '../lib/errors.js';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or null for anonymous requests. */
    user: SessionUser | null;
    sessionId: string | null;
  }

  interface FastifyInstance {
    /** Creates a session row and sets the `sid` cookie. */
    startSession(reply: FastifyReply, request: FastifyRequest, userId: string): Promise<void>;
    /** Deletes the current session row and clears the cookie. */
    endSession(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** preHandler that rejects anonymous requests with 401. */
    requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

/** Sessions live in Postgres; only a SHA-256 of the token is stored. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: isProduction,
  path: '/',
};

export default fp(async function sessionPlugin(app: FastifyInstance) {
  const ttlMs = env.SESSION_TTL_SECONDS * 1000;
  // Only rewrite the cookie/expiry once a session is past this fraction of its
  // life, so a busy client doesn't cause a write per request.
  const slideThresholdMs = ttlMs / 2;

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[env.SESSION_COOKIE_NAME];
    if (!token) return;

    const session = await app.prisma.session.findUnique({
      where: { id: hashToken(token) },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!session) {
      reply.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions);
      return;
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await app.prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      reply.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions);
      return;
    }

    request.user = session.user;
    request.sessionId = session.id;

    if (session.expiresAt.getTime() - Date.now() < slideThresholdMs) {
      const expiresAt = new Date(Date.now() + ttlMs);
      await app.prisma.session.update({ where: { id: session.id }, data: { expiresAt } });
      reply.setCookie(env.SESSION_COOKIE_NAME, token, {
        ...cookieOptions,
        maxAge: env.SESSION_TTL_SECONDS,
      });
    }
  });

  app.decorate(
    'startSession',
    async (reply: FastifyReply, request: FastifyRequest, userId: string) => {
      const token = randomBytes(32).toString('base64url');
      await app.prisma.session.create({
        data: {
          id: hashToken(token),
          userId,
          expiresAt: new Date(Date.now() + ttlMs),
          userAgent: request.headers['user-agent']?.slice(0, 255) ?? null,
          ip: request.ip,
        },
      });

      reply.setCookie(env.SESSION_COOKIE_NAME, token, {
        ...cookieOptions,
        maxAge: env.SESSION_TTL_SECONDS,
      });
    },
  );

  app.decorate('endSession', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.sessionId) {
      await app.prisma.session.delete({ where: { id: request.sessionId } }).catch(() => {});
    }
    request.user = null;
    request.sessionId = null;
    reply.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions);
  });

  // There is deliberately no `endAllSessions` decorator: the only caller would be
  // `/auth/reset`, and that deletion has to happen inside its `$transaction`
  // alongside the password write, so it is inlined there instead.

  app.decorate('requireUser', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw unauthorized();
  });
});
