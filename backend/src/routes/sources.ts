import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import { loadLimits } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { keyFor, getObject, putObject, removeObject } from '../lib/storage.js';
import { enqueueOrFail } from '../lib/enqueue-ingest.js';
import { assertAccess } from '../middleware/assert-access.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SpaceRole } from '../generated/prisma/client.js';
import { ARCHIVED_MESSAGE } from './spaces.js';

const sourceSelect = {
  id: true,
  spaceId: true,
  type: true,
  title: true,
  author: true,
  url: true,
  state: true,
  errorMessage: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  addedBy: { select: { id: true, name: true } },
} as const;

const sourceSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  type: z.enum(['pdf', 'web', 'manual']),
  title: z.string(),
  author: z.string().nullable(),
  url: z.string().nullable(),
  state: z.enum(['processing', 'ready', 'failed']),
  errorMessage: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Who brought the evidence in; null once that account is gone (shared-spaces-v1). */
  addedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});

type SourceRow = {
  id: string;
  spaceId: string;
  type: 'pdf' | 'web' | 'manual';
  title: string;
  author: string | null;
  url: string | null;
  state: 'processing' | 'ready' | 'failed';
  errorMessage: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  addedBy: { id: string; name: string } | null;
};

/** Dates cross the wire as ISO strings. */
function serializeSource(source: SourceRow) {
  return {
    id: source.id,
    spaceId: source.spaceId,
    type: source.type,
    title: source.title,
    author: source.author,
    url: source.url,
    state: source.state,
    errorMessage: source.errorMessage,
    archivedAt: source.archivedAt ? source.archivedAt.toISOString() : null,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
    addedBy: source.addedBy,
  };
}

const manualTitleSchema = z
  .string()
  .trim()
  .min(1, 'Give this text a title.')
  .max(200, 'Use at most 200 characters.');

/** Non-empty content; the character cap is a runtime limit, checked in-handler. */
const manualContentSchema = z
  .string()
  .trim()
  .min(1, 'Add some text to make into a source.');

const manualAuthorSchema = z
  .string()
  .trim()
  .max(120, 'Use at most 120 characters.')
  .transform((value) => (value.length === 0 ? null : value));

/** A valid http(s) address; the SSRF guard runs in the worker before fetching. */
const webUrlSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          message: 'Only http:// and https:// web addresses can be added.',
        });
        return z.NEVER;
      }
      return value;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid web address.' });
      return z.NEVER;
    }
  });

const createBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('web'), url: webUrlSchema }),
  z.object({
    type: z.literal('manual'),
    title: manualTitleSchema,
    content: manualContentSchema,
    author: manualAuthorSchema.optional(),
  }),
]);

/**
 * `archived` is two-valued on purpose: PRD §7 says archived sources must be
 * absent "unless the user explicitly views archived sources", and an `include`
 * option would be exactly the ambiguity that sentence forbids.
 */
const listQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
  type: z.enum(['pdf', 'web', 'manual']).optional(),
  archived: z.enum(['exclude', 'only']).default('exclude'),
});

/**
 * Title and author or publisher — PRD §7/§8's "basic source metadata". `.strict()`
 * is load-bearing: an attempt to `PATCH` `content`, `state`, or `type` is a 400,
 * not a silently dropped field.
 */
const patchBodySchema = z
  .object({
    title: manualTitleSchema,
    // `.nullable().optional()`, not `.nullish().transform(… ?? null)`: the transform
    // turns an absent key into an explicit `null`, and Zod keeps a null in the parsed
    // body — so a `PATCH` sending only a title would erase a stored author. An
    // omitted author has to stay `undefined` to mean "not supplied". Clearing it is
    // `null` or `''`, which `manualAuthorSchema` already maps to `null`.
    author: manualAuthorSchema.nullable().optional(),
  })
  .strict();

