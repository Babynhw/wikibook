import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertAccess } from '../middleware/assert-access.js';
import { loadLimits } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SpaceRole } from '../generated/prisma/client.js';

/**
 * Input-shape limits, deliberately not `AppConfig` keys: PRD §5's configurable
 * limits are about ingestion volume, and there is no product reason to tune a
 * title length per deployment. See plan/phase-1-spaces/design.md.
 */
const nameSchema = z
  .string()
  .trim()
  .min(1, 'Give the space a name.')
  .max(120, 'Use at most 120 characters.');

const objectiveSchema = z
  .string()
  .trim()
  .max(2000, 'Use at most 2000 characters.')
  // An empty objective is "not set", not an empty string — the field is optional
  // (PRD §4) and a blank string would render as a set-but-empty objective.
  .transform((value) => (value.length === 0 ? null : value));

export const spaceRoleSchema = z.enum(['owner', 'editor', 'viewer']);

const spaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  objective: z.string().nullable(),
  /**
   * The owner's "Audience & style" note. Sent to **every** role: a member should
   * be able to read what is shaping the answers they are given, and only the
   * owner can change it (plan/space-audience-style).
   */
  audienceInstruction: z.string().nullable(),
  /** The configured cap, so the editor can count characters without a second request. */
  audienceInstructionMaxChars: z.number().int(),
  archivedAt: z.string().nullable(),
  /** When *the caller* last opened it — resume is per member (shared-spaces-v1). */
  lastOpenedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceCount: z.number().int(),
  noteCount: z.number().int(),
  myRole: spaceRoleSchema,
  ownerName: z.string(),
  memberCount: z.number().int(),
});

/**
 * The space plus the caller's own membership row, so one query answers both
 * "what is this space" and "what am I here / when was I last here".
 */
const spaceSelectFor = (userId: string) =>
  ({
    id: true,
    name: true,
    objective: true,
    audienceInstruction: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
    owner: { select: { name: true } },
    members: { where: { userId }, select: { role: true, lastOpenedAt: true } },
    _count: { select: { sources: true, notes: true, members: true } },
  }) as const;

interface SpaceRow {
  id: string;
  name: string;
  objective: string | null;
  audienceInstruction: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  owner: { name: string };
  members: { role: SpaceRole; lastOpenedAt: Date | null }[];
  _count: { sources: number; notes: number; members: number };
}

/** Dates cross the wire as ISO strings; counts are flattened out of `_count`. */
function serializeSpace(space: SpaceRow, audienceMaxChars: number) {
  // The guard proved membership, so the filtered relation has exactly one row.
  const me = space.members[0];
  if (!me) throw notFound();
  return {
    id: space.id,
    name: space.name,
    objective: space.objective,
    audienceInstruction: space.audienceInstruction,
    audienceInstructionMaxChars: audienceMaxChars,
    archivedAt: space.archivedAt?.toISOString() ?? null,
    lastOpenedAt: me.lastOpenedAt?.toISOString() ?? null,
    createdAt: space.createdAt.toISOString(),
    updatedAt: space.updatedAt.toISOString(),
    sourceCount: space._count.sources,
    noteCount: space._count.notes,
    myRole: me.role,
    ownerName: space.owner.name,
    memberCount: space._count.members,
  };
}

/** The frozen-space message every Phase 2+ write route inherits
 * (plan/phase-1-spaces/design.md). */
export const ARCHIVED_MESSAGE = 'This space is archived. Restore it to make changes.';

/** A filter that matched nothing — the row was gone, or the guard did not hold. */
const isNoMatch = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';

