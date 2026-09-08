import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../config.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../lib/errors.js';
import { assertAccess } from '../middleware/assert-access.js';
import { retrievableSources } from '../lib/retrieval-scope.js';
import { retrieve, type RetrievalScope } from '../lib/retrieval.js';
import { buildHistory, runAnswer, type AnswerOutcome, type ResolvedCitation } from '../lib/answers.js';
import { AnswerProviderError } from '../lib/answer-provider.js';
import { ARCHIVED_MESSAGE } from './spaces.js';

/**
 * The citation-grounded assistant (PRD §9).
 *
 * The ask route answers `text/event-stream` on its own POST response rather than
 * publishing through the Redis channel Phase 2 built. It reuses that phase's
 * stream *plumbing* — the per-user connection cap and the sign-out teardown — but
 * not its channel: the assistant runs in the request that asked, so a pub/sub hop
 * would add latency, put token ordering at the mercy of delivery, and fan a
 * private answer out to every subscriber of `space:<id>`
 * (wiki-docs/plan/phase-4-assistant/design.md "The answer streams over its own
 * POST response").
 */

/** Recorded as the snapshot's model when insufficiency skipped the provider. */
const NO_MODEL = 'none (no model call)';

const ASSISTANT_FAILURE =
  'We could not get an answer just now. Your question is still here — try again.';

const citationSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  sourceId: z.string(),
  sourceTitle: z.string(),
  quotedText: z.string(),
  reference: z.string(),
  stale: z.boolean(),
});

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  feedback: z.enum(['useful', 'not_useful']).nullable(),
  grounded: z.boolean().nullable(),
  /** How many excerpts were sent for this answer. Null on a user turn. */
  passagesSent: z.number().int().nullable(),
  sourcesUsed: z.array(z.object({ id: z.string(), title: z.string() })),
  citations: z.array(citationSchema),
  /** The note this answer was saved into, when one exists (PRD §11). */
  savedNoteId: z.string().nullable(),
  createdAt: z.string(),
});

const conversationSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  scopeType: z.enum(['source', 'space']),
  scopeSourceId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * What a history row shows beside the title (PRD §9, "view previous
 * conversations"): the newest question, cut to one line, and how many turns the
 * thread holds so an empty thread can be told apart from a short one. Only the
 * list carries these; create, get and patch keep `conversationSchema`.
 */
const conversationListItemSchema = conversationSchema.extend({
  preview: z.string().nullable(),
  messageCount: z.number().int(),
});

/** Presentation, not a PRD §5 limit — so a constant, not `AppConfig`. */
const PREVIEW_LENGTH = 140;

const scopeBodySchema = z.object({
  scopeType: z.enum(['source', 'space']),
  scopeSourceId: z.string().optional(),
});

/**
 * What §9 requires stored with each assistant request: the scope, *and* the
 * sources actually retrieved from. Titles are duplicated here on purpose — a
 * source can be deleted (§17 purges its citations with it), and an answer that
 * can no longer say what it was based on is worse than one holding a stale title.
 */
interface ScopeSnapshot {
  /**
   * Prisma's `InputJsonObject` needs an index signature to accept this shape, and
   * the union is narrow on purpose: a field that does not fit a JSON scalar or a
   * string list does not belong in a snapshot the client reads back.
   */
  [key: string]: string | string[] | number | boolean | null;
  scopeType: 'source' | 'space';
  scopeSourceId: string | null;
  sourceIds: string[];
  sourceTitles: string[];
  passageCount: number;
  grounded: boolean;
  provider: string;
  model: string;
  effort: string;
  citationMode: string;
  /**
   * The space's audience note as it was when this answer was produced, or null
   * when there was none — or when no model ran (plan/space-audience-style).
   *
   * Written for forensics, **not** for display: nothing on the message payload
   * surfaces it, deliberately. It is what lets an answer that reads oddly after
   * the owner edits the note be explained from the row, in the same spirit as
   * `model` recording what actually served the request. Showing it beside a
   * saved answer would be a product decision this plan did not make; if that is
   * wanted, it needs its own change, not a quiet addition here.
   */
  audience: string | null;
}

function readSnapshot(value: unknown): Partial<ScopeSnapshot> {
  return typeof value === 'object' && value !== null ? (value as Partial<ScopeSnapshot>) : {};
}

type ConversationRow = {
  id: string;
  spaceId: string;
  title: string;
  scopeType: 'source' | 'space';
  scopeSourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function serializeConversation(row: ConversationRow) {
  return {
    id: row.id,
    spaceId: row.spaceId,
    title: row.title,
    scopeType: row.scopeType,
    scopeSourceId: row.scopeSourceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const conversationSelect = {
  id: true,
  spaceId: true,
  title: true,
  scopeType: true,
  scopeSourceId: true,
  createdAt: true,
  updatedAt: true,
} as const;

// The list is one query: the newest user turn rides along as a one-element
// relation and the count as `_count`, so a space with two hundred threads costs
// the same round-trips as one with two.
const conversationListSelect = {
  ...conversationSelect,
  messages: {
    where: { role: 'user' as const },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { content: true },
  },
  _count: { select: { messages: true } },
} as const;

type ConversationListRow = ConversationRow & {
  messages: { content: string }[];
  _count: { messages: number };
};

function previewOf(content: string | undefined): string | null {
  if (content === undefined) return null;
  const collapsed = content.trim().replace(/\s+/g, ' ');
  if (collapsed === '') return null;
  // By code point, not UTF-16 unit: `slice` on the string could end on half of a
  // surrogate pair and ship a broken character as the last one.
  const points = Array.from(collapsed);
  return points.length > PREVIEW_LENGTH
    ? `${points.slice(0, PREVIEW_LENGTH).join('').trimEnd()}…`
    : collapsed;
}

function serializeListItem(row: ConversationListRow) {
  return {
    ...serializeConversation(row),
    preview: previewOf(row.messages[0]?.content),
    messageCount: row._count.messages,
  };
}

/** A title that is usable when generation fails, rather than an error (§9). */
function fallbackTitle(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 60 ? trimmed : `${trimmed.slice(0, 57)}…`;
}

const conversationsRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Per-route factories, never shared objects: `@fastify/rate-limit` *pushes* its
   * hook into `routeOptions.onRequest`, so one array reused across routes ends up
   * running every route's limiter on each route. That is how Phase 2's read routes
   * inherited the writes' cap (see `sources.ts`). Asking is expensive and gets its
   * own bucket; reading a thread must not be throttled at the ask rate, or a
   * reload would break the conversation.
   */
  const askRateLimit = {
    rateLimit: { max: env.ANSWER_RATE_PER_MINUTE, timeWindow: '1 minute' },
  };
  const writeRateLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
  const readRateLimit = { rateLimit: { max: 600, timeWindow: '1 minute' } };

  const ownedSpace = () => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('space', 'id')],
  });
  const ownedConversation = () => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('conversation', 'id')],
  });
  const ownedMessage = () => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('message', 'id')],
  });

  /** Asking and changing scope are writes, so they are refused in an archived space. */
  const assertSpaceWritable = async (spaceId: string) => {
    const space = await app.prisma.space.findUnique({
      where: { id: spaceId },
      select: { archivedAt: true },
    });
    if (!space) throw notFound();
    if (space.archivedAt) throw conflict(ARCHIVED_MESSAGE, 'space_archived');
  };

  /**
   * Validates a requested scope against the space. A source scope must name a
   * source *in this space* — otherwise the scope would be a way to read across
   * spaces, which §20 excludes.
   */
  const resolveScope = async (
    spaceId: string,
    body: z.infer<typeof scopeBodySchema>,
  ): Promise<{ scopeType: 'source' | 'space'; scopeSourceId: string | null }> => {
    if (body.scopeType === 'space') return { scopeType: 'space', scopeSourceId: null };
    if (!body.scopeSourceId) {
      throw badRequest('Choose which source to ask about.', 'bad_request', {
        scopeSourceId: 'Choose which source to ask about.',
      });
    }
    const source = await app.prisma.source.findFirst({
      where: { id: body.scopeSourceId, spaceId },
      select: { id: true },
    });
    if (!source) throw notFound();
    return { scopeType: 'source', scopeSourceId: source.id };
  };

  app.get(
    '/spaces/:id/conversations',
    {
      ...ownedSpace(),
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ conversations: z.array(conversationListItemSchema) }) },
      },
    },
    async (request, reply) => {
      // Conversations are private to the member who started them
      // (shared-spaces-v1 "Conversations are private"): the list is mine only.
      const rows = await app.prisma.conversation.findMany({
        where: { spaceId: request.params.id, userId: request.user!.id },
        select: conversationListSelect,
        orderBy: { updatedAt: 'desc' },
      });
      return reply.send({ conversations: rows.map(serializeListItem) });
    },
  );

  app.post(
    '/spaces/:id/conversations',
    {
      ...ownedSpace(),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: scopeBodySchema,
        response: { 201: z.object({ conversation: conversationSchema }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      await assertSpaceWritable(spaceId);
      const scope = await resolveScope(spaceId, request.body);

      // Titled from the first question once one exists (§9). Until then the
      // conversation still needs a name a list row can show.
      const conversation = await app.prisma.conversation.create({
        data: { spaceId, userId: request.user!.id, title: 'New conversation', ...scope },
        select: conversationSelect,
      });

      return reply.code(201).send({ conversation: serializeConversation(conversation) });
    },
  );

  app.get(
    '/conversations/:id',
    {
      ...ownedConversation(),
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: z.object({
            conversation: conversationSchema,
            messages: z.array(messageSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const conversation = await app.prisma.conversation.findUnique({
        where: { id: request.params.id },
        select: conversationSelect,
      });
      if (!conversation) throw notFound();

      const messages = await app.prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          feedback: true,
          scopeSnapshot: true,
          createdAt: true,
          citations: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              sourceId: true,
              quotedText: true,
              page: true,
              paragraphRef: true,
              sectionHeading: true,
              stale: true,
              source: { select: { title: true } },
            },
          },
          note: { select: { id: true } },
        },
      });

      return reply.send({
        conversation: serializeConversation(conversation),
        messages: messages.map((message) => {
          const snapshot = readSnapshot(message.scopeSnapshot);
          const ids = snapshot.sourceIds ?? [];
          const titles = snapshot.sourceTitles ?? [];
          return {
            id: message.id,
            role: message.role,
            content: message.content,
            feedback:
              message.feedback === 'useful' || message.feedback === 'not_useful'
                ? message.feedback
                : null,
            grounded: message.role === 'assistant' ? (snapshot.grounded ?? null) : null,
            passagesSent: message.role === 'assistant' ? (snapshot.passageCount ?? null) : null,
            sourcesUsed: ids.map((id, index) => ({ id, title: titles[index] ?? 'Source' })),
            citations: message.citations.map((citation, index) => ({
              id: citation.id,
              index: index + 1,
              sourceId: citation.sourceId,
              sourceTitle: citation.source.title,
              quotedText: citation.quotedText,
              reference:
                citation.page !== null
                  ? `Page ${citation.page}`
                  : (citation.paragraphRef ?? citation.sectionHeading ?? 'Excerpt'),
              stale: citation.stale,
            })),
            savedNoteId: message.note?.id ?? null,
            createdAt: message.createdAt.toISOString(),
          };
        }),
      });
    },
  );

  app.patch(
    '/conversations/:id',
    {
      ...ownedConversation(),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: scopeBodySchema,
        response: { 200: z.object({ conversation: conversationSchema }) },
      },
    },
    async (request, reply) => {
      const existing = await app.prisma.conversation.findUnique({
        where: { id: request.params.id },
        select: { spaceId: true },
      });
      if (!existing) throw notFound();
      await assertSpaceWritable(existing.spaceId);

      const scope = await resolveScope(existing.spaceId, request.body);
      const conversation = await app.prisma.conversation.update({
        where: { id: request.params.id },
        data: scope,
        select: conversationSelect,
      });
      return reply.send({ conversation: serializeConversation(conversation) });
    },
  );

  app.post(
    '/messages/:id/feedback',
    {
      ...ownedMessage(),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ feedback: z.enum(['useful', 'not_useful']).nullable() }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      const message = await app.prisma.message.findUnique({
        where: { id: request.params.id },
        select: { role: true },
      });
      if (!message) throw notFound();
      // §9 asks for feedback on an *answer*. Accepting it on the user's own
      // question would store a rating nothing can act on.
      if (message.role !== 'assistant') {
        throw badRequest('Feedback applies to an answer, not to your question.');
      }

      await app.prisma.message.update({
        where: { id: request.params.id },
        data: { feedback: request.body.feedback },
      });
      return reply.send({ ok: true });
    },
  );

  /**
   * Ask. Streams the answer on this response.
   *
   * Everything that can be refused is refused **before** `reply.hijack()`: past
   * that point the error handler is out of the picture and the only way to report
   * a problem is an `error` event on a stream the client is already reading.
   */
  app.post(
    '/conversations/:id/messages',
    {
      ...ownedConversation(),
      config: askRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          question: z
            .string()
            .trim()
            .min(1, 'Type a question to ask.')
            .max(2000, 'Use at most 2000 characters.'),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const conversationId = request.params.id;
      const question = request.body.question;

      const conversation = await app.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true,
          spaceId: true,
          scopeType: true,
          scopeSourceId: true,
          space: { select: { archivedAt: true, audienceInstruction: true } },
          _count: { select: { messages: true } },
        },
      });
      if (!conversation) throw notFound();
      // Asking creates rows, so it is a write: refused in an archived space with
      // Phase 1's message (REQ-100). Reading the thread stays allowed.
      if (conversation.space.archivedAt) throw conflict(ARCHIVED_MESSAGE, 'space_archived');

      const provider = app.answerProvider;
      if (!provider) {
        throw serviceUnavailable(
          'The assistant is not configured on this server, so it cannot answer yet.',
          'assistant_unavailable',
        );
      }

      // A current-source scope naming a source that is not retrievable is refused
      // rather than answered with insufficiency: insufficiency means "we looked
      // and found nothing", and claiming it about a source the user can see is
      // archived would be a lie.
      let scope: RetrievalScope = { type: 'space', spaceId: conversation.spaceId };
      if (conversation.scopeType === 'source' && conversation.scopeSourceId) {
        const usable = await app.prisma.source.findFirst({
          where: { ...retrievableSources(conversation.spaceId), id: conversation.scopeSourceId },
          select: { id: true },
        });
        if (!usable) {
          throw conflict(
            'That source is not ready to answer questions — it is archived, still processing, or failed.',
            'scope_not_retrievable',
          );
        }
        scope = { type: 'source', spaceId: conversation.spaceId, sourceId: usable.id };
      }

      // Rendered into the user turn by the adapter, never into `system`
      // (lib/answer-rules.ts). An unset note leaves the request byte-identical
      // to what this route sent before the field existed.
      const audience = conversation.space.audienceInstruction?.trim() || undefined;

      const isFirstQuestion = conversation._count.messages === 0;

      // The connection is claimed *before* the question is written, because
      // `registerUserConnection` throws 429 at the per-user cap. Writing first
      // would leave an orphan question with no answer, and every Retry would add
      // another — a thread of duplicated questions from having three tabs open.
      app.events.registerUserConnection(userId);

      // Persisted before the stream opens, so a dropped connection loses the
      // answer and keeps the question.
      let userMessage;
      try {
        userMessage = await app.prisma.message.create({
          data: { conversationId, role: 'user', content: question },
          select: { id: true, createdAt: true },
        });
      } catch (error) {
        app.events.releaseUserConnection(userId);
        throw error;
      }

      // --- Nothing below this line may throw an AppError. ---
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': env.CORS_ORIGIN,
        'access-control-allow-credentials': 'true',
      });

      const controller = new AbortController();
      let closed = false;
      const send = (payload: unknown) => {
        if (closed || reply.raw.writableEnded) return;
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        app.events.releaseUserConnection(userId);
      };
      const close = () => {
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
      };
      const dispose = app.events.trackStream(userId, close);
      reply.raw.on('close', () => {
        dispose();
        // A closed tab must stop paying for tokens.
        controller.abort();
        cleanup();
      });

      send({ type: 'user_message', id: userMessage.id, createdAt: userMessage.createdAt.toISOString() });

      const startedAt = Date.now();
      let firstTokenAt: number | null = null;

      try {
        const { passages, counts } = await retrieve(app, scope, question);
        const retrievedAt = Date.now();

        if (passages.length === 0) {
          // Answered without calling the provider at all: it cannot hallucinate
          // what it never saw, it costs nothing, and it is instant.
          const readyCount = await app.prisma.source.count({
            where: retrievableSources(conversation.spaceId),
          });
          const text =
            scope.type === 'source'
              ? 'Nothing in this source matched that question, so there is no evidence here to answer it from.'
              : readyCount === 0
                ? 'This space has no sources ready to search yet. Add a source, and I can answer from it.'
                : 'None of the sources in this space matched that question closely enough to answer it. Try different words, or add a source that covers it.';

          const snapshot: ScopeSnapshot = {
            scopeType: conversation.scopeType,
            scopeSourceId: conversation.scopeSourceId,
            sourceIds: [],
            sourceTitles: [],
            passageCount: 0,
            grounded: false,
            provider: provider.id,
            // No model ran, and saying so is more honest than naming one that did
            // not: this answer was produced without a provider call at all.
            model: NO_MODEL,
            effort: env.ANSWER_EFFORT,
            citationMode: provider.capabilities.citations,
            // No model ran, so no audience note shaped this text either.
            audience: null,
          };
          const assistant = await app.prisma.$transaction(async (tx) => {
            const created = await tx.message.create({
              data: {
                conversationId,
                role: 'assistant',
                content: text,
                scopeSnapshot: snapshot,
              },
              select: { id: true },
            });
            await tx.conversation.update({
              where: { id: conversationId },
              data: { updatedAt: new Date() },
            });
            return created;
          });

          send({ type: 'delta', text });
          send({ type: 'done', messageId: assistant.id, grounded: false, truncated: false });
          app.log.info(
            {
              conversationId,
              scopeType: scope.type,
              candidates: counts,
              insufficient: true,
              retrieveMs: retrievedAt - startedAt,
            },
            'assistant answered insufficiency without a model call',
          );
          close();
          return;
        }

        const priorTurns = await app.prisma.message.findMany({
          where: { conversationId, id: { not: userMessage.id } },
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true },
        });
        const history = buildHistory(priorTurns, env.MAX_HISTORY_TURNS);

        let outcome: AnswerOutcome | null = null;
        const citations: ResolvedCitation[] = [];

        for await (const event of runAnswer({
          provider,
          question,
          passages,
          history,
          ...(audience ? { audience } : {}),
          model: env.ANSWER_MODEL,
          effort: env.ANSWER_EFFORT,
          maxTokens: env.ANSWER_MAX_TOKENS,
          signal: controller.signal,
        })) {
          if (closed) break;
          if (event.type === 'thinking') {
            firstTokenAt ??= Date.now();
            send({ type: 'thinking', text: event.text });
          } else if (event.type === 'delta') {
            firstTokenAt ??= Date.now();
            send({ type: 'delta', text: event.text });
          } else if (event.type === 'citation') {
            citations.push(event.citation);
          } else {
            outcome = event.outcome;
          }
        }

        // A disconnect leaves nothing to persist. A half-sentence stored here
        // would become context for the next follow-up, so a dropped Wi-Fi
        // connection would degrade the whole conversation.
        if (closed || controller.signal.aborted) {
          cleanup();
          return;
        }

        if (!outcome) throw new AnswerProviderError('The answer stream produced no outcome.');

        // Sending evidence and getting no citation back is a strong signal that the
        // citation channel is broken rather than that the evidence was weak — a
        // proxy translating Anthropic's shape to another API drops `document`
        // blocks it has no equivalent for, so the model never sees the excerpts and
        // says so. That is indistinguishable from honest insufficiency unless it is
        // named here, which is how one real misconfiguration went unexplained.
        if (!outcome.grounded && passages.length > 0) {
          app.log.warn(
            {
              conversationId,
              passages: passages.length,
              citationMode: outcome.citationMode,
              provider: outcome.provider,
              model: outcome.servedModel ?? env.ANSWER_MODEL,
              baseUrlConfigured: env.ANSWER_BASE_URL !== undefined,
            },
            'answer cited nothing despite evidence being sent — if this is every ' +
              'answer, the provider or proxy is not returning citations (check that ' +
              'ANSWER_PROVIDER matches the endpoint shape)',
          );
        }

        if (outcome.refused) {
          send({ type: 'error', message: ASSISTANT_FAILURE });
          app.log.warn({ conversationId, provider: outcome.provider }, 'answer refused by provider');
          close();
          return;
        }

        const snapshot: ScopeSnapshot = {
          scopeType: conversation.scopeType,
          scopeSourceId: conversation.scopeSourceId,
          sourceIds: [...new Set(outcome.citations.map((citation) => citation.sourceId))],
          sourceTitles: [],
          passageCount: passages.length,
          grounded: outcome.grounded,
          provider: outcome.provider,
          // What answered, not what was asked for: a router does model mapping
          // and provider failover, so the requested id can name something that
          // never ran (plan/assistant-provider-tiers/design.md).
          model: outcome.servedModel ?? env.ANSWER_MODEL,
          effort: env.ANSWER_EFFORT,
          citationMode: outcome.citationMode,
          audience: audience ?? null,
        };
        snapshot.sourceTitles = snapshot.sourceIds.map(
          (id) => outcome!.citations.find((citation) => citation.sourceId === id)?.sourceTitle ?? 'Source',
        );

        // The assistant message and its citations land together or not at all.
        const persisted = await app.prisma.$transaction(async (tx) => {
          const created = await tx.message.create({
            data: {
              conversationId,
              role: 'assistant',
              content: outcome!.text,
              scopeSnapshot: snapshot,
            },
            select: { id: true },
          });
          // One statement rather than a round trip per citation while the
          // transaction holds a connection. The ids are re-read below anyway, so
          // `createMany` not returning them costs nothing.
          await tx.citation.createMany({
            data: outcome!.citations.map((citation) => ({
              messageId: created.id,
              sourceId: citation.sourceId,
              passageId: citation.passageId,
              quotedText: citation.quotedText,
              page: citation.page,
              paragraphRef: citation.paragraphRef,
              sectionHeading: citation.sectionHeading,
            })),
          });
          await tx.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
          });
          return created;
        });

        // Citation ids only exist now, so the markers are sent once the rows do.
        const stored = await app.prisma.citation.findMany({
          where: { messageId: persisted.id },
          orderBy: { createdAt: 'asc' },
          select: { id: true, passageId: true },
        });
        const idByPassage = new Map(stored.map((row) => [row.passageId, row.id]));
        for (const citation of citations) {
          send({
            type: 'citation',
            index: citation.index,
            citationId: idByPassage.get(citation.passageId) ?? null,
            sourceId: citation.sourceId,
            sourceTitle: citation.sourceTitle,
            reference: citation.reference,
            quotedText: citation.quotedText,
          });
        }
        send({
          type: 'sources',
          sources: snapshot.sourceIds.map((id, index) => ({
            id,
            title: snapshot.sourceTitles[index] ?? 'Source',
          })),
        });

        // `done` is what ends the client's asking state, so it goes out as soon as
        // the answer is stored — **before** the title, which is a second provider
        // call and can take longer than the answer did. It said it was off the
        // critical path and it was not: measured against a reasoning model serving
        // both, the answer was complete at 21.6 s and `done` arrived at 56.7 s,
        // with the finished answer on screen and the composer disabled throughout.
        // The client settles on `done` and keeps reading, so a later `title` still
        // refreshes the list (`frontend/src/features/assistant/use-ask.ts`).
        send({
          type: 'done',
          messageId: persisted.id,
          grounded: outcome.grounded,
          truncated: outcome.truncated,
        });

        if (isFirstQuestion) {
          // Never an error: a failure leaves a title built from the question.
          let title = fallbackTitle(question);
          try {
            const generated = await provider.title(question, controller.signal);
            const cleaned = generated.trim().replace(/^["']|["']$/g, '');
            if (cleaned) title = cleaned.slice(0, 80);
          } catch (error) {
            app.log.warn({ err: error, conversationId }, 'title generation failed; using the question');
          }
          await app.prisma.conversation.update({ where: { id: conversationId }, data: { title } });
          send({ type: 'title', title });
        }

        // Ids, counts, latencies. No question, answer, passage, or quote text (§17).
        app.log.info(
          {
            conversationId,
            messageId: persisted.id,
            scopeType: scope.type,
            candidates: counts,
            passages: passages.length,
            citations: outcome.citations.length,
            droppedCitations: outcome.droppedCitations,
            grounded: outcome.grounded,
            truncated: outcome.truncated,
            provider: outcome.provider,
            model: outcome.servedModel ?? env.ANSWER_MODEL,
            requestedModel: env.ANSWER_MODEL,
            usage: outcome.usage,
            retrieveMs: retrievedAt - startedAt,
            firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
            totalMs: Date.now() - startedAt,
          },
          'assistant answered',
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          app.log.error({ err: error, conversationId }, 'assistant request failed');
          send({ type: 'error', message: ASSISTANT_FAILURE });
        }
      } finally {
        close();
      }
    },
  );
};

export default conversationsRoutes;