/** What the reader renders: one located block of the source's extracted text. */
const blockSchema = z.object({
  ord: z.number().int(),
  text: z.string(),
  page: z.number().int().nullable(),
  paragraphIndex: z.number().int().nullable(),
  heading: z.string().nullable(),
});

const outlineSchema = z.object({
  blockCount: z.number().int(),
  /** The highest page number, or null for a source with no page data (§8). */
  pageCount: z.number().int().nullable(),
  headings: z.array(
    z.object({ ord: z.number().int(), page: z.number().int().nullable(), heading: z.string() }),
  ),
});

/** A passage's location — the reader's highlight target, with no passage text. */
const passageLocationSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  ord: z.number().int(),
  page: z.number().int().nullable(),
  paragraphRef: z.string().nullable(),
  sectionHeading: z.string().nullable(),
  startBlockOrd: z.number().int().nullable(),
  endBlockOrd: z.number().int().nullable(),
});

const sourceDetailSchema = sourceSchema.extend({
  blockCount: z.number().int(),
  pageCount: z.number().int().nullable(),
});

const blocksQuerySchema = z.object({
  /** PDF mode: every block on this page. */
  page: z.coerce.number().int().positive().optional(),
  /** Window mode: from this block ordinal onwards. */
  from: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/**
 * The reader's window size, and its ceiling. A safety valve on a query rather
 * than an operator-tunable product limit, so it is a constant here and not an
 * `AppConfig` key — the same line PRD §5's limits drew for the web fetch's caps
 * (wiki-docs/plan/phase-3-library-reader/design.md "No new activity types…").
 */
const BLOCK_WINDOW = 120;
const BLOCK_WINDOW_MAX = 400;

/** A hard ceiling on a result set the product already caps at 50 (PRD §5). */
const SEARCH_LIMIT = 200;

/**
 * PRD §7's search, as one query with a tiered order:
 *
 * 1. `metadata` — the title or author matched. §7 requires title matches to rank
 *    *above* content-only matches, so it leads the `ORDER BY`. A blended
 *    `setweight` ranking could only make that usually true, which is not what
 *    the requirement says (design "Ranking is tiered, not blended").
 * 2. `ts_rank` over the passage index, which is the only guaranteed-searchable
 *    copy of the extracted text.
 * 3. The list's existing newest-first order, as the tiebreak.
 *
 * Metadata matching is `ILIKE` rather than FTS: at §5's ceiling of 50 sources
 * per space it is a scan of 50 short strings, and it matches the substrings a
 * user types. The cost is no stemming on titles, covered by the content tier.
 * `websearch_to_tsquery` never throws on user input, unlike `to_tsquery`.
 */
async function searchSourceIds(
  app: FastifyInstance,
  spaceId: string,
  q: string,
  filters: { type?: 'pdf' | 'web' | 'manual'; archived: 'exclude' | 'only' },
): Promise<string[]> {
  // `%` and `_` are ILIKE wildcards, so a query containing them must not become
  // a pattern the user did not write.
  const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const metadata = Prisma.sql`(s."title" ILIKE ${pattern} OR COALESCE(s."author", '') ILIKE ${pattern})`;

  const rows = await app.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT s."id", ${metadata} AS metadata_match
    FROM "Source" s
    CROSS JOIN websearch_to_tsquery('english', ${q}) AS tsq(query)
    LEFT JOIN LATERAL (
      SELECT MAX(ts_rank(p."tsv", tsq.query)) AS rank
      FROM "Passage" p
      WHERE p."sourceId" = s."id" AND p."tsv" @@ tsq.query
    ) content ON TRUE
    WHERE s."spaceId" = ${spaceId}
      AND ${
        filters.archived === 'only'
          ? Prisma.sql`s."archivedAt" IS NOT NULL`
          : Prisma.sql`s."archivedAt" IS NULL`
      }
      ${filters.type ? Prisma.sql`AND s."type" = ${filters.type}::"SourceType"` : Prisma.empty}
      AND (${metadata} OR content.rank IS NOT NULL)
    ORDER BY metadata_match DESC, COALESCE(content.rank, 0) DESC, s."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `);

  return rows.map((row) => row.id);
}

const sourcesRoutes: FastifyPluginAsyncZod = async (app) => {
  const writeRateLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
  /** Searching is one request per settled query, so reads need their own headroom. */
  const readRateLimit = { rateLimit: { max: 600, timeWindow: '1 minute' } };

  /**
   * Factories, not shared objects: `@fastify/rate-limit` *pushes* its hook into
   * `routeOptions.onRequest`, so a single array reused across routes accumulates
   * every route's limiter and applies all of them to each route. That is how this
   * file's read routes inherited the writes' 60/minute cap — a search box started
   * answering 429 after sixty queries. Each route now gets its own arrays.
   */
  const ownedSpace = (role: SpaceRole = 'viewer') => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('space', 'id', role)],
  });
  const ownedSource = (role: SpaceRole = 'viewer') => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('source', 'id', role)],
  });

  /**
   * A source write inside an archived space is refused with Phase 1's message —
   * the frozen-space rule (REQ-100). Archiving a source is not clean-up in the
   * sense `DELETE` is: it changes what the space's evidence *is*, which is what
   * freezing prevents. `GET` and `DELETE` stay allowed.
   */
  const assertSourceWritable = async (sourceId: string): Promise<SourceRow> => {
    const source = await app.prisma.source.findUnique({
      where: { id: sourceId },
      select: { ...sourceSelect, space: { select: { archivedAt: true } } },
    });
    if (!source) throw notFound();
    if (source.space.archivedAt) throw conflict(ARCHIVED_MESSAGE, 'space_archived');
    const { space: _space, ...row } = source;
    return row;
  };

  /**
   * The two refusals every create shares: an archived space is frozen for
   * writes, and `sources_per_space` is read live from `AppConfig` (PRD §5).
   *
   * Run against a transaction client this is the authority; run against the
   * plain client it is an advisory pre-check, which is why the upload route can
   * use it to refuse *before* streaming a file into the object store without the
   * in-transaction check becoming redundant. Both paths raise the same errors,
   * so a request cannot tell which one caught it.
   */
  const assertSpaceAcceptsSource = async (
    db: Prisma.TransactionClient | typeof app.prisma,
    spaceId: string,
  ): Promise<void> => {
    const limits = await loadLimits(app.prisma);
    const space = await db.space.findUnique({
      where: { id: spaceId },
      select: { archivedAt: true },
    });
    if (space?.archivedAt) throw conflict(ARCHIVED_MESSAGE, 'space_archived');

    const count = await db.source.count({ where: { spaceId, archivedAt: null } });
    if (count >= limits.sources_per_space) {
      throw conflict(
        `This space already has ${count} sources. Delete one or raise the limit.`,
        'sources_limit',
      );
    }
  };

  /**
   * The shared write path: prove the space is not archived and under its source
   * limit inside the create transaction, write the row and the `source.added`
   * activity atomically, then enqueue the job. A failed enqueue leaves the
   * source visibly `failed` with a message the Retry action can recover from —
   * an invisible `processing` row with no job behind it would be a trap.
   */
  const createSource = async (
    spaceId: string,
    userId: string,
    data: Prisma.SourceUncheckedCreateInput,
  ): Promise<{ row: SourceRow; started: boolean }> => {
    const created = await app.prisma.$transaction(async (tx) => {
      await assertSpaceAcceptsSource(tx, spaceId);

      // The caller is the actor on the row as well as on the activity.
      const row = await tx.source.create({ data: { ...data, addedById: userId }, select: sourceSelect });
      await tx.activity.create({
        data: { userId, spaceId, kind: 'source.added', refId: row.id },
      });
      return row;
    });

    const started = await enqueueOrFail(app, created.id, spaceId, userId);
    // enqueueOrFail may have marked the source failed; return the current row.
    const final = await app.prisma.source.findUnique({
      where: { id: created.id },
      select: sourceSelect,
    });
    return { row: final ?? created, started };
  };

  app.post(
    '/spaces/:id/sources',
    {
      ...ownedSpace('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: createBodySchema,
        response: { 201: z.object({ source: sourceSchema }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const userId = request.user!.id;
      const body = request.body;

      const data: Prisma.SourceUncheckedCreateInput =
        body.type === 'web'
          ? { spaceId, type: 'web', title: body.url, url: body.url, state: 'processing' }
          : {
              spaceId,
              type: 'manual',
              title: body.title,
              author: body.author ?? null,
              content: body.content,
              state: 'processing',
            };

      if (data.type === 'manual') {
        const limits = await loadLimits(app.prisma);
        if ((data.content ?? '').length > limits.manual_max_chars) {
          throw badRequest(
            `Text is limited to ${limits.manual_max_chars} characters.`,
            'manual_too_long',
            { content: `Text is limited to ${limits.manual_max_chars} characters.` },
          );
        }
      }

      const { row } = await createSource(spaceId, userId, data);
      return reply.status(201).send({ source: serializeSource(row) });
    },
  );

  app.post(
    '/spaces/:id/sources/upload',
    {
      ...ownedSpace('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 201: z.object({ source: sourceSchema }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const userId = request.user!.id;

      const file = await request.file();
      if (!file) {
        throw badRequest('Choose a PDF file to upload.', 'pdf_required', {
          file: 'Choose a PDF file.',
        });
      }
      if (!isPdfFile(file)) {
        // Leave the unread part draining so the connection is released.
        file.file.resume();
        throw badRequest('Only PDF files can be uploaded.', 'not_a_pdf', {
          file: 'Only PDF files can be uploaded.',
        });
      }

      // Refuse before the body reaches the object store: an archived space or a
      // space at its limit would otherwise pay a full `pdf_max_bytes` upload and
      // an object write per attempt, and the compensating delete below is a
      // second network call that can fail. The create transaction re-checks
      // both, so this is an early exit, not the guarantee.
      try {
        await assertSpaceAcceptsSource(app.prisma, spaceId);
      } catch (error) {
        // Same as the not-a-PDF branch: drain the unread part so the connection
        // is released rather than reset under the client.
        file.file.resume();
        throw error;
      }

      const sourceId = randomUUID();
      const key = keyFor(spaceId, sourceId);
      const limits = await loadLimits(app.prisma);

      // The byte cap is enforced while streaming (`putObject`), never from a
      // client-supplied Content-Length; exceeding it aborts the upload with 413.
      const stored = await putObject(file.file, {
        key,
        contentType: 'application/pdf',
        filename: file.filename,
        maxBytes: limits.pdf_max_bytes,
      });
      if (stored.size === 0) {
        await removeObject(key).catch(() => {});
        throw badRequest('This PDF file is empty.', 'empty_pdf', {
          file: 'This PDF file is empty.',
        });
      }

      const titleFromFilename = file.filename.replace(/\.[^.]+$/, '').trim() || file.filename;

      let row: SourceRow;
      try {
        row = (
          await createSource(spaceId, userId, {
            id: sourceId,
            spaceId,
            type: 'pdf',
            title: titleFromFilename,
            fileKey: key,
            state: 'processing',
          })
        ).row;
      } catch (error) {
        // A rejected create (archived space, source limit) leaves the object
        // behind — remove it so the orphan does not outlive the refusal.
        await removeObject(key).catch(() => {});
        throw error;
      }

      return reply.status(201).send({ source: serializeSource(row) });
    },
  );

  app.get(
    '/spaces/:id/sources',
    {
      ...ownedSpace(),
      // Searching is one request per settled query, so a read needs its own
      // headroom — but it is still bounded: one query is one database round trip.
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        querystring: listQuerySchema,
        response: { 200: z.object({ sources: z.array(sourceSchema) }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const { q, type, archived } = request.query;
      const where = {
        spaceId,
        ...(type ? { type } : {}),
        ...(archived === 'only' ? { archivedAt: { not: null } } : { archivedAt: null }),
      };

      // No query is the same list it always was; a query is the same list, ranked
      // and narrowed (wiki-docs/plan/phase-3-library-reader/design.md "Search
      // extends the list route").
      if (q === undefined) {
        const sources = await app.prisma.source.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          select: sourceSelect,
        });
        return reply.send({ sources: sources.map(serializeSource) });
      }

      const ranked = await searchSourceIds(app, spaceId, q, { type, archived });
      if (ranked.length === 0) return reply.send({ sources: [] });

      const rows = await app.prisma.source.findMany({
        where: { id: { in: ranked } },
        select: sourceSelect,
      });
      // The database decided the order; `findMany` does not preserve `in` order,
      // so it is restored here rather than re-derived from the row contents.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const sources = ranked.flatMap((id) => {
        const row = byId.get(id);
        return row ? [serializeSource(row)] : [];
      });
      return reply.send({ sources });
    },
  );

  app.get(
    '/sources/:id',
    {
      ...ownedSource(),
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ source: sourceDetailSchema }) },
      },
    },
    async (request, reply) => {
      const source = await app.prisma.source.findUnique({
        where: { id: request.params.id },
        select: sourceSelect,
      });
      if (!source) throw notFound();

      // The reader needs its shape before it can ask for a page, so the counts
      // ride along with the source rather than costing a second round trip.
      const shape = await app.prisma.sourceBlock.aggregate({
        where: { sourceId: source.id },
        _count: { _all: true },
        _max: { page: true },
      });
      return reply.send({
        source: {
          ...serializeSource(source),
          blockCount: shape._count._all,
          pageCount: shape._max.page ?? null,
        },
      });
    },
  );

  app.patch(
    '/sources/:id',
    {
      ...ownedSource('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: patchBodySchema,
        response: { 200: z.object({ source: sourceSchema }) },
      },
    },
    async (request, reply) => {
      const sourceId = request.params.id;
      await assertSourceWritable(sourceId);

      // Title and author only. The extracted content is derived: editing it would
      // leave every passage, embedding, and citation describing the old text
      // (design "Only title and author are editable"). `PATCH` cannot reach it,
      // and the schema refuses the attempt rather than ignoring it.
      const updated = await app.prisma.source.update({
        where: { id: sourceId },
        data: {
          title: request.body.title,
          // Absent means "leave it alone"; `null` or `''` means "clear it".
          ...(request.body.author !== undefined ? { author: request.body.author } : {}),
        },
        select: sourceSelect,
      });
      return reply.send({ source: serializeSource(updated) });
    },
  );

  /**
   * Archive and restore are idempotent and non-destructive: no passage, block,
   * file, or citation is touched, and archiving an archived source answers 200
   * with the unchanged row. Archiving is what makes `retrievableSources()`'s
   * `archivedAt` filter reachable from the product (PRD §7, REQ-101).
   */
  for (const path of ['archive', 'restore'] as const) {
    const archiving = path === 'archive';
    app.post(
      `/sources/:id/${path}`,
      {
        ...ownedSource('editor'),
        config: writeRateLimit,
        schema: {
          params: z.object({ id: z.string() }),
          response: { 200: z.object({ source: sourceSchema }) },
        },
      },
      async (request, reply) => {
        const sourceId = request.params.id;
        const current = await assertSourceWritable(sourceId);

        // Idempotent: already in the requested state means nothing to write, and
        // re-stamping `archivedAt` would move a timestamp the user did not touch.
        if ((current.archivedAt === null) === !archiving) {
          return reply.send({ source: serializeSource(current) });
        }

        const updated = await app.prisma.source.update({
          where: { id: sourceId },
          data: {
            // Stamped per request, deliberately inside the handler: a `new Date()`
            // in the loop above would be evaluated once at registration, and every
            // archive for the life of the process would record the boot time.
            archivedAt: archiving ? new Date() : null,
          },
          select: sourceSelect,
        });
        return reply.send({ source: serializeSource(updated) });
      },
    );
  }

  app.get(
    '/sources/:id/outline',
    {
      ...ownedSource(),
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: outlineSchema },
      },
    },
    async (request, reply) => {
      const sourceId = request.params.id;
      const [shape, headings] = await Promise.all([
        app.prisma.sourceBlock.aggregate({
          where: { sourceId },
          _count: { _all: true },
          _max: { page: true },
        }),
        app.prisma.sourceBlock.findMany({
          where: { sourceId, heading: { not: null } },
          orderBy: { ord: 'asc' },
          select: { ord: true, page: true, heading: true },
        }),
      ]);

      // Consecutive blocks repeat the heading they sit under, so the outline
      // keeps the first block of each run — that is the one to navigate to.
      const outline: { ord: number; page: number | null; heading: string }[] = [];
      for (const block of headings) {
        if (outline[outline.length - 1]?.heading === block.heading) continue;
        outline.push({ ord: block.ord, page: block.page, heading: block.heading! });
      }

      return reply.send({
        blockCount: shape._count._all,
        pageCount: shape._max.page ?? null,
        headings: outline,
      });
    },
  );

  /**
   * A passage's location, for a reader opened at `?passage=<id>`. The reader
   * never derives a highlight from the passage's text — it asks for the block
   * range, which is the only form that cannot drift (PRD §8). Phase 4's
   * `/citations/:id/target` answers the same shape for a citation.
   */
  app.get(
    '/passages/:id',
    {
      onRequest: [app.requireUser],
      preHandler: [assertAccess('passage', 'id')],
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ passage: passageLocationSchema }) },
      },
    },
    async (request, reply) => {
      const passage = await app.prisma.passage.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          sourceId: true,
          ord: true,
          page: true,
          paragraphRef: true,
          sectionHeading: true,
          startBlockOrd: true,
          endBlockOrd: true,
        },
      });
      if (!passage) throw notFound();
      return reply.send({ passage });
    },
  );

  app.get(
    '/sources/:id/blocks',
    {
      ...ownedSource(),
      schema: {
        params: z.object({ id: z.string() }),
        querystring: blocksQuerySchema,
        response: { 200: z.object({ blocks: z.array(blockSchema) }) },
      },
    },
    async (request, reply) => {
      const sourceId = request.params.id;
      const { page, from, limit } = request.query;

      // Two modes, because the two kinds of source are shaped differently: a PDF
      // is navigated by page (§8), and a web or manual source has no pages, so it
      // is read through a window the client can aim at a deep-linked block.
      const blocks = await app.prisma.sourceBlock.findMany({
        where: {
          sourceId,
          // Given both, they narrow rather than compete: `page` selects the page and
          // `from` is a further lower bound on the ordinal. Pinned by a test, because
          // "what the two modes do together" should not be emergent.
          ...(page !== undefined ? { page } : {}),
          ...(from !== undefined ? { ord: { gte: from } } : {}),
        },
        orderBy: { ord: 'asc' },
        // A page is bounded by the document; a window is bounded here, so a
        // client cannot ask for a 200-page source in one request.
        ...(page === undefined ? { take: Math.min(limit ?? BLOCK_WINDOW, BLOCK_WINDOW_MAX) } : {}),
        select: { ord: true, text: true, page: true, paragraphIndex: true, heading: true },
      });

      return reply.send({ blocks });
    },
  );

  app.get(
    '/sources/:id/file',
    {
      ...ownedSource(),
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request, reply) => {
      const source = await app.prisma.source.findUnique({
        where: { id: request.params.id },
        select: { fileKey: true },
      });
      if (!source?.fileKey) throw notFound();

      const range = request.headers.range;
      try {
        const object = await getObject(source.fileKey, range);
        reply.header('accept-ranges', 'bytes');
        reply.header('content-type', object.contentType);
        if (object.contentLength !== undefined) reply.header('content-length', object.contentLength);
        if (range && object.contentRange) {
          reply.status(206);
          reply.header('content-range', object.contentRange);
        }
        return reply.send(object.body);
      } catch (error) {
        if (error instanceof Error && error.name === 'NoSuchKey') throw notFound();
        throw error;
      }
    },
  );

  app.post(
    '/sources/:id/retry',
    {
      ...ownedSource('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ source: sourceSchema }) },
      },
    },
    async (request, reply) => {
      const sourceId = request.params.id;
      const userId = request.user!.id;

      // One atomic statement is the guard (design "Retry reuses the source
      // row"): a double-clicked retry matches zero rows the second time, so the
      // job is enqueued once even before BullMQ's `jobId` dedupe rules in.
      const fresh = await app.prisma.$transaction(async (tx) => {
        const updated = await tx.source.updateMany({
          where: { id: sourceId, state: 'failed', space: { archivedAt: null } },
          data: { state: 'processing', errorMessage: null },
        });
        return updated.count === 1;
      });

      if (!fresh) {
        const current = await app.prisma.source.findUnique({
          where: { id: sourceId },
          select: { state: true, space: { select: { archivedAt: true } } },
        });
        if (current?.space.archivedAt) throw conflict(ARCHIVED_MESSAGE, 'space_archived');
        if (current?.state !== 'failed') {
          throw conflict('This source is not failed, so it cannot be retried.', 'source_not_failed');
        }
        throw notFound();
      }

      const source = await app.prisma.source.findUnique({
        where: { id: sourceId },
        select: sourceSelect,
      });
      if (!source) throw notFound();

      await enqueueOrFail(app, sourceId, source.spaceId, userId);
      const final = await app.prisma.source.findUnique({
        where: { id: sourceId },
        select: sourceSelect,
      });
      return reply.send({ source: serializeSource(final ?? source) });
    },
  );

  app.delete(
    '/sources/:id',
    {
      ...ownedSource('editor'),
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request, reply) => {
      const sourceId = request.params.id;
      // Deleting is how a user cleans up, so it stays allowed in an archived
      // space (design "API surface": archiving must not be a trap).
      const existing = await app.prisma.source.findUnique({
        where: { id: sourceId },
        select: { fileKey: true, addedById: true },
      });
      if (!existing) throw notFound();
      // Delete is permanent and purges the original, so it is the one act on
      // shared material an editor may only do to their own contribution; the
      // owner may do it to any (shared-spaces-v1 "Three roles").
      const { role } = request.access!;
      if (role !== 'owner' && existing.addedById !== request.user!.id) {
        throw forbidden(
          'Only the person who added this source, or the space owner, can delete it.',
          'insufficient_role',
        );
      }

      await app.prisma.$transaction(async (tx) => {
        const result = await tx.source.deleteMany({ where: { id: sourceId } });
        if (result.count === 0) throw notFound();
      });

      // The row goes first — a dangling object is recoverable, a source whose
      // file silently vanished is not (design "Object deletion is a queued
      // job"). If the enqueue fails, delete inline and log the key on failure.
      if (existing.fileKey) {
        try {
          // Unlike an ingest job, a purge has no id to reuse and nothing reads
          // it back, so a completed one is dead weight in Redis. Failures are
          // kept: an orphaned object is the one thing worth inspecting later.
          await app.purgeQueue.add(
            'purge',
            { key: existing.fileKey },
            { attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: true },
          );
        } catch (error) {
          app.log.error({ err: error, key: existing.fileKey }, 'purge enqueue failed; deleting inline');
          try {
            await removeObject(existing.fileKey);
          } catch (deleteError) {
            app.log.error(
              { err: deleteError, key: existing.fileKey },
              'inline purge failed; orphan remains',
            );
          }
        }
      }

      return reply.status(204).send();
    },
  );
};

function isPdfFile(file: MultipartFile): boolean {
  return file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.filename);
}

export default sourcesRoutes;