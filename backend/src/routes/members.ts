import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env, loadLimits } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertAccess } from '../middleware/assert-access.js';
import type { Prisma, PrismaClient, SpaceRole } from '../generated/prisma/client.js';
import { spaceRoleSchema } from './spaces.js';

/**
 * Space membership (wiki-docs/plan/shared-spaces-v1/design.md).
 *
 * Invites are email-bound links the owner copies — there is no mail provider —
 * stored as a SHA-256 of the token like password-reset tokens, single-use and
 * expiring. Every failure to accept (expired, revoked, consumed, unknown, wrong
 * account) is one neutral 404, so a link tells a stranger nothing.
 *
 * Roles are a total order — owner > editor > viewer — enforced by `assertAccess`.
 * The routes here that manage other people are owner-only; a member may always
 * read the roster and leave.
 */

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.');

/** Only the two grantable roles; ownership moves by transfer, never by invite. */
const grantableRoleSchema = z.enum(['editor', 'viewer']);

const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: spaceRoleSchema,
  joinedAt: z.string(),
});

const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: spaceRoleSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
});

const MEMBERS_LIMIT_MESSAGE = (limit: number) =>
  `This space can have at most ${limit} members, pending invites included.`;

const NEUTRAL_INVITE_MESSAGE = 'This invite link is not valid.';

type InviteRow = { id: string; email: string; role: SpaceRole; expiresAt: Date; createdAt: Date };

const serializeInvite = (invite: InviteRow) => ({
  id: invite.id,
  email: invite.email,
  role: invite.role,
  expiresAt: invite.expiresAt.toISOString(),
  createdAt: invite.createdAt.toISOString(),
});

const inviteUrl = (token: string) => `${env.CORS_ORIGIN.replace(/\/$/, '')}/invite/${token}`;

/** Pending = not accepted, not revoked, not expired. */
const pendingWhere = (spaceId: string): Prisma.SpaceInviteWhereInput => ({
  spaceId,
  acceptedAt: null,
  revokedAt: null,
  expiresAt: { gt: new Date() },
});

/**
 * A member leaving or being removed takes their private conversations with them
 * (design "Removal deletes the member's conversations"). Notes saved from those
 * threads survive: `Note.originConversationId` is `SetNull`.
 */
async function removeMembership(
  tx: Prisma.TransactionClient,
  spaceId: string,
  userId: string,
  actorId: string,
  kind: 'member.removed' | 'member.left',
) {
  await tx.conversation.deleteMany({ where: { spaceId, userId } });
  await tx.spaceMember.delete({ where: { spaceId_userId: { spaceId, userId } } });
  await tx.activity.create({ data: { userId: actorId, spaceId, kind, refId: userId } });
}

async function loadPendingInviteByToken(prisma: PrismaClient, token: string) {
  const invite = await prisma.spaceInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      spaceId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      space: { select: { name: true } },
      invitedBy: { select: { name: true } },
    },
  });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return invite;
}

