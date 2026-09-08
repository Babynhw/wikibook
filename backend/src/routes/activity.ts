import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { assertAccess } from '../middleware/assert-access.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

/**
 * Activity feed (PRD §15; shared-spaces-v1 "Activity").
 *
 * Two cursor-paginated lists over one table, newest first: the Home feed (my
 * own actions, plus membership events about me) and a space's feed (every
 * member's actions there, with the actor named). Rows carry only `kind` +
 * `refId`; the label and the link are resolved here at read time with one
 * batched query per target type, so a renamed note shows its current title and
 * a deleted target renders greyed with the space link only.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const SOURCE_KINDS = new Set(['source.added', 'source.ready', 'source.failed']);
const NOTE_KINDS = new Set(['note.saved_answer', 'note.created', 'note.edited', 'note.converted']);
/** `refId` is the affected user's id — except `member.invited`, whose `refId` is the invite. */
const MEMBER_USER_KINDS = new Set([
  'member.joined',
  'member.removed',
  'member.left',
  'member.role_changed',
  'space.ownership_transferred',
]);
const MEMBER_KINDS = new Set([...MEMBER_USER_KINDS, 'member.invited']);

type ActivityRow = {
  id: string;
  kind: string;
  userId: string;
  spaceId: string | null;
  refId: string | null;
  createdAt: Date;
};
type Target = { type: 'space' | 'source' | 'note' | 'notebook' | 'user'; id: string; title: string };

/** The link for a row, per the table in the Phase 7 design. */
export function activityHref(row: Pick<ActivityRow, 'kind' | 'spaceId' | 'refId'>, targetExists: boolean): string | null {
  const { kind, spaceId, refId } = row;
  if (!spaceId) return null;
  const space = `/spaces/${spaceId}`;
  if (kind === 'space.created' || kind === 'space.audience_changed') return space;
  if (SOURCE_KINDS.has(kind)) return targetExists && refId ? `${space}/sources/${refId}` : space;
  if (NOTE_KINDS.has(kind)) return targetExists && refId ? `${space}/notes?noteId=${refId}` : space;
  if (kind === 'note.deleted') return `${space}/notes`;
  if (kind === 'notebook.exported') return `${space}/notebook`;
  if (MEMBER_KINDS.has(kind)) return `${space}/members`;
  return space;
}

