import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { EmbeddingError, toVectorLiteral, type EmbeddingTask } from '../lib/embeddings.js';
import type { ChunkedPassage, LocatedBlock } from './chunk.js';
import { UnretryableIngestError } from './errors.js';

export type EmbedFn = (
  inputs: string[],
  task: EmbeddingTask,
  options?: { timeoutMs?: number },
) => Promise<number[][]>;

/** Batch size for `embed()` calls (wiki-docs/plan/phase-2-ingestion/design.md). */
export const EMBED_BATCH = 32;

export interface PersistInput {
  sourceId: string;
  userId: string;
  spaceId: string;
  /** Overwrites surfaced by extraction (web title/author), when present. */
  title?: string;
  author?: string | null;
  url?: string | null;
  content: string;
  /** The reader's units, in source order — persisted alongside the passages. */
  blocks: LocatedBlock[];
  passages: ChunkedPassage[];
}

interface PassageRow {
  id: string;
  sourceId: string;
  ord: number;
  text: string;
  page: number | null;
  paragraphRef: string | null;
  sectionHeading: string | null;
  startBlockOrd: number;
  endBlockOrd: number;
  embedding: string;
}

/**
 * The single write that makes a crashed job harmless: a source that never
 * reaches it stays `processing` and is recovered by the same retry path a user
 * would use. Everything inside is one transaction, so there is no window where
 * a source is `ready` with a half-written index.
 *
 * - Old passages and blocks are deleted and the new sets inserted in the same
 *   transaction, so a source can never be `ready` with last run's blocks and
 *   this run's passages (PRD §6, and the reader depends on the two agreeing).
 * - `tsv` is computed by `to_tsvector` in the same statement as the text, so
 *   the FTS vector cannot drift.
 * - Citations of a reprocessed source are re-matched by exact quoted text
 *   against the new passages, or marked `stale` (PRD §6).
 * - `source.ready` activity is written in the same transaction as the state.
 */
export async function persistReady(
  prisma: Prisma.TransactionClient | PrismaClient,
  { embed }: { embed: EmbedFn },
  input: PersistInput,
): Promise<void> {
  const embeddings = await embedBatched(embed, input.passages);
  const rows: PassageRow[] = input.passages.map((passage, index) => {
    const vector = embeddings[index];
    if (!vector) {
      throw new Error(`embed() returned no vector at index ${index} (bug: bounds should match).`);
    }
    return {
      id: randomUUID(),
      sourceId: input.sourceId,
      ord: index + 1,
      text: passage.text,
      page: passage.page,
      paragraphRef: passage.paragraphRef,
      sectionHeading: passage.sectionHeading,
      startBlockOrd: passage.startBlockOrd,
      endBlockOrd: passage.endBlockOrd,
      embedding: toVectorLiteral(vector),
    };
  });

  await prisma.$transaction(async (tx) => {
    await tx.passage.deleteMany({ where: { sourceId: input.sourceId } });
    await tx.sourceBlock.deleteMany({ where: { sourceId: input.sourceId } });
    await tx.sourceBlock.createMany({
      data: input.blocks.map((block, index) => ({
        sourceId: input.sourceId,
        ord: index + 1,
        text: block.text,
        page: block.page ?? null,
        paragraphIndex: block.paragraphIndex ?? null,
        heading: block.heading ?? null,
      })),
    });
    await insertPassages(tx, rows);
    await rematchCitations(tx, input.sourceId, rows);

    await tx.source.update({
      where: { id: input.sourceId },
      data: {
        content: input.content,
        state: 'ready',
        errorMessage: null,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.author !== undefined ? { author: input.author } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
      },
    });

    await tx.activity.create({
      data: {
        userId: input.userId,
        spaceId: input.spaceId,
        kind: 'source.ready',
        refId: input.sourceId,
      },
    });
  });
}

/**
 * Mark a source permanently failed with a human-readable message, writing the
 * `source.failed` activity in the same transaction as the state change — an
 * activity entry can never claim something the row does not show.
 */