const spaceRoutes: FastifyPluginAsyncZod = async (app) => {
  // Writes are cheap but unbounded otherwise: `rateLimit` is registered with
  // `global: false` (app.ts), so a route without this config has no ceiling at
  // all. A per-user cap on spaces, if it is ever wanted, is an `AppConfig` key
  // read through `loadLimits()` — never a constant here (PRD §5).
  const writeRateLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

  /** Access is already asserted by the preHandler; this only reloads the row. */
  const loadSpace = async (id: string, userId: string): Promise<SpaceRow> => {
    const space = await app.prisma.space.findUnique({
      where: { id },
      select: spaceSelectFor(userId),
    });
    if (!space) throw notFound();
    return space;
  };

  /**
   * The wire shape, with the audience cap read from `AppConfig` (PRD §5) rather
   * than hard-coded — it is the one control on the audience note that does not
   * depend on the model cooperating, so an operator must be able to tighten it
   * (plan/space-audience-style/design.md). `loadLimits` is cached, so this is not
   * a query per space.
   */
  const serialize = async (space: SpaceRow) =>
    serializeSpace(space, (await loadLimits(app.prisma)).audience_instruction_max_chars);

  /**
   * Writes a space only while it still matches `guard`, and answers null when it
   * does not. One statement rather than a read, a check, and a write: an archive
   * landing in between would otherwise let the write through against a state the
   * handler already rejected.
   */
  const updateGuarded = async (
    id: string,
    userId: string,
    guard: Omit<Prisma.SpaceWhereInput, 'id'>,
    data: Prisma.SpaceUpdateInput,
  ): Promise<SpaceRow | null> => {
    try {
      return await app.prisma.space.update({
        where: { ...guard, id },
        data,
        select: spaceSelectFor(userId),
      });
    } catch (error) {
      if (isNoMatch(error)) return null;
      throw error;
    }
  };

  /**
   * `requireUser` runs in `onRequest`, which is *before* body validation —
   * otherwise an anonymous request with a malformed body gets a 400 describing
   * the schema instead of a 401. Ownership stays in `preHandler`: it needs the
   * validated route params.
   */
  /**
   * A factory, not a shared object: `@fastify/rate-limit` *pushes* its hook into
   * `routeOptions.onRequest`, so one array reused across routes collects every
   * route's limiter and applies them all to each — which is how the read route
   * silently inherited a write's 60/minute cap. Every route gets fresh arrays.
   */
  const ownedSpace = (role: SpaceRole = 'viewer') => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('space', 'id', role)],
  });

  app.get(
    '/spaces',
    {
      onRequest: [app.requireUser],
      schema: {
        querystring: z.object({ filter: z.enum(['active', 'archived']).default('active') }),
        response: { 200: z.object({ spaces: z.array(spaceSchema) }) },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      // Every space I am a member of — owned or shared — ordered by *my* last
      // open (PRD §4), which lives on the membership row. Prisma cannot order a
      // parent by a filtered child, so the order comes from the member rows.
      const memberships = await app.prisma.spaceMember.findMany({
        where: {
          userId,
          space: { archivedAt: request.query.filter === 'archived' ? { not: null } : null },
        },
        // A space that has never been opened sorts by creation date rather than to the top.
        orderBy: [{ lastOpenedAt: { sort: 'desc', nulls: 'last' } }, { space: { createdAt: 'desc' } }],
        select: { space: { select: spaceSelectFor(userId) } },
      });

      // One limits read for the page rather than one per space: `loadLimits` is
      // cached, but relying on the cache to make a loop free is not the same as
      // not writing the loop.
      const audienceMax = (await loadLimits(app.prisma)).audience_instruction_max_chars;
      return reply.send({
        spaces: memberships.map((m) => serializeSpace(m.space, audienceMax)),
      });
    },
  );

  app.post(
    '/spaces',
    {
      onRequest: [app.requireUser],
      config: writeRateLimit,
      schema: {
        body: z.object({ name: nameSchema, objective: objectiveSchema.optional() }),
        response: { 201: z.object({ space: spaceSchema }) },
      },
    },
    async (request, reply) => {
      const { name, objective } = request.body;
      const ownerId = request.user!.id;

      const space = await app.prisma.$transaction(async (tx) => {
        // The owner is a member too, so access is one lookup everywhere else
        // (plan/shared-spaces-v1/design.md "Every member has a row").
        const created = await tx.space.create({
          data: {
            ownerId,
            name,
            objective: objective ?? null,
            members: { create: { userId: ownerId, role: 'owner' } },
          },
          select: spaceSelectFor(ownerId),
        });
        // The §15 activity feed is Phase 7 work, but a feed that only knows about
        // events since it shipped is a feed with a hole in it.
        await tx.activity.create({
          data: { userId: ownerId, spaceId: created.id, kind: 'space.created', refId: created.id },
        });
        return created;
      });

      return reply.status(201).send({ space: await serialize(space) });
    },
  );

  app.get(
    '/spaces/:id',
    {
      ...ownedSpace(),
      schema: {
        params: z.object({ id: z.string() }),
        // Deliberately does not stamp `lastOpenedAt`: the SPA refetches a space on
        // focus and on cache invalidation, and each of those would reorder the
        // user's list. Opening is an explicit act — see POST /spaces/:id/open.
        response: { 200: z.object({ space: spaceSchema }) },
      },
    },
    async (request, reply) => {
      return reply.send({
        space: await serialize(await loadSpace(request.params.id, request.user!.id)),
      });
    },
  );

  app.patch(
    '/spaces/:id',
    {
      ...ownedSpace('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: z
          .object({ name: nameSchema.optional(), objective: objectiveSchema.optional() })
          .refine((body) => body.name !== undefined || body.objective !== undefined, {
            message: 'Change the name or the research objective.',
            // Without a path the issue is object-level, and the error handler —
            // which builds `fields` from each issue's instancePath — drops the
            // message, leaving a 400 that names nothing to fix.
            path: ['name'],
          }),
        response: { 200: z.object({ space: spaceSchema }) },
      },
    },
    async (request, reply) => {
      const { name, objective } = request.body;
      const space = await updateGuarded(
        request.params.id,
        request.user!.id,
        { archivedAt: null },
        {
          ...(name !== undefined ? { name } : {}),
          ...(objective !== undefined ? { objective } : {}),
        },
      );
      // Ownership already proved the space exists, so the guard is what failed.
      if (!space) throw conflict(ARCHIVED_MESSAGE, 'space_archived');

      return reply.send({ space: await serialize(space) });
    },
  );

  /**
   * The "Audience & style" note (plan/space-audience-style).
   *
   * Its own route rather than a field on `PATCH /spaces/:id`, because that route
   * is `editor` and this field is the owner's. A stricter check inside the shared
   * handler would be invisible to `ownership-table.test.ts`, which proves the rule
   * from the declared role — so the role is declared, and the table can see it.
   */
  app.put(
    '/spaces/:id/audience',
    {
      ...ownedSpace('owner'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        // No `max()` here: the cap is an `AppConfig` value read per request, so it
        // is enforced in the handler where the configured number is known.
        body: z.object({ audience: z.string().nullable() }),
        response: { 200: z.object({ space: spaceSchema }) },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const max = (await loadLimits(app.prisma)).audience_instruction_max_chars;
      const trimmed = request.body.audience?.trim() ?? '';
      if (trimmed.length > max) {
        throw badRequest(
          `Use at most ${max} characters. This note sets who answers are written for, not what the assistant may say.`,
          'bad_request',
          { audience: `Use at most ${max} characters.` },
        );
      }
      // Empty is "not set", the same rule `objectiveSchema` applies: a blank
      // string would render as a set-but-empty note on every member's screen.
      const next = trimmed.length === 0 ? null : trimmed;

      // The note and the feed row land together or not at all. A note that
      // changed with no row is the one thing the row exists to prevent: it
      // changes what every member reads, from a screen only the owner can open
      // (design "Activity"), so a member who notices the assistant's voice
      // change has to be able to find out why. `updateGuarded` is not reused
      // because it holds no transaction.
      const space = await app.prisma.$transaction(async (tx) => {
        // Only to decide whether the change is worth a feed row — it authorises
        // nothing, so reading it before the write is not the read-then-write the
        // archived guard below deliberately avoids.
        const previous = (
          await tx.space.findUnique({
            where: { id: request.params.id },
            select: { audienceInstruction: true },
          })
        )?.audienceInstruction ?? null;

        let updated;
        try {
          updated = await tx.space.update({
            // The archived guard is part of the filter, not a prior read: an
            // archive landing in between would otherwise pass a check the write
            // then contradicts.
            where: { id: request.params.id, archivedAt: null },
            data: { audienceInstruction: next },
            select: spaceSelectFor(userId),
          });
        } catch (error) {
          if (isNoMatch(error)) return null;
          throw error;
        }

        // A save that changed nothing writes nothing: a feed row saying the note
        // changed, when it did not, is noise on a shared feed.
        if (updated.audienceInstruction !== previous) {
          await tx.activity.create({
            data: { userId, spaceId: updated.id, kind: 'space.audience_changed', refId: updated.id },
          });
        }
        return updated;
      });
      if (!space) throw conflict(ARCHIVED_MESSAGE, 'space_archived');

      return reply.send({ space: await serialize(space) });
    },
  );

  app.post(
    '/spaces/:id/open',
    {
      ...ownedSpace(),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ space: spaceSchema }) },
      },
    },
    async (request, reply) => {
      // Opening stamps *my* membership row: another member opening the space
      // must not move it in my list (shared-spaces-v1 "Resume is per member").
      const userId = request.user!.id;
      const result = await app.prisma.spaceMember.updateMany({
        where: { spaceId: request.params.id, userId, space: { archivedAt: null } },
        data: { lastOpenedAt: new Date() },
      });
      if (result.count === 0) throw conflict(ARCHIVED_MESSAGE, 'space_archived');

      return reply.send({ space: await serialize(await loadSpace(request.params.id, userId)) });
    },
  );

  app.post(
    '/spaces/:id/archive',
    {
      ...ownedSpace('owner'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ space: spaceSchema }) },
      },
    },
    async (request, reply) => {
      // Archiving is reversible and never destructive (PRD §4): sources, notes,
      // conversations, and the notebook are untouched. Re-archiving is a no-op
      // rather than an error, so a double-click is not a failure state — the
      // guard missing means it was already archived, and the current row is the
      // right answer.
      const userId = request.user!.id;
      const space = await updateGuarded(
        request.params.id,
        userId,
        { archivedAt: null },
        { archivedAt: new Date() },
      );

      return reply.send({
        space: await serialize(space ?? (await loadSpace(request.params.id, userId))),
      });
    },
  );

  app.post(
    '/spaces/:id/restore',
    {
      ...ownedSpace('owner'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ space: spaceSchema }) },
      },
    },
    async (request, reply) => {
      // Restoring an active space is the same no-op as re-archiving.
      const userId = request.user!.id;
      const space = await updateGuarded(
        request.params.id,
        userId,
        { archivedAt: { not: null } },
        { archivedAt: null },
      );

      return reply.send({
        space: await serialize(space ?? (await loadSpace(request.params.id, userId))),
      });
    },
  );
};

export default spaceRoutes;