const membersRoutes: FastifyPluginAsyncZod = async (app) => {
  const writeRateLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
  const readRateLimit = { rateLimit: { max: 600, timeWindow: '1 minute' } };

  const spaceAccess = (role: SpaceRole) => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('space', 'id', role)],
  });

  // --- Roster ----------------------------------------------------------------
  app.get(
    '/spaces/:id/members',
    {
      ...spaceAccess('viewer'),
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: z.object({ members: z.array(memberSchema), invites: z.array(inviteSchema) }),
        },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const rows = await app.prisma.spaceMember.findMany({
        where: { spaceId },
        select: { userId: true, role: true, createdAt: true, user: { select: { name: true, email: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      });
      // Pending invites are the owner's business: they name people who have not
      // joined and may never.
      const invites =
        request.access!.role === 'owner'
          ? await app.prisma.spaceInvite.findMany({
              where: pendingWhere(spaceId),
              select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            })
          : [];
      return reply.send({
        members: rows.map((row) => ({
          userId: row.userId,
          name: row.user.name,
          email: row.user.email,
          role: row.role,
          joinedAt: row.createdAt.toISOString(),
        })),
        invites: invites.map(serializeInvite),
      });
    },
  );

  // --- Invites ---------------------------------------------------------------
  app.post(
    '/spaces/:id/invites',
    {
      ...spaceAccess('owner'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ email: emailSchema, role: grantableRoleSchema }),
        response: { 201: z.object({ invite: inviteSchema, url: z.string() }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const { email, role } = request.body;

      const existingMember = await app.prisma.spaceMember.findFirst({
        where: { spaceId, user: { email } },
        select: { userId: true },
      });
      if (existingMember) throw conflict('That person is already a member of this space.', 'already_member');

      const pending = await app.prisma.spaceInvite.findFirst({
        where: { ...pendingWhere(spaceId), email },
        select: { id: true },
      });
      if (pending) {
        throw conflict('An invite for that email is already pending. Copy its link from the members page.', 'invite_pending');
      }

      const limits = await loadLimits(app.prisma);
      const token = randomBytes(32).toString('base64url');
      const data = {
        role,
        tokenHash: hashToken(token),
        invitedById: request.user!.id,
        expiresAt: new Date(Date.now() + env.INVITE_TTL_HOURS * 3600 * 1000),
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };
      // `(spaceId, email)` is unique so an expired or revoked row for the same
      // address is reused rather than blocking a fresh invite.
      const invite = await app.prisma.$transaction(async (tx) => {
        // The cap counts seats — members plus invites that could still become
        // one — and it is checked *here*, holding a lock on the space row,
        // because a read-then-write outside the transaction is no cap at all:
        // N concurrent invites all pass it and the space ends up over the
        // limit. Locking the space serialises invite creation per space, and
        // unlike `Serializable` it needs no retry loop. Sequential awaits: a
        // `Promise.all` on one interactive-transaction connection pipelines two
        // queries down a client that can only run one.
        await tx.$executeRaw`SELECT id FROM "Space" WHERE id = ${spaceId} FOR UPDATE`;
        const members = await tx.spaceMember.count({ where: { spaceId } });
        const pendingCount = await tx.spaceInvite.count({ where: pendingWhere(spaceId) });
        if (members + pendingCount >= limits.members_per_space) {
          throw conflict(MEMBERS_LIMIT_MESSAGE(limits.members_per_space), 'members_limit');
        }

        const row = await tx.spaceInvite.upsert({
          where: { spaceId_email: { spaceId, email } },
          create: { spaceId, email, ...data },
          update: data,
          select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        });
        await tx.activity.create({
          data: { userId: request.user!.id, spaceId, kind: 'member.invited', refId: row.id },
        });
        return row;
      });

      return reply.status(201).send({ invite: serializeInvite(invite), url: inviteUrl(token) });
    },
  );

  app.post(
    '/spaces/:id/invites/:inviteId/rotate',
    {
      ...spaceAccess('owner'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string(), inviteId: z.string() }),
        response: { 200: z.object({ invite: inviteSchema, url: z.string() }) },
      },
    },
    async (request, reply) => {
      const { id: spaceId, inviteId } = request.params;
      // "Copy the link again" mints a new token: the old one was shown once and
      // is not stored, so it cannot be re-shown — and is now dead.
      const token = randomBytes(32).toString('base64url');
      const result = await app.prisma.spaceInvite.updateMany({
        where: { id: inviteId, ...pendingWhere(spaceId) },
        data: { tokenHash: hashToken(token) },
      });
      if (result.count === 0) throw notFound();
      const invite = await app.prisma.spaceInvite.findUniqueOrThrow({
        where: { id: inviteId },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      });
      return reply.send({ invite: serializeInvite(invite), url: inviteUrl(token) });
    },
  );

  app.delete(
    '/spaces/:id/invites/:inviteId',
    {
      ...spaceAccess('owner'),
      config: writeRateLimit,
      schema: { params: z.object({ id: z.string(), inviteId: z.string() }) },
    },
    async (request, reply) => {
      const { id: spaceId, inviteId } = request.params;
      const result = await app.prisma.spaceInvite.updateMany({
        where: { id: inviteId, ...pendingWhere(spaceId) },
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) throw notFound();
      return reply.status(204).send();
    },
  );

  // --- Accepting --------------------------------------------------------------
  // Token-scoped rather than space-scoped: the caller is not a member yet, so
  // there is nothing for `assertAccess` to assert. `requireUser` plus the
  // email match is the whole check, and every failure is the same 404.
  app.get(
    '/invites/:token',
    {
      onRequest: [app.requireUser],
      config: readRateLimit,
      schema: {
        params: z.object({ token: z.string().min(1) }),
        response: {
          200: z.object({
            invite: z.object({
              spaceId: z.string(),
              spaceName: z.string(),
              role: spaceRoleSchema,
              inviterName: z.string(),
              expiresAt: z.string(),
              alreadyMember: z.boolean(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const invite = await loadPendingInviteByToken(app.prisma, request.params.token);
      if (!invite || invite.email !== request.user!.email.toLowerCase()) {
        throw notFound(NEUTRAL_INVITE_MESSAGE);
      }
      const membership = await app.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: invite.spaceId, userId: request.user!.id } },
        select: { role: true },
      });
      return reply.send({
        invite: {
          spaceId: invite.spaceId,
          spaceName: invite.space.name,
          role: invite.role,
          inviterName: invite.invitedBy.name,
          expiresAt: invite.expiresAt.toISOString(),
          alreadyMember: membership !== null,
        },
      });
    },
  );

  app.post(
    '/invites/:token/accept',
    {
      onRequest: [app.requireUser],
      config: writeRateLimit,
      schema: {
        params: z.object({ token: z.string().min(1) }),
        response: { 200: z.object({ spaceId: z.string(), role: spaceRoleSchema }) },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const invite = await loadPendingInviteByToken(app.prisma, request.params.token);
      if (!invite || invite.email !== request.user!.email.toLowerCase()) {
        throw notFound(NEUTRAL_INVITE_MESSAGE);
      }

      const role = await app.prisma.$transaction(async (tx) => {
        // Consume first, under a pending guard, so two accepts of one link
        // (a double-click) create one membership and one activity row.
        const consumed = await tx.spaceInvite.updateMany({
          where: { id: invite.id, ...pendingWhere(invite.spaceId) },
          data: { acceptedAt: new Date() },
        });
        if (consumed.count === 0) throw notFound(NEUTRAL_INVITE_MESSAGE);

        const existing = await tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: invite.spaceId, userId } },
          select: { role: true },
        });
        // Already a member (invited twice by different routes): idempotent,
        // keep the standing role rather than silently changing it.
        if (existing) return existing.role;

        await tx.spaceMember.create({
          data: { spaceId: invite.spaceId, userId, role: invite.role, invitedById: null },
        });
        await tx.activity.create({
          data: { userId, spaceId: invite.spaceId, kind: 'member.joined', refId: userId },
        });
        return invite.role;
      });

      return reply.send({ spaceId: invite.spaceId, role });
    },
  );

  // --- Managing members --------------------------------------------------------
  app.patch(
    '/spaces/:id/members/:userId',
    {
      ...spaceAccess('owner'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string(), userId: z.string() }),
        body: z.object({ role: grantableRoleSchema }),
        response: { 200: z.object({ member: memberSchema }) },
      },
    },
    async (request, reply) => {
      const { id: spaceId, userId } = request.params;
      if (userId === request.user!.id) {
        throw badRequest('Transfer ownership to change your own role.', 'owner_self_change', {
          role: 'Transfer ownership to change your own role.',
        });
      }
      const member = await app.prisma.$transaction(async (tx) => {
        const result = await tx.spaceMember.updateMany({
          where: { spaceId, userId, role: { not: 'owner' } },
          data: { role: request.body.role },
        });
        if (result.count === 0) throw notFound();
        await tx.activity.create({
          data: { userId: request.user!.id, spaceId, kind: 'member.role_changed', refId: userId },
        });
        return tx.spaceMember.findUniqueOrThrow({
          where: { spaceId_userId: { spaceId, userId } },
          select: { userId: true, role: true, createdAt: true, user: { select: { name: true, email: true } } },
        });
      });
      return reply.send({
        member: {
          userId: member.userId,
          name: member.user.name,
          email: member.user.email,
          role: member.role,
          joinedAt: member.createdAt.toISOString(),
        },
      });
    },
  );

  app.delete(
    '/spaces/:id/members/:userId',
    {
      ...spaceAccess('owner'),
      config: writeRateLimit,
      schema: { params: z.object({ id: z.string(), userId: z.string() }) },
    },
    async (request, reply) => {
      const { id: spaceId, userId } = request.params;
      if (userId === request.user!.id) {
        throw badRequest('Transfer ownership or delete the space instead of removing yourself.', 'owner_self_remove');
      }
      const target = await app.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId } },
        select: { role: true },
      });
      if (!target || target.role === 'owner') throw notFound();

      await app.prisma.$transaction((tx) =>
        removeMembership(tx, spaceId, userId, request.user!.id, 'member.removed'),
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/spaces/:id/leave',
    {
      ...spaceAccess('viewer'),
      config: writeRateLimit,
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      if (request.access!.role === 'owner') {
        throw conflict('Transfer ownership or delete the space before leaving it.', 'owner_cannot_leave');
      }
      await app.prisma.$transaction((tx) =>
        removeMembership(tx, spaceId, request.user!.id, request.user!.id, 'member.left'),
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/spaces/:id/transfer',
    {
      ...spaceAccess('owner'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ userId: z.string().min(1) }),
        response: { 200: z.object({ ownerId: z.string() }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const from = request.user!.id;
      const to = request.body.userId;
      if (to === from) throw badRequest('You already own this space.', 'transfer_to_self', { userId: 'You already own this space.' });

      await app.prisma.$transaction(async (tx) => {
        // Only an editor can receive ownership: they have already been trusted
        // with the evidence pool. The guard on the target's row is what makes
        // the whole transfer one atomic step — no window with two owners.
        const promoted = await tx.spaceMember.updateMany({
          where: { spaceId, userId: to, role: 'editor' },
          data: { role: 'owner' },
        });
        if (promoted.count === 0) {
          throw badRequest('Ownership can only be transferred to an editor of this space.', 'transfer_target_not_editor', {
            userId: 'Choose an editor of this space.',
          });
        }
        await tx.spaceMember.update({
          where: { spaceId_userId: { spaceId, userId: from } },
          data: { role: 'editor' },
        });
        await tx.space.update({ where: { id: spaceId }, data: { ownerId: to } });
        await tx.activity.create({
          data: { userId: from, spaceId, kind: 'space.ownership_transferred', refId: to },
        });
      });

      return reply.send({ ownerId: to });
    },
  );
};

export default membersRoutes;
