import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadLimits, env } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertAccess } from '../middleware/assert-access.js';
import { enqueueOrFail } from '../lib/enqueue-ingest.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SpaceRole } from '../generated/prisma/client.js';
import { ARCHIVED_MESSAGE } from './spaces.js';

/**
 * Phase 5: Notes & Saved Answers (PRD §10, §11, §12).
 *
 * Notes are private working material and are excluded from retrieval unless
 * explicitly converted into a manual source (§11, §12).
 */

const citationSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceTitle: z.string(),
  quotedText: z.string(),
  page: z.number().int().nullable(),
  paragraphRef: z.string().nullable(),
  sectionHeading: z.string().nullable(),
  stale: z.boolean(),
  createdAt: z.string(),
});

const convertedSourceSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    state: z.enum(['processing', 'ready', 'failed']),
  })
  .nullable();

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
});

const noteSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  contentRich: z.unknown(),
  originType: z.enum(['user', 'saved_answer']),
  originConversationId: z.string().nullable(),
  originMessageId: z.string().nullable(),
  citationCount: z.number().int(),
  citations: z.array(citationSchema),
  convertedSource: convertedSourceSchema,
  /** Who created the note — the saver, for a saved answer (shared-spaces-v1). */
  author: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const noteTitleSchema = z
  .string()
  .trim()
  .min(1, 'Give this note a title.')
  .max(200, 'Use at most 200 characters.');

const createNoteBodySchema = z.object({
  title: noteTitleSchema,
  contentRich: z.record(z.string(), z.unknown()).optional(),
});

const updateNoteBodySchema = z.object({
  title: noteTitleSchema.optional(),
  contentRich: z.record(z.string(), z.unknown()).optional(),
});

const saveAnswerBodySchema = z
  .object({
    title: noteTitleSchema.optional(),
  })
  .nullish();

const convertToSourceBodySchema = z
  .object({
    title: noteTitleSchema.optional(),
  })
  .nullish();

type NoteRow = {
  id: string;
  spaceId: string;
  title: string;
  contentRich: unknown;
  originType: 'user' | 'saved_answer';
  originConversationId: string | null;
  originMessageId: string | null;
  author: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
  citations: Array<{
    id: string;
    sourceId: string;
    source: { title: string };
    quotedText: string;
    page: number | null;
    paragraphRef: string | null;
    sectionHeading: string | null;
    stale: boolean;
    createdAt: Date;
  }>;
  convertedSource: {
    id: string;
    title: string;
    state: 'processing' | 'ready' | 'failed';
  } | null;
};

const noteSelect = {
  id: true,
  spaceId: true,
  title: true,
  contentRich: true,
  originType: true,
  originConversationId: true,
  originMessageId: true,
  author: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
  citations: {
    select: {
      id: true,
      sourceId: true,
      source: { select: { title: true } },
      quotedText: true,
      page: true,
      paragraphRef: true,
      sectionHeading: true,
      stale: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
  convertedSource: {
    select: {
      id: true,
      title: true,
      state: true,
    },
  },
} as const;

function serializeNote(note: NoteRow) {
  return {
    id: note.id,
    spaceId: note.spaceId,
    title: note.title,
    contentRich: note.contentRich,
    originType: note.originType,
    originConversationId: note.originConversationId,
    originMessageId: note.originMessageId,
    author: note.author,
    citationCount: note.citations.length,
    citations: note.citations.map((citation) => ({
      id: citation.id,
      sourceId: citation.sourceId,
      sourceTitle: citation.source.title,
      quotedText: citation.quotedText,
      page: citation.page,
      paragraphRef: citation.paragraphRef,
      sectionHeading: citation.sectionHeading,
      stale: citation.stale,
      createdAt: citation.createdAt.toISOString(),
    })),
    convertedSource: note.convertedSource
      ? {
          id: note.convertedSource.id,
          title: note.convertedSource.title,
          state: note.convertedSource.state,
        }
      : null,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

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
};

/** The convert-to-source response body, shared by every branch that replies. */
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
  };
}

/**
 * Extracts plain text from a ProseMirror / Tiptap JSON document structure
 * for converting into a text source snapshot (PRD §12).
 *
 * This copy is the one that decides what text is indexed for retrieval, so it
 * stays server-side on purpose — the frontend pair lives in a shared helper at
 * `frontend/src/features/notes/doc-text.ts`. Do not "deduplicate" them across
 * the process boundary.
 */
export function extractPlainText(contentRich: unknown): string {
  if (!contentRich || typeof contentRich !== 'object') return '';

  const doc = contentRich as {
    question?: string;
    content?: Array<unknown>;
    text?: string;
  };

  const buffer: string[] = [];

  if (doc.question && typeof doc.question === 'string' && doc.question.trim().length > 0) {
    buffer.push(`Question: ${doc.question.trim()}`);
  }

  // create/update accept contentRich as loose JSON, so this walk is the only
  // depth bound in the convert path. Without the cap, a document nested tens of
  // thousands of levels deep would blow the stack and turn an adversarial note
  // into a 500 instead of the 400 the shape of the input asks for (PRD §16).
  function traverse(node: unknown, depth = 0) {
    if (depth > 100) {
      throw badRequest('This note is nested too deeply to convert.', 'note_too_deep');
    }
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: string; content?: Array<unknown>; type?: string };
    if (typeof n.text === 'string') {
      buffer.push(n.text);
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) {
        traverse(child, depth + 1);
      }
      if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'blockquote') {
        buffer.push('\n');
      }
    }
  }

  if (Array.isArray(doc.content)) {
    for (const child of doc.content) {
      traverse(child);
    }
  } else if (typeof doc.text === 'string') {
    buffer.push(doc.text);
  }

  const result = buffer.join('').trim();
  return result;
}

