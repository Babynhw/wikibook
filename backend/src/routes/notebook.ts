import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertAccess } from '../middleware/assert-access.js';
import type { SpaceRole } from '../generated/prisma/client.js';
import { EMPTY_DOC, validateNotebookDoc } from '../notebook/validate-doc.js';
import { collectCitations, filenameSlug, serializeNotebook } from '../notebook/markdown.js';
import { ARCHIVED_MESSAGE } from './spaces.js';

/**
 * Phase 6: the space's single notebook (PRD §13) and its export (§14).
 *
 * The row is lazy-created on first read — Phase 1's decision, executed here —
 * and written whole on every save. A save carries the `updatedAt` it was based
 * on, so a stale tab cannot silently overwrite a newer document: the mismatch
 * is a 409 that hands back what the server has. Export is read-only against
 * the notebook; the only thing it writes is the activity row Phase 7 reads.
 */

const notebookSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  contentRich: z.unknown(),
  /** Who last saved — the 409 conflict dialog names them (shared-spaces-v1). */
  updatedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const notebookSelect = {
  id: true,
  spaceId: true,
  contentRich: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true } },
} as const;

type NotebookRow = {
  id: string;
  spaceId: string;
  contentRich: unknown;
  updatedBy: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
};

function serialize(notebook: NotebookRow) {
  return {
    id: notebook.id,
    spaceId: notebook.spaceId,
    contentRich: notebook.contentRich,
    updatedBy: notebook.updatedBy,
    createdAt: notebook.createdAt.toISOString(),
    updatedAt: notebook.updatedAt.toISOString(),
  };
}

const CONFLICT_MESSAGE =
  'This notebook was changed somewhere else — in another tab, perhaps. Reload to see the latest, or keep yours to overwrite it.';