export async function markSourceFailed(
  prisma: PrismaClient,
  input: { userId: string; spaceId: string; sourceId: string; message: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.source.update({
      where: { id: input.sourceId },
      data: { state: 'failed', errorMessage: input.message },
    });
    await tx.activity.create({
      data: {
        userId: input.userId,
        spaceId: input.spaceId,
        kind: 'source.failed',
        refId: input.sourceId,
      },
    });
  });
}

async function embedBatched(embed: EmbedFn, passages: ChunkedPassage[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < passages.length; start += EMBED_BATCH) {
    const batch = passages.slice(start, start + EMBED_BATCH).map((passage) => passage.text);
    try {
      vectors.push(...(await embed(batch, 'passage')));
    } catch (error) {
      // A dimension mismatch or a rejected HuggingFace token is a misconfigured
      // service, not a blip: the same call will fail identically on all three
      // attempts, so it ends the job now with a message the user can act on
      // (retry after the operator fixes the model or the key).
      if (
        error instanceof EmbeddingError &&
        (error.code === 'dimension_mismatch' || error.code === 'unauthorized')
      ) {
        throw new UnretryableIngestError(
          'This source could not be indexed because of a server configuration problem.',
          { cause: error },
        );
      }
      throw error;
    }
  }
  return vectors;
}

async function insertPassages(
  tx: Prisma.TransactionClient,
  rows: PassageRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO "Passage" ("id", "sourceId", "ord", "text", "page", "paragraphRef", "sectionHeading", "startBlockOrd", "endBlockOrd", "embedding", "tsv")
    SELECT u.id, u."sourceId", u.ord, u.text, u.page, u."paragraphRef", u."sectionHeading", u."startBlockOrd", u."endBlockOrd", u.embedding::vector, to_tsvector('english', u.text)
    FROM UNNEST(
      ${rows.map((row) => row.id)}::text[],
      ${rows.map((row) => row.sourceId)}::text[],
      ${rows.map((row) => row.ord)}::int[],
      ${rows.map((row) => row.text)}::text[],
      ${rows.map((row) => row.page)}::int[],
      ${rows.map((row) => row.paragraphRef)}::text[],
      ${rows.map((row) => row.sectionHeading)}::text[],
      ${rows.map((row) => row.startBlockOrd)}::int[],
      ${rows.map((row) => row.endBlockOrd)}::int[],
      ${rows.map((row) => row.embedding)}::text[]
    ) AS u(id, "sourceId", ord, text, page, "paragraphRef", "sectionHeading", "startBlockOrd", "endBlockOrd", embedding)
  `;
}

/**
 * PRD §6: citations whose passage did not survive a reprocess are preserved
 * where they can be re-matched and marked stale otherwise. The only producer of
 * citations is Phase 4, so this is verified against hand-seeded rows until then.
 *
 * The quoted text is matched exactly against a passage, not fuzzy — a citation
 * that only *almost* appears somewhere must not be silently re-validated.
 */
async function rematchCitations(
  tx: Prisma.TransactionClient,
  sourceId: string,
  rows: PassageRow[],
): Promise<void> {
  const citations = await tx.citation.findMany({
    where: { sourceId },
    select: { id: true, quotedText: true },
  });
  if (citations.length === 0) return;

  // Whitespace-insensitive: a reprocess that reflows lines into paragraphs
  // turns yesterday's `\n` into a space, and a quote spanning that break is
  // still the same evidence (design "rematchCitations compares
  // whitespace-normalised text"). Rows are normalised once, not per citation —
  // this runs inside the transaction that holds the source's rows.
  const normalised = rows.map((row) => ({ row, text: collapseWhitespace(row.text) }));
  for (const citation of citations) {
    const quoted = collapseWhitespace(citation.quotedText);
    const match = normalised.find((entry) => entry.text.includes(quoted))?.row;
    if (match) {
      await tx.citation.update({
        where: { id: citation.id },
        data: {
          passageId: match.id,
          stale: false,
          page: match.page,
          paragraphRef: match.paragraphRef,
          sectionHeading: match.sectionHeading,
        },
      });
    } else {
      await tx.citation.update({
        where: { id: citation.id },
        data: { passageId: null, stale: true },
      });
    }
  }
}

const collapseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();