export function defaultDoc(text = '', question?: string) {
  const content = text
    ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    : [{ type: 'paragraph' }];
  return question ? { type: 'doc', question, content } : { type: 'doc', content };
}

/** JSON with sorted keys — jsonb reorders keys on write, so `JSON.stringify` alone sees every save as a change. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const notesRoutes: FastifyPluginAsyncZod = async (app) => {
  const writeRateLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
  const readRateLimit = { rateLimit: { max: 600, timeWindow: '1 minute' } };

  const ownedSpace = (role: SpaceRole = 'viewer') => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('space', 'id', role)],
  });

  const ownedNote = (role: SpaceRole = 'viewer') => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('note', 'id', role)],
  });

  const ownedMessage = (role: SpaceRole = 'viewer') => ({
    onRequest: [app.requireUser],
    preHandler: [assertAccess('message', 'id', role)],
  });

  /**
   * Insert `note.edited`, or bump the newest one for this note if it is inside
   * the coalesce window. Runs inside the caller's transaction so a failed
   * activity write can never 500 a note save that already committed, and two
   * concurrent saves inside the window cannot both miss the lookup and insert.
   */
  const recordNoteEdited = async (tx: Prisma.TransactionClient, userId: string, spaceId: string, noteId: string) => {
    const cutoff = new Date(Date.now() - env.ACTIVITY_COALESCE_MINUTES * 60_000);
    const recent = await tx.activity.findFirst({
      where: { userId, kind: 'note.edited', refId: noteId, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (recent) {
      await tx.activity.update({ where: { id: recent.id }, data: { createdAt: new Date() } });
    } else {
      await tx.activity.create({ data: { userId, spaceId, kind: 'note.edited', refId: noteId } });
    }
  };

  const assertSpaceWritable = async (spaceId: string) => {
    const space = await app.prisma.space.findUnique({
      where: { id: spaceId },
      select: { archivedAt: true },
    });
    if (!space) throw notFound();
    if (space.archivedAt) throw conflict(ARCHIVED_MESSAGE, 'space_archived');
  };

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

  // --- 1. Save Answer as Note (PRD §10) --------------------------------------
  app.post(
    '/messages/:id/save-as-note',
    {
      ...ownedMessage('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: saveAnswerBodySchema,
        response: { 201: z.object({ note: noteSchema }) },
      },
    },
    async (request, reply) => {
      const messageId = request.params.id;
      const userId = request.user!.id;
      const customTitle = request.body?.title;

      const message = await app.prisma.message.findUnique({
        where: { id: messageId },
        include: {
          conversation: {
            select: {
              id: true,
              spaceId: true,
              space: { select: { archivedAt: true } },
            },
          },
          citations: {
            select: {
              sourceId: true,
              passageId: true,
              quotedText: true,
              page: true,
              paragraphRef: true,
              sectionHeading: true,
              stale: true,
            },
          },
        },
      });

      if (!message) throw notFound();
      if (message.conversation.space.archivedAt) {
        throw conflict(ARCHIVED_MESSAGE, 'space_archived');
      }
      if (message.role !== 'assistant') {
        throw badRequest('Only assistant answers can be saved as notes.', 'not_an_assistant_message');
      }

      // Anti-duplication (PRD §10, §11)
      const existing = await app.prisma.note.findUnique({
        where: { originMessageId: messageId },
        select: noteSelect,
      });
      if (existing) {
        throw conflict('This answer has already been saved as a note.', 'note_already_saved');
      }

      // Find preceding user question in this conversation
      const previousUserMessage = await app.prisma.message.findFirst({
        where: {
          conversationId: message.conversationId,
          role: 'user',
          createdAt: { lte: message.createdAt },
        },
        // `id` breaks the otherwise-arbitrary tie when two question rows share a
        // millisecond — determinism, not just cosmetics, for the title default.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { content: true },
      });

      const questionText = previousUserMessage?.content?.trim() || '';
      const defaultTitle = customTitle
        ? customTitle
        : questionText
          ? questionText.length > 80
            ? `${questionText.slice(0, 77)}...`
            : questionText
          : 'Saved answer';

      const contentRich = defaultDoc(message.content, questionText || undefined);

      // The findUnique pre-check above is advisory (backend/CLAUDE.md): two
      // concurrent double-clicks both pass it. The unique constraint is what
      // actually holds the anti-duplication invariant, so its P2002 gets the
      // identical 409 — a response that differs under concurrency is an
      // existence oracle (backend/README.md "A uniqueness pre-check is
      // advisory").
      let created: NoteRow;
      try {
        created = await app.prisma.$transaction(async (tx) => {
          const note = await tx.note.create({
            data: {
              spaceId: message.conversation.spaceId,
              title: defaultTitle,
              contentRich: contentRich as Prisma.InputJsonValue,
              originType: 'saved_answer',
              authorId: request.user!.id,
              originConversationId: message.conversationId,
              originMessageId: message.id,
              citations: {
                create: message.citations.map((citation) => ({
                  sourceId: citation.sourceId,
                  passageId: citation.passageId,
                  quotedText: citation.quotedText,
                  page: citation.page,
                  paragraphRef: citation.paragraphRef,
                  sectionHeading: citation.sectionHeading,
                  stale: citation.stale,
                })),
              },
            },
            select: noteSelect,
          });

          await tx.activity.create({
            data: {
              userId,
              spaceId: message.conversation.spaceId,
              kind: 'note.saved_answer',
              refId: note.id,
            },
          });

          return note;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw conflict('This answer has already been saved as a note.', 'note_already_saved');
        }
        throw error;
      }

      return reply.status(201).send({ note: serializeNote(created) });
    },
  );

  // --- 2. List Notes in Space (PRD §11) --------------------------------------
  app.get(
    '/spaces/:id/notes',
    {
      ...ownedSpace(),
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({ q: z.string().trim().max(200).optional() }),
        response: { 200: z.object({ notes: z.array(noteSchema) }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const { q } = request.query;

      const notes = await app.prisma.note.findMany({
        where: {
          spaceId,
          ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        select: noteSelect,
      });

      return reply.send({ notes: notes.map(serializeNote) });
    },
  );

  // --- 3. Create Manual Note (PRD §11) ---------------------------------------
  app.post(
    '/spaces/:id/notes',
    {
      ...ownedSpace('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: createNoteBodySchema,
        response: { 201: z.object({ note: noteSchema }) },
      },
    },
    async (request, reply) => {
      const spaceId = request.params.id;
      const userId = request.user!.id;
      const { title, contentRich } = request.body;

      await assertSpaceWritable(spaceId);

      const richDoc = contentRich ?? defaultDoc();

      const created = await app.prisma.$transaction(async (tx) => {
        const note = await tx.note.create({
          data: {
            spaceId,
            title,
            contentRich: richDoc as Prisma.InputJsonValue,
            originType: 'user',
            authorId: userId,
          },
          select: noteSelect,
        });

        await tx.activity.create({
          data: {
            userId,
            spaceId,
            kind: 'note.created',
            refId: note.id,
          },
        });

        return note;
      });

      return reply.status(201).send({ note: serializeNote(created) });
    },
  );

  // --- 4. Get Note Detail (PRD §11) ------------------------------------------
  app.get(
    '/notes/:id',
    {
      ...ownedNote(),
      config: readRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ note: noteSchema }) },
      },
    },
    async (request, reply) => {
      const note = await app.prisma.note.findUnique({
        where: { id: request.params.id },
        select: noteSelect,
      });
      if (!note) throw notFound();

      return reply.send({ note: serializeNote(note) });
    },
  );

  // --- 5. Update Note (PRD §11) ----------------------------------------------
  app.patch(
    '/notes/:id',
    {
      ...ownedNote('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: updateNoteBodySchema,
        response: { 200: z.object({ note: noteSchema }) },
      },
    },
    async (request, reply) => {
      const noteId = request.params.id;
      const { title, contentRich } = request.body;

      const existing = await app.prisma.note.findUnique({
        where: { id: noteId },
        select: { spaceId: true, title: true, contentRich: true, space: { select: { archivedAt: true } } },
      });
      if (!existing) throw notFound();
      if (existing.space.archivedAt) {
        throw conflict(ARCHIVED_MESSAGE, 'space_archived');
      }

      // PRD §15 "note edited". The editor saves on blur and on a debounce, so a
      // save that changed nothing writes nothing, and edits inside the window
      // coalesce into one row that floats to the top instead of one row each.
      const changed =
        (title !== undefined && title !== existing.title) ||
        (contentRich !== undefined && canonicalJson(contentRich) !== canonicalJson(existing.contentRich));

      const userId = request.user!.id;
      const updated = await app.prisma.$transaction(async (tx) => {
        const row = await tx.note.update({
          where: { id: noteId },
          data: {
            ...(title !== undefined ? { title } : {}),
            ...(contentRich !== undefined ? { contentRich: contentRich as Prisma.InputJsonValue } : {}),
          },
          select: noteSelect,
        });
        if (changed) await recordNoteEdited(tx, userId, existing.spaceId, noteId);
        return row;
      });

      return reply.send({ note: serializeNote(updated) });
    },
  );

  // --- 6. Delete Note (PRD §11) ----------------------------------------------
  app.delete(
    '/notes/:id',
    {
      ...ownedNote('editor'),
      config: writeRateLimit,
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request, reply) => {
      const noteId = request.params.id;
      const userId = request.user!.id;

      const existing = await app.prisma.note.findUnique({
        where: { id: noteId },
        select: { spaceId: true },
      });
      if (!existing) throw notFound();

      await app.prisma.$transaction(async (tx) => {
        await tx.note.delete({ where: { id: noteId } });
        await tx.activity.create({
          data: {
            userId,
            spaceId: existing.spaceId,
            kind: 'note.deleted',
            refId: noteId,
          },
        });
      });

      return reply.status(204).send();
    },
  );

  // --- 7. Convert Note into Source (PRD §12) ----------------------------------
  app.post(
    '/notes/:id/convert-to-source',
    {
      ...ownedNote('editor'),
      config: writeRateLimit,
      schema: {
        params: z.object({ id: z.string() }),
        body: convertToSourceBodySchema,
        response: {
          // 200 is the idempotent replay and the answer to a concurrent
          // duplicate; 201 is the first conversion. Same body either way.
          200: z.object({ source: sourceSchema }),
          201: z.object({ source: sourceSchema }),
        },
      },
    },
    async (request, reply) => {
      const noteId = request.params.id;
      const userId = request.user!.id;
      const proposedTitle = request.body?.title;

      const note = await app.prisma.note.findUnique({
        where: { id: noteId },
        include: {
          space: { select: { id: true, archivedAt: true } },
          convertedSource: true,
        },
      });

      if (!note) throw notFound();
      if (note.space.archivedAt) {
        throw conflict(ARCHIVED_MESSAGE, 'space_archived');
      }

      // Idempotency: if already converted and not failed, return existing source (PRD §12)
      if (note.convertedSource && note.convertedSource.state !== 'failed') {
        const sourceRow = await app.prisma.source.findUnique({
          where: { id: note.convertedSource.id },
        });
        if (sourceRow) {
          // The source was not created by this request, so 200 — not 201 — is
          // the honest status for the idempotent replay.
          return reply.status(200).send({ source: serializeSource(sourceRow) });
        }
      }

      const spaceId = note.space.id;
      const plainText = extractPlainText(note.contentRich);
      if (!plainText || plainText.length === 0) {
        throw badRequest('This note has no text to convert into a source.', 'empty_note_content');
      }

      const limits = await loadLimits(app.prisma);
      if (plainText.length > limits.manual_max_chars) {
        throw badRequest(
          `Text is limited to ${limits.manual_max_chars} characters.`,
          'manual_too_long',
          { content: `Text is limited to ${limits.manual_max_chars} characters.` },
        );
      }

      const sourceTitle = (proposedTitle?.trim() || note.title.trim()).slice(0, 200);
      const authorLabel =
        note.originType === 'saved_answer' ? 'AI-assisted note' : 'User note';

      // `claimed` is false for the retry that lost its race: the row is already
      // back in `processing` and the winner owns the enqueue, so this request
      // answers like the idempotent replay it effectively is.
      let outcome: {
        source: Awaited<ReturnType<typeof app.prisma.source.create>>;
        claimed: boolean;
      };
      try {
        outcome = await app.prisma.$transaction(async (tx) => {
          // A failed conversion is RETRIED, not rebuilt: deleting the failed row
          // would cascade-delete any citations that reference this source
          // (PRD §6/§10) — the source id is the identity a passage or citation
          // points at. Update the row in place, exactly as `/sources/:id/retry`
          // does. Because no row is created or destroyed, the retry is
          // net-neutral on `sources_per_space`, so a retry sitting at the cap is
          // allowed without a limit check.
          if (note.convertedSource && note.convertedSource.state === 'failed') {
            // One atomic statement is the guard, exactly as `/sources/:id/retry`
            // reasons: `state: 'failed'` in the WHERE means a double-clicked
            // retry matches zero rows the second time. Without it both racers
            // would reach `enqueueOrFail`, and the loser's `remove()` can delete
            // the settled-job slot the winner just filled — leaving the source
            // in `processing` with no job coming, the one trap the guard exists
            // to prevent. The queue is not the guard.
            const claim = await tx.source.updateMany({
              where: { id: note.convertedSource.id, state: 'failed' },
              data: {
                title: sourceTitle,
                author: authorLabel,
                content: plainText,
                state: 'processing',
                errorMessage: null,
              },
            });
            const source = await tx.source.findUniqueOrThrow({
              where: { id: note.convertedSource.id },
            });
            return { source, claimed: claim.count === 1 };
          }

          await assertSpaceAcceptsSource(tx, spaceId);

          const source = await tx.source.create({
            data: {
              spaceId,
              type: 'manual',
              title: sourceTitle,
              author: authorLabel,
              originNoteId: note.id,
              content: plainText,
              state: 'processing',
              // The converter, not the note's author, brought this evidence in.
              addedById: userId,
            },
          });

          await tx.activity.create({
            data: {
              userId,
              spaceId,
              kind: 'source.added',
              refId: source.id,
            },
          });

          await tx.activity.create({
            data: {
              userId,
              spaceId,
              kind: 'note.converted',
              refId: note.id,
            },
          });

          return { source, claimed: true };
        });
      } catch (error) {
        // The same concurrency story as save-as-note: two double-clicks both pass
        // the reads above and race `Source.originNoteId` (@unique). Answer exactly
        // as the idempotent branch does — the loser sees the existing source,
        // never a 500 (backend/CLAUDE.md).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const existing = await app.prisma.source.findUnique({
            where: { originNoteId: note.id },
          });
          if (existing) {
            return reply.status(200).send({ source: serializeSource(existing) });
          }
        }
        throw error;
      }

      const sourceRow = outcome.source;
      if (!outcome.claimed) {
        // Someone else already put this source back in flight. Answer 200 — the
        // status the idempotent branch and the P2002 loser both use — and leave
        // the enqueue to the request that actually claimed the row.
        return reply.status(200).send({ source: serializeSource(sourceRow) });
      }

      await enqueueOrFail(app, sourceRow.id, spaceId, userId);

      const final = await app.prisma.source.findUnique({
        where: { id: sourceRow.id },
      });

      const row = final ?? sourceRow;
      return reply.status(201).send({ source: serializeSource(row) });
    },
  );
};

export default notesRoutes;