const notebookRoutes: FastifyPluginAsyncZod = async (app) => {
  const readRateLimit = { rateLimit: { max: 600, timeWindow: '1 minute' } };
  // Autosave fires at most once per idle pause, so 120/minute is two saves a
  // second sustained — well above a person, low enough to stop a runaway loop.
  const writeRateLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } };

  const ownedSpace = (role: SpaceRole = 'viewer') => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('space', 'id', role)],
  });

  /** Idempotent under concurrent first opens: `spaceId` is unique, so the upsert converges. */
  async function loadOrCreate(spaceId: string): Promise<NotebookRow> {
    return app.prisma.notebook.upsert({
      where: { spaceId },
      create: { spaceId, contentRich: EMPTY_DOC },
      update: {},
      select: notebookSelect,
    });
  }

  // --- Read (lazy-create) ----------------------------------------------------
  app.get(
    '/spaces/:id/notebook',
    {
      ...ownedSpace(),
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ notebook: notebookSchema }) },
      },
    },
    async (request, reply) => {
      const notebook = await loadOrCreate(request.params.id);
      return reply.send({ notebook: serialize(notebook) });
    },
  );

  // --- Save (whole document, optimistic on updatedAt) -----------------------
  app.put(
    '/spaces/:id/notebook',
    {
      ...ownedSpace('editor'),
      config: writeRateLimit,
      // A server safety bound on the JSON body, not a §5 product limit — hence
      // `env`, not `AppConfig` (design "Whole-document PUT").
      bodyLimit: env.NOTEBOOK_BODY_LIMIT_BYTES,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          contentRich: z.unknown(),
          baseUpdatedAt: z.string().datetime(),
        }),
        response: {
          200: z.object({ notebook: notebookSchema }),
          // The conflict carries the server's document so the client can offer
          // "Reload" without a second round trip.
          409: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
            notebook: notebookSchema.optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const space = await app.prisma.space.findUnique({
        where: { id: spaceId },
        select: { archivedAt: true },
      });
      if (!space) throw notFound();
      if (space.archivedAt) throw conflict(ARCHIVED_MESSAGE, 'space_archived');

      const { contentRich, baseUpdatedAt } = request.body;
      const valid = validateNotebookDoc(contentRich);
      if (!valid.ok) {
        throw badRequest(
          'The notebook could not be saved because its content is not in a form the editor produces.',
          'invalid_document',
          { [valid.path]: valid.reason },
        );
      }

      const current = await loadOrCreate(spaceId);
      const base = new Date(baseUpdatedAt);
      // The compare-and-set is the `updatedAt` in the WHERE: a concurrent save
      // that landed between our read and this write leaves `count` at 0.
      const result = await app.prisma.notebook.updateMany({
        where: { id: current.id, updatedAt: base },
        data: { contentRich: contentRich as object, updatedById: request.user!.id },
      });
      if (result.count === 0) {
        const latest = await app.prisma.notebook.findUniqueOrThrow({
          where: { id: current.id },
          select: notebookSelect,
        });
        return reply.status(409).send({
          error: { code: 'notebook_conflict', message: CONFLICT_MESSAGE },
          notebook: serialize(latest),
        });
      }
      const saved = await app.prisma.notebook.findUniqueOrThrow({
        where: { id: current.id },
        select: notebookSelect,
      });
      return reply.send({ notebook: serialize(saved) });
    },
  );

  // --- Presence (shared-spaces-v1 "Notebook presence") -----------------------
  // Advisory only: a heartbeat while an editor has the notebook open in edit
  // mode, kept in Redis under a short TTL and fanned out on the space's SSE
  // channel. Nothing is locked; the compare-and-set save stays the arbiter.
  const presenceKey = (spaceId: string) => `notebook:editing:${spaceId}`;

  type PresenceUser = { id: string; name: string };

  /**
   * Presence is a nicety, and Redis is optional everywhere else in this app —
   * `/health` reports it degraded, the SSE stream falls back to polling. A blip
   * must not turn a notebook request into a 500, so every path answers "nobody
   * is editing" instead.
   */
  async function withPresenceFallback<T>(spaceId: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      app.log.warn({ err: error, spaceId }, 'notebook presence unavailable');
      return fallback;
    }
  }

  /**
   * The current editors, expiring stale entries on the way. `pruned` counts the
   * entries that aged out: the caller publishes when it is non-zero, because
   * nothing else will. A tab that dies sends no `DELETE`, and a member who is
   * only *watching* — a viewer, or an editor who stopped typing — learns about
   * the set from the channel alone, so without this their indicator would name
   * someone who left until they reloaded.
   */
  async function readPresence(spaceId: string): Promise<{ users: PresenceUser[]; pruned: number }> {
    return withPresenceFallback(spaceId, { users: [], pruned: 0 }, async () => {
      const key = presenceKey(spaceId);
      const cutoff = Date.now() - env.NOTEBOOK_PRESENCE_TTL_SECONDS * 1000;
      const pruned = await app.redis.zremrangebyscore(key, '-inf', String(cutoff));
      const ids = await app.redis.zrange(key, '0', '-1');
      if (ids.length === 0) return { users: [], pruned };
      const users = await app.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      // Sorted by name, not by Redis order: the score is the last heartbeat, so
      // the set reorders every few seconds and the indicator would reshuffle
      // under a reader who has not moved.
      return {
        users: users.sort((a, b) => a.name.localeCompare(b.name)),
        pruned,
      };
    });
  }

  const announce = (spaceId: string, users: PresenceUser[]) =>
    app.events.publish(`space:${spaceId}`, { type: 'notebook.presence', users });

  /** Reads the set and tells the space's channel about it. */
  async function publishPresence(spaceId: string): Promise<PresenceUser[]> {
    const { users } = await readPresence(spaceId);
    await announce(spaceId, users);
    return users;
  }

  const presenceSchema = z.object({ users: z.array(z.object({ id: z.string(), name: z.string() })) });

  app.get(
    '/spaces/:id/notebook/presence',
    {
      ...ownedSpace(),
      config: readRateLimit,
      schema: { params: z.object({ id: z.string() }), response: { 200: presenceSchema } },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const { users, pruned } = await readPresence(spaceId);
      // Someone's heartbeat stopped without a `DELETE`. This read is the only
      // place that notices, so it is the only place that can tell the others.
      if (pruned > 0) await announce(spaceId, users);
      return reply.send({ users });
    },
  );

  app.post(
    '/spaces/:id/notebook/presence',
    {
      ...ownedSpace('editor'),
      // A heartbeat every 10 s per tab; not a user action, so no write budget.
      config: { rateLimit: false },
      schema: { params: z.object({ id: z.string() }), response: { 200: presenceSchema } },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const key = presenceKey(spaceId);
      await withPresenceFallback(spaceId, null, async () => {
        await app.redis
          .multi()
          .zadd(key, Date.now(), request.user!.id)
          .expire(key, env.NOTEBOOK_PRESENCE_TTL_SECONDS * 2)
          .exec();
        return null;
      });
      return reply.send({ users: await publishPresence(spaceId) });
    },
  );

  app.delete(
    '/spaces/:id/notebook/presence',
    {
      ...ownedSpace('editor'),
      config: { rateLimit: false },
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request, reply) => {
      await withPresenceFallback(request.params.id, null, async () => {
        await app.redis.zrem(presenceKey(request.params.id), request.user!.id);
        return null;
      });
      await publishPresence(request.params.id);
      return reply.status(204).send();
    },
  );

  // --- Export as Markdown (PRD §14) ------------------------------------------
  app.get(
    '/spaces/:id/notebook/export.md',
    {
      ...ownedSpace(),
      config: readRateLimit,
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const space = await app.prisma.space.findUnique({
        where: { id: spaceId },
        select: { name: true, objective: true },
      });
      if (!space) throw notFound();
      const notebook = await loadOrCreate(spaceId);

      const cited = collectCitations(notebook.contentRich);
      const ids = [...new Set(cited.map((c) => c.sourceId))];
      const rows = ids.length
        ? await app.prisma.source.findMany({
            where: { id: { in: ids }, spaceId },
            select: { id: true, title: true, author: true, url: true },
          })
        : [];
      const markdown = serializeNotebook({
        spaceName: space.name,
        objective: space.objective,
        doc: notebook.contentRich,
        sources: new Map(rows.map((row) => [row.id, row])),
      });

      await app.prisma.activity.create({
        data: {
          userId: request.user!.id,
          spaceId,
          kind: 'notebook.exported',
          refId: notebook.id,
        },
      });

      const filename = `${filenameSlug(space.name)}-notebook.md`;
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(markdown);
    },
  );
};

export default notebookRoutes;
