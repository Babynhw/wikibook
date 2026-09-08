import type { FastifyRequest } from 'fastify';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import type { PrismaClient, SpaceRole } from '../generated/prisma/client.js';

/**
 * Every resource in WikiBookLM hangs off a Space, and access to a Space is a
 * `SpaceMember` row (wiki-docs/plan/shared-spaces-v1/design.md "Access"). These
 * resolvers map a resource id to its space — and, for the two resources that are
 * private to one member, to that member.
 *
 * Disclosure rule (PRD §17, kept): a non-member is answered 404, never 403 — a
 * 403 would confirm the id exists. A *member* below the role a route needs gets
 * 403: they already know the space exists, and a 404 on "Add source" would read
 * as a bug rather than a permission.
 */
export type OwnedResource =
  | 'space'
  | 'source'
  | 'conversation'
  | 'message'
  | 'note'
  | 'notebook'
  | 'citation'
  | 'passage';

/** Where a resource lives, and — for private resources — whose it is. */
interface Located {
  spaceId: string;
  /** Set only for conversations and messages: the member who owns the thread. */
  userId?: string | null;
}

type Resolver = (prisma: PrismaClient, id: string) => Promise<Located | null>;

const resolvers: Record<OwnedResource, Resolver> = {
  space: async (prisma, id) => {
    const row = await prisma.space.findUnique({ where: { id }, select: { id: true } });
    return row ? { spaceId: row.id } : null;
  },
  source: async (prisma, id) => {
    const row = await prisma.source.findUnique({ where: { id }, select: { spaceId: true } });
    return row ? { spaceId: row.spaceId } : null;
  },
  conversation: async (prisma, id) => {
    const row = await prisma.conversation.findUnique({
      where: { id },
      select: { spaceId: true, userId: true },
    });
    return row ? { spaceId: row.spaceId, userId: row.userId } : null;
  },
  message: async (prisma, id) => {
    const row = await prisma.message.findUnique({
      where: { id },
      select: { conversation: { select: { spaceId: true, userId: true } } },
    });
    return row ? { spaceId: row.conversation.spaceId, userId: row.conversation.userId } : null;
  },
  note: async (prisma, id) => {
    const row = await prisma.note.findUnique({ where: { id }, select: { spaceId: true } });
    return row ? { spaceId: row.spaceId } : null;
  },
  passage: async (prisma, id) => {
    const row = await prisma.passage.findUnique({
      where: { id },
      select: { source: { select: { spaceId: true } } },
    });
    return row ? { spaceId: row.source.spaceId } : null;
  },
  // A citation always names a source, and that is the shortest path to a space:
  // `messageId` and `noteId` are both nullable, so neither can carry the check.
  citation: async (prisma, id) => {
    const row = await prisma.citation.findUnique({
      where: { id },
      select: { source: { select: { spaceId: true } } },
    });
    return row ? { spaceId: row.source.spaceId } : null;
  },
  notebook: async (prisma, id) => {
    const row = await prisma.notebook.findUnique({ where: { id }, select: { spaceId: true } });
    return row ? { spaceId: row.spaceId } : null;
  },
};

/** Resolves the space a resource belongs to, or null when it does not exist. */
export function resolveLocation(
  prisma: PrismaClient,
  resource: OwnedResource,
  id: string,
): Promise<Located | null> {
  return resolvers[resource](prisma, id);
}

/** owner > editor > viewer — the whole permission matrix is this order. */
export const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, owner: 2 };

export const roleAtLeast = (role: SpaceRole, min: SpaceRole) => ROLE_RANK[role] >= ROLE_RANK[min];

export const INSUFFICIENT_ROLE_MESSAGE = 'You can view this space but not change it.';

/**
 * Looks up the caller's role in a space. Null when they are not a member —
 * which every route must answer as 404.
 */
export async function memberRole(
  prisma: PrismaClient,
  spaceId: string,
  userId: string,
): Promise<SpaceRole | null> {
  const row = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId } },
    select: { role: true },
  });
  return row?.role ?? null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by {@link assertAccess}: the space the guarded resource lives in and
     * the caller's role there, so a handler that needs a resource-level rule
     * (an editor deleting only their own source) does not query membership twice.
     */
    access?: { spaceId: string; role: SpaceRole };
  }
}

/**
 * Every guard `assertAccess` hands out is registered here so a test can walk
 * the route table and prove each parameterised route carries one, and with
 * which role (`test/ownership-table.test.ts`). A WeakMap: no reference is kept
 * alive, and the value is the role the route declared.
 */
export const ownershipGuards = new WeakMap<object, SpaceRole>();

/**
 * Builds a Fastify preHandler asserting the signed-in user is a member of the
 * space the resource named by a route param belongs to, with at least
 * `minRole`. Every resource route must register one — PRD §17 made it a hard
 * requirement for ownership and shared spaces keep it for membership.
 *
 *   app.post('/spaces/:id/sources', {
 *     preHandler: [app.requireUser, assertAccess('space', 'id', 'editor')],
 *   }, handler)
 *
 * Reads default to `viewer`; every write must say `editor` or `owner`.
 * Conversations and messages additionally belong to one member: another
 * member's thread is 404, because an id you were never shown is not something
 * you know exists.
 */
export function assertAccess(resource: OwnedResource, param = 'id', minRole: SpaceRole = 'viewer') {
  const guard = async function accessPreHandler(request: FastifyRequest) {
    if (!request.user) throw unauthorized();

    const params = request.params as Record<string, string | undefined>;
    const id = params[param];
    if (!id) throw notFound();

    const located = await resolveLocation(request.server.prisma, resource, id);
    if (!located) throw notFound();

    const role = await memberRole(request.server.prisma, located.spaceId, request.user.id);
    if (role === null) throw notFound();
    if (located.userId !== undefined && located.userId !== request.user.id) throw notFound();
    if (!roleAtLeast(role, minRole)) throw forbidden(INSUFFICIENT_ROLE_MESSAGE, 'insufficient_role');

    request.access = { spaceId: located.spaceId, role };
  };
  ownershipGuards.set(guard, minRole);
  return guard;
}