/** Batched lookups: one query per target type over the page, keyed by id. */
async function resolveTargets(prisma: PrismaClient, rows: ActivityRow[]) {
  const ids = (pred: (r: ActivityRow) => boolean) =>
    [...new Set(rows.filter(pred).map((r) => r.refId).filter((id): id is string => !!id))];
  const spaceIds = [...new Set(rows.map((r) => r.spaceId).filter((id): id is string => !!id))];
  const sourceIds = ids((r) => SOURCE_KINDS.has(r.kind));
  const noteIds = ids((r) => NOTE_KINDS.has(r.kind));
  const notebookIds = ids((r) => r.kind === 'notebook.exported');
  const inviteIds = ids((r) => r.kind === 'member.invited');
  // Actors on every row, plus the members that membership events are about.
  const userIds = [...new Set([...rows.map((r) => r.userId), ...ids((r) => MEMBER_USER_KINDS.has(r.kind))])];

  const [spaces, sources, notes, notebooks, users, invites] = await Promise.all([
    spaceIds.length
      ? prisma.space.findMany({ where: { id: { in: spaceIds } }, select: { id: true, name: true, archivedAt: true } })
      : [],
    sourceIds.length
      ? prisma.source.findMany({ where: { id: { in: sourceIds } }, select: { id: true, title: true } })
      : [],
    noteIds.length ? prisma.note.findMany({ where: { id: { in: noteIds } }, select: { id: true, title: true } }) : [],
    notebookIds.length ? prisma.notebook.findMany({ where: { id: { in: notebookIds } }, select: { id: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    inviteIds.length
      ? prisma.spaceInvite.findMany({ where: { id: { in: inviteIds } }, select: { id: true, email: true } })
      : [],
  ]);

  return {
    spaces: new Map(spaces.map((s) => [s.id, s])),
    sources: new Map(sources.map((s) => [s.id, s])),
    notes: new Map(notes.map((n) => [n.id, n])),
    notebooks: new Set(notebooks.map((n) => n.id)),
    users: new Map(users.map((u) => [u.id, u])),
    invites: new Map(invites.map((i) => [i.id, i])),
  };
}

function targetFor(row: ActivityRow, lookups: Awaited<ReturnType<typeof resolveTargets>>): Target | null {
  const { kind, refId, spaceId } = row;
  if (kind === 'space.created' || kind === 'space.audience_changed') {
    const space = spaceId ? lookups.spaces.get(spaceId) : undefined;
    return space ? { type: 'space', id: space.id, title: space.name } : null;
  }
  if (!refId) return null;
  if (SOURCE_KINDS.has(kind)) {
    const source = lookups.sources.get(refId);
    return source ? { type: 'source', id: source.id, title: source.title } : null;
  }
  if (NOTE_KINDS.has(kind) || kind === 'note.deleted') {
    const note = lookups.notes.get(refId);
    return note ? { type: 'note', id: note.id, title: note.title } : null;
  }
  if (kind === 'notebook.exported') {
    return lookups.notebooks.has(refId) ? { type: 'notebook', id: refId, title: 'Notebook' } : null;
  }
  if (MEMBER_USER_KINDS.has(kind)) {
    const user = lookups.users.get(refId);
    return user ? { type: 'user', id: user.id, title: user.name } : null;
  }
  if (kind === 'member.invited') {
    const invite = lookups.invites.get(refId);
    return invite ? { type: 'user', id: invite.id, title: invite.email } : null;
  }
  return null;
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)_([A-Za-z0-9]+)$/;

function parseCursor(cursor: string): { createdAt: Date; id: string } {
  const match = CURSOR.exec(cursor);
  const createdAt = match ? new Date(match[1]!) : new Date(NaN);
  if (!match || Number.isNaN(createdAt.getTime())) {
    throw badRequest('That activity cursor is not valid.', 'invalid_cursor');
  }
  return { createdAt, id: match[2]! };
}

const activityItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  createdAt: z.string(),
  /** Who did it; null once that account is gone. */
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  space: z.object({ id: z.string(), name: z.string(), archivedAt: z.string().nullable() }).nullable(),
  target: z
    .object({ type: z.enum(['space', 'source', 'note', 'notebook', 'user']), id: z.string(), title: z.string() })
    .nullable(),
  href: z.string().nullable(),
});

const querySchema = z.object({
  // Clamped, not rejected (design "§15"): an out-of-range page size is
  // a client being greedy, not a malformed request.
  limit: z.coerce
    .number()
    .int()
    .default(DEFAULT_LIMIT)
    .transform((n) => Math.min(MAX_LIMIT, Math.max(1, n))),
  cursor: z.string().optional(),
});

const responseSchema = z.object({ items: z.array(activityItemSchema), nextCursor: z.string().nullable() });

/** One page of a feed under `scope`, resolved. Shared by the Home and space feeds. */
async function pageFeed(
  prisma: PrismaClient,
  scope: Prisma.ActivityWhereInput,
  query: { limit: number; cursor?: string | undefined },
) {
  const { limit } = query;
  const cursor = query.cursor ? parseCursor(query.cursor) : null;

  const rows = await prisma.activity.findMany({
    where: {
      AND: [
        scope,
        cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const lookups = await resolveTargets(prisma, page);

  const items = page.map((row) => {
    const space = row.spaceId ? lookups.spaces.get(row.spaceId) : undefined;
    const target = targetFor(row, lookups);
    return {
      id: row.id,
      kind: row.kind,
      createdAt: row.createdAt.toISOString(),
      actor: lookups.users.get(row.userId) ?? null,
      space: space ? { id: space.id, name: space.name, archivedAt: space.archivedAt?.toISOString() ?? null } : null,
      target,
      href: space ? activityHref(row, target !== null) : null,
    };
  });

  const last = rows.length > limit ? page[page.length - 1] : undefined;
  return { items, nextCursor: last ? `${last.createdAt.toISOString()}_${last.id}` : null };
}

const activityRoutes: FastifyPluginAsyncZod = async (app) => {
  const readRateLimit = { rateLimit: { max: 600, timeWindow: '1 minute' } };

  app.get(
    '/activity',
    {
      onRequest: [app.requireUser],
      config: readRateLimit,
      schema: { querystring: querySchema, response: { 200: responseSchema } },
    },
    async (request, reply) => {
      const me = request.user!.id;
      // My own actions, plus the membership events that are *about* me — being
      // invited is by email, so it cannot match; joining, removal, role changes
      // and transfers can. The query never takes a space id, so there is no
      // access check to forget.
      return reply.send(
        await pageFeed(
          app.prisma,
          { OR: [{ userId: me }, { refId: me, kind: { startsWith: 'member.' } }, { refId: me, kind: 'space.ownership_transferred' }] },
          request.query,
        ),
      );
    },
  );

  app.get(
    '/spaces/:id/activity',
    {
      onRequest: [app.requireUser],
      preHandler: [assertAccess('space', 'id', 'viewer')],
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        querystring: querySchema,
        response: { 200: responseSchema },
      },
    },
    async (request, reply) => {
      // Everyone's actions in one space, for any member: what happened while I
      // was away (shared-spaces-v1 "Activity").
      return reply.send(await pageFeed(app.prisma, { spaceId: request.params.id }, request.query));
    },
  );
};

export default activityRoutes;
