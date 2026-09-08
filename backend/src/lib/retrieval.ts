import type { FastifyInstance } from 'fastify';
import { env } from '../config.js';
import { embed, toVectorLiteral } from './embeddings.js';
import { retrievableSources } from './retrieval-scope.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Hybrid retrieval over a space's passages (PRD §9), and the first consumer of
 * the embeddings the ingest pipeline has been writing since Phase 2.
 *
 * Two candidate queries — pgvector KNN and full-text — are fused by reciprocal
 * rank fusion rather than by a blended score: cosine distance and `ts_rank` are
 * not comparable numbers and their distributions move with the corpus, so any
 * weighting would need recalibrating whenever a user adds a source. RRF reads
 * only *ordering*, which is the one thing both halves agree on
 * (wiki-docs/plan/phase-4-assistant/design.md "Retrieval is hybrid, fused by
 * rank rather than by score").
 *
 * Both halves are built from `retrievableSources()`. That is a hard requirement,
 * not a convention: a retrieval query that re-derives `state: 'ready'` inline is
 * one edit away from forgetting `archivedAt` and answering from evidence the
 * user withdrew (PRD §6/§9/§17, `backend/CLAUDE.md`).
 */

/** RRF's only constant. 60 is the value the original paper settles on. */
const RRF_K = 60;

export type RetrievalScope =
  | { type: 'space'; spaceId: string }
  | { type: 'source'; spaceId: string; sourceId: string };

export interface RetrievedPassage {
  passageId: string;
  sourceId: string;
  sourceTitle: string;
  text: string;
  page: number | null;
  paragraphRef: string | null;
  sectionHeading: string | null;
  /** Fused score, descending. Kept for logging and for the §19 measurement. */
  score: number;
}

export interface RetrievalResult {
  passages: RetrievedPassage[];
  /** Candidate counts per half, for logging. Never the text (§17). */
  counts: { vector: number; lexical: number; fused: number };
}

interface CandidateRow {
  id: string;
}

/**
 * The predicate every candidate query is filtered by. Written as SQL because both
 * halves are raw queries (pgvector's `<=>` and `tsvector` have no Prisma
 * equivalent), but built from the *same* exported filter the ORM callers use, so
 * the two cannot drift apart.
 *
 * A current-source scope **adds** `sourceId` to this clause and never replaces
 * it, so a scope naming an archived or still-processing source retrieves nothing
 * rather than retrieving from it.
 */
function eligibility(scope: RetrievalScope): Prisma.Sql {
  const filter = retrievableSources(scope.spaceId);
  const clauses = [
    Prisma.sql`s."spaceId" = ${filter.spaceId}`,
    Prisma.sql`s."state" = ${filter.state}::"SourceState"`,
    // `archivedAt: null` in the exported filter — the one people forget.
    Prisma.sql`s."archivedAt" IS NULL`,
  ];
  if (scope.type === 'source') clauses.push(Prisma.sql`s."id" = ${scope.sourceId}`);
  return Prisma.join(clauses, ' AND ');
}

/** Nearest neighbours by cosine distance. Exact KNN — see the schema comment. */
async function vectorCandidates(
  app: FastifyInstance,
  scope: RetrievalScope,
  queryVector: number[],
  limit: number,
): Promise<string[]> {
  const literal = toVectorLiteral(queryVector);
  const rows = await app.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT p."id"
    FROM "Passage" p
    JOIN "Source" s ON s."id" = p."sourceId"
    WHERE ${eligibility(scope)} AND p."embedding" IS NOT NULL
    ORDER BY p."embedding" <=> ${literal}::vector
    LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}

/**
 * Full-text candidates over the same GIN-indexed `tsv` Phase 3's library search
 * reads. `websearch_to_tsquery` never throws on user input, which matters when
 * the input is an arbitrary question.
 */
async function lexicalCandidates(
  app: FastifyInstance,
  scope: RetrievalScope,
  question: string,
  limit: number,
): Promise<string[]> {
  const rows = await app.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT p."id"
    FROM "Passage" p
    JOIN "Source" s ON s."id" = p."sourceId"
    CROSS JOIN websearch_to_tsquery('english', ${question}) AS tsq(query)
    WHERE ${eligibility(scope)} AND p."tsv" @@ tsq.query
    ORDER BY ts_rank(p."tsv", tsq.query) DESC
    LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}

/** `Σ 1 / (RRF_K + rank)` over the lists a passage appears in. */
function fuse(lists: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  return scores;
}

/**
 * Retrieves the passages an answer may cite.
 *
 * The retrieval query is the user's question, verbatim — no rewriting, no
 * expansion, no LLM-generated search query. The cost is stated in the design: a
 * pronoun-only follow-up ("what about the second one?") retrieves badly and
 * usually earns an insufficiency answer, because the referent lives in the
 * conversation rather than in the question. A hidden rewrite would silently
 * change what the user asked, and the citation would then support a question
 * they did not pose.
 *
 * Notes need no filter here: a `Note` is not a `Source`, this reads `Passage`
 * rows, and nothing ever chunks a note into one. §9's "notes must not be
 * evidence" is a property of the data model, not a clause that could be dropped.
 *
 * **There is no similarity floor, deliberately.** KNN always returns its nearest
 * neighbours, so an off-topic question still retrieves passages and still costs a
 * model call; only a scope with no retrievable passages at all comes back empty.
 * A distance cutoff was considered and rejected: the threshold would be a tuned
 * constant with no principled value — the same objection that ruled out weighted
 * score fusion — and it would make the product refuse to *look*, answering "no
 * evidence" for a well-posed question whose source happens to use other words.
 * A model reading the excerpts and saying they do not cover the question is both
 * more accurate and what §9 asks for. The design originally said "none above the
 * floor"; this is the amendment.
 */
export async function retrieve(
  app: FastifyInstance,
  scope: RetrievalScope,
  question: string,
): Promise<RetrievalResult> {
  const candidates = env.RETRIEVAL_CANDIDATES;

  // One embedding call for the question. A failure here is the caller's to
  // report as a §16 assistant failure — it must not become an empty retrieval,
  // which the user would read as "no evidence found".
  const [queryVector] = await embed([question], 'query');
  if (!queryVector) {
    throw new Error('embed() returned no vector for the question (bug: bounds should match).');
  }

  // Independent halves, so they run concurrently: the whole of retrieval sits
  // inside §19's 8 s budget alongside the model call.
  const [vector, lexical] = await Promise.all([
    vectorCandidates(app, scope, queryVector, candidates),
    lexicalCandidates(app, scope, question, candidates),
  ]);

  const scores = fuse([vector, lexical]);
  if (scores.size === 0) {
    return { passages: [], counts: { vector: 0, lexical: 0, fused: 0 } };
  }

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, env.RETRIEVAL_TOP_K)
    .map(([id]) => id);

  // Hydrating through Prisma rather than in the candidate queries keeps the text
  // out of two raw result sets and means the locator columns are read exactly
  // once, from the row a citation will later be built from.
  const rows = await app.prisma.passage.findMany({
    where: { id: { in: topIds } },
    select: {
      id: true,
      sourceId: true,
      text: true,
      page: true,
      paragraphRef: true,
      sectionHeading: true,
      source: { select: { title: true } },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const passages = topIds.flatMap<RetrievedPassage>((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        passageId: row.id,
        sourceId: row.sourceId,
        sourceTitle: row.source.title,
        text: row.text,
        page: row.page,
        paragraphRef: row.paragraphRef,
        sectionHeading: row.sectionHeading,
        score: scores.get(id) ?? 0,
      },
    ];
  });

  return {
    passages,
    counts: { vector: vector.length, lexical: lexical.length, fused: scores.size },
  };
}

/**
 * The reference shown beside a citation and sent to the model as a document's
 * `context` (PRD §8/§9 both require the reference to be *displayed*, not merely
 * honoured). Page wins over paragraph because a PDF has both a page and an
 * index, and the page is what the reader navigates by.
 */
export function locatorLabel(passage: {
  page: number | null;
  paragraphRef: string | null;
  sectionHeading: string | null;
}): string {
  if (passage.page !== null) return `Page ${passage.page}`;
  if (passage.paragraphRef) {
    const paragraph = /^p(\d+)$/.exec(passage.paragraphRef);
    return paragraph ? `Paragraph ${paragraph[1]}` : passage.paragraphRef;
  }
  if (passage.sectionHeading) return passage.sectionHeading;
  return 'Excerpt';
}
