import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env, hasEmailProvider, isProduction } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { Prisma } from '../generated/prisma/client.js';

const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(254)
  .email('Enter a valid email address.')
  .transform((value) => value.toLowerCase());

const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  // argon2 hashes the whole input; the cap only keeps absurd payloads out.
  .max(200, 'Use at most 200 characters.');

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

const okSchema = z.object({ ok: z.literal(true) });

/**
 * Register, forgot, and reset all answer the same way whether or not the email
 * exists (PRD §3). Login likewise: one message for every failure mode.
 */
const GENERIC_LOGIN_ERROR = 'That email and password combination is not correct.';
const GENERIC_ACCEPTED =
  'If that email address has an account, we have sent password reset instructions to it.';
/**
 * Shared by the pre-check and the unique-constraint catch below. Both paths must
 * answer identically or the difference becomes an existence oracle.
 */
const REGISTRATION_FAILED =
  'We could not create that account. If you already have one, try signing in or resetting your password.';

const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

const argonOptions = { type: argon2.argon2id } as const;

/**
 * Hashing a throwaway password so a failed login costs the same as a successful
 * one — otherwise response time reveals whether the email exists.
 */
const DUMMY_HASH = await argon2.hash(randomBytes(32).toString('hex'), argonOptions);

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // Credential endpoints are the obvious brute-force target (PRD §17).
  const strictRateLimit = {
    rateLimit: { max: 10, timeWindow: '1 minute' },
  };

  app.post(
    '/auth/register',
    {
      config: strictRateLimit,
      schema: {
        body: z.object({
          name: z.string().trim().min(1, 'Enter your name.').max(120),
          email: emailSchema,
          password: passwordSchema,
        }),
        response: { 201: z.object({ user: userSchema }) },
      },
    },
    async (request, reply) => {
      const { name, email, password } = request.body;
      const passwordHash = await argon2.hash(password, argonOptions);

      const existing = await app.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (existing) {
        // Registering an existing address must not confirm the address exists,
        // so this is the same 400 shape a weak password would produce.
        throw badRequest(REGISTRATION_FAILED, 'registration_failed');
      }

      // The pre-check above only saves a wasted insert on the common path — two
      // concurrent registrations both pass it. The unique constraint is what
      // actually holds the invariant, so its violation gets the same answer.
      let user: { id: string; name: string; email: string };
      try {
        user = await app.prisma.user.create({
          data: { name, email, passwordHash, lastActiveAt: new Date() },
          select: { id: true, name: true, email: true },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw badRequest(REGISTRATION_FAILED, 'registration_failed');
        }
        throw error;
      }

      await app.startSession(reply, request, user.id);
      return reply.status(201).send({ user });
    },
  );

  app.post(
    '/auth/login',
    {
      config: strictRateLimit,
      schema: {
        body: z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password.') }),
        response: { 200: z.object({ user: userSchema }) },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await app.prisma.user.findUnique({ where: { email } });
      // One call site for both branches: a corrupt stored hash must fail the same
      // 400 as a wrong password, not escape as a 500 that marks the account out.
      const valid = await argon2
        .verify(user ? user.passwordHash : DUMMY_HASH, password)
        .catch(() => false);

      if (!user || !valid) {
        throw badRequest(GENERIC_LOGIN_ERROR, 'invalid_credentials');
      }

      await app.prisma.user.update({
        where: { id: user.id },
        data: { lastActiveAt: new Date() },
      });

      await app.startSession(reply, request, user.id);
      return reply.send({ user: { id: user.id, name: user.name, email: user.email } });
    },
  );

  app.post(
    '/auth/logout',
    { schema: { response: { 200: okSchema } } },
    async (request, reply) => {
      const userId = request.user?.id;
      await app.endSession(request, reply);
      // Tear down the user's live SSE streams: a signed-out session must not
      // keep receiving events, and the connections must not stay open
      // (wiki-docs/plan/phase-2-ingestion/design.md "State changes are pushed
      // over SSE").
      if (userId) app.events.closeStreamsForUser(userId);
      return reply.send({ ok: true } as const);
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: [app.requireUser],
      schema: { response: { 200: z.object({ user: userSchema }) } },
    },
    async (request, reply) => {
      return reply.send({ user: request.user! });
    },
  );

  app.post(
    '/auth/forgot',
    {
      config: strictRateLimit,
      schema: {
        body: z.object({ email: emailSchema }),
        response: { 200: z.object({ ok: z.literal(true), message: z.string() }) },
      },
    },
    async (request, reply) => {
      const { email } = request.body;
      const user = await app.prisma.user.findUnique({ where: { email }, select: { id: true } });

      if (user) {
        const token = randomBytes(32).toString('base64url');
        await app.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hashResetToken(token),
            expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_SECONDS * 1000),
          },
        });

        // No email provider is wired up yet (open decision, Phase 0 proposal):
        // the link goes to the server log so the flow is testable end to end.
        // `index.ts` refuses to boot in production while that is true; this is
        // the same guard at the point of use.
        if (isProduction && !hasEmailProvider) {
          throw new Error('Refusing to log a password reset token in production.');
        }
        request.log.info(
          { userId: user.id, resetToken: token },
          'password reset requested — delivery is console-only until an email provider is chosen',
        );
      } else {
        // Deliberately without the address: this branch takes arbitrary
        // unauthenticated input, and logging it would collect PII for anyone
        // who probes the endpoint.
        request.log.info('password reset requested for an address with no account');
      }

      return reply.send({ ok: true as const, message: GENERIC_ACCEPTED });
    },
  );

  app.post(
    '/auth/reset',
    {
      config: strictRateLimit,
      schema: {
        body: z.object({ token: z.string().min(1, 'The reset link is incomplete.'), password: passwordSchema }),
        response: { 200: okSchema },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body;

      const record = await app.prisma.passwordResetToken.findUnique({
        where: { tokenHash: hashResetToken(token) },
      });

      const usable =
        record !== null && record.usedAt === null && record.expiresAt.getTime() > Date.now();

      if (!record || !usable) {
        throw badRequest(
          'That password reset link is no longer valid. Request a new one.',
          'invalid_reset_token',
        );
      }

      const passwordHash = await argon2.hash(password, argonOptions);

      await app.prisma.$transaction([
        app.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
        // Single-use: mark this token spent and drop the user's other tokens.
        app.prisma.passwordResetToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        }),
        app.prisma.passwordResetToken.deleteMany({
          where: { userId: record.userId, usedAt: null },
        }),
        // A reset invalidates existing sessions — the point may be that someone
        // else had access.
        app.prisma.session.deleteMany({ where: { userId: record.userId } }),
      ]);

      await app.endSession(request, reply);
      // A password reset invalidates every session, so it must close every
      // stream those sessions hold. The id comes from the token, not from
      // `request.user`: this route is the unauthenticated link-click path, so
      // the requester is usually signed out and `request.user` is null —
      // exactly the case where someone else may hold a live stream.
      app.events.closeStreamsForUser(record.userId);
      return reply.send({ ok: true } as const);
    },
  );
};

export default authRoutes;
