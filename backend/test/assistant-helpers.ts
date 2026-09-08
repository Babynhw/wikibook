import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {
  AnswerEvent,
  AnswerProvider,
  AnswerRequest,
  ProviderCapabilities,
} from '../src/lib/answer-provider.js';
import { embed, toVectorLiteral } from '../src/lib/embeddings.js';
import { Prisma } from '../src/generated/prisma/client.js';

/**
 * A provider whose output is a fixed script.
 *
 * This is the line between what CI can assert and what it cannot. Everything
 * *around* the model is asserted here — which passages were retrieved, which
 * documents were sent, that an out-of-range citation index is dropped, that a
 * locator comes from the `Passage` row. Model behaviour itself (is the answer
 * genuinely insufficient, is a conflict presented without being resolved) is
 * hand-verified against the real API and recorded in the plan's implementation
 * notes: a test that asks a model to disagree with itself and asserts on prose is
 * a flake with a rationale.
 */
export interface ScriptedProvider extends AnswerProvider {
  /** Every request the provider was asked to answer, in order. */
  readonly requests: AnswerRequest[];
  /** How many times a title was generated. */
  readonly titleCalls: number;
}

export function scriptedProvider(options: {
  events: AnswerEvent[];
  capabilities?: Partial<ProviderCapabilities>;
  title?: string | (() => Promise<string>);
  /** Throws instead of yielding — the transport-failure path. */
  fail?: Error;
  /** Fails the test if the provider is called at all. */
  mustNotBeCalled?: boolean;
}): ScriptedProvider {
  const requests: AnswerRequest[] = [];
  let titleCalls = 0;

  const provider: ScriptedProvider = {
    id: 'scripted',
    capabilities: {
      citations: 'native',
      quote: 'extracted',
      thinking: 'adaptive',
      effortLevels: ['low'],
      ...options.capabilities,
    },
    get requests() {
      return requests;
    },
    get titleCalls() {
      return titleCalls;
    },
    async *answer(request: AnswerRequest): AsyncIterable<AnswerEvent> {
      if (options.mustNotBeCalled) {
        throw new Error('the provider was called, but this test asserts it never is');
      }
      requests.push(request);
      if (options.fail) throw options.fail;
      for (const event of options.events) yield event;
    },
    async title(question: string): Promise<string> {
      titleCalls += 1;
      if (typeof options.title === 'function') return options.title();
      return options.title ?? 'Scripted title';
    },
  };

  return provider;
}

/** Convenience: a plain grounded answer citing the documents at `indexes`. */
export function groundedScript(text: string, indexes: number[], quote = ''): AnswerEvent[] {
  return [
    { type: 'delta', text },
    ...indexes.map<AnswerEvent>((documentIndex) => ({
      type: 'citation',
      documentIndex,
      quotedText: quote,
    })),
    { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    { type: 'stop', reason: 'end' },
  ];
}

export interface SeededPassage {
  text: string;
  page?: number | null;
  paragraphRef?: string | null;
  sectionHeading?: string | null;
}

/**
 * Creates a ready source with real embeddings and a real `tsv`, written the same
 * way `ingest/persist.ts` writes them — raw SQL in one statement, so the vector
 * and the FTS column cannot describe different text.
 */
export async function seedSource(
  app: FastifyInstance,
  spaceId: string,
  options: {
    title: string;
    passages: SeededPassage[];
    state?: 'ready' | 'processing' | 'failed';
    archived?: boolean;
    author?: string | null;
  },
): Promise<{ sourceId: string; passageIds: string[] }> {
  const source = await app.prisma.source.create({
    data: {
      spaceId,
      type: 'manual',
      title: options.title,
      author: options.author ?? null,
      content: options.passages.map((passage) => passage.text).join('\n'),
      state: options.state ?? 'ready',
      archivedAt: options.archived ? new Date() : null,
    },
    select: { id: true },
  });

  const vectors = await embed(
    options.passages.map((passage) => passage.text),
    'passage',
  );
  const passageIds: string[] = [];

  for (const [index, passage] of options.passages.entries()) {
    const vector = vectors[index];
    if (!vector) throw new Error('embed() returned no vector for a seeded passage');
    const rows = await app.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO "Passage" ("id", "sourceId", "ord", "text", "page", "paragraphRef", "sectionHeading", "startBlockOrd", "endBlockOrd", "embedding", "tsv")
      VALUES (
        gen_random_uuid()::text,
        ${source.id},
        ${index + 1},
        ${passage.text},
        ${passage.page ?? null},
        ${passage.paragraphRef ?? `p${index + 1}`},
        ${passage.sectionHeading ?? null},
        ${index + 1},
        ${index + 1},
        ${toVectorLiteral(vector)}::vector,
        to_tsvector('english', ${passage.text})
      )
      RETURNING "id"
    `);
    const id = rows[0]?.id;
    if (!id) throw new Error('seeded passage insert returned no id');
    passageIds.push(id);
  }

  // Blocks matching the passages, so a citation can resolve to a reader location
  // exactly as it does for an ingested source.
  for (const [index, passage] of options.passages.entries()) {
    await app.prisma.sourceBlock.create({
      data: {
        sourceId: source.id,
        ord: index + 1,
        text: passage.text,
        page: passage.page ?? null,
        paragraphIndex: passage.page ? null : index + 1,
        heading: passage.sectionHeading ?? null,
      },
    });
  }

  return { sourceId: source.id, passageIds };
}

/** Parses an SSE body into the list of JSON payloads it carried. */
export function parseSse(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .flatMap((chunk) => {
      const line = chunk.split('\n').find((part) => part.startsWith('data: '));
      if (!line) return [];
      try {
        return [JSON.parse(line.slice(6)) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/**
 * Asks a question over a real TCP connection and returns the whole stream.
 *
 * `app.inject()` cannot be used for the answer: the route hijacks its reply, and
 * a hijacked response writes to the raw socket, which light-my-request does not
 * capture (the lesson Phase 2's `events.test.ts` records). The paths that are
 * refused *before* the hijack — 404, 409, 503 — do answer through `inject`, and
 * the tests use it for exactly those.
 *
 * Unlike the space event stream, an answer stream ends on its own, so the body
 * can simply be collected.
 */
export function ask(
  baseUrl: string,
  cookie: string,
  conversationId: string,
  question: string,
  options: { abortAfterFirstEvent?: boolean } = {},
): Promise<{ statusCode: number; events: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ question });
    const request = http.request(
      `${baseUrl}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        // A fresh non-keep-alive agent: the global agent can route a later
        // request onto a socket this one hijacked.
        agent: new http.Agent({ keepAlive: false }),
      },
      (response) => {
        let raw = '';
        let aborted = false;
        response.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
          if (options.abortAfterFirstEvent && !aborted && raw.includes('\n\n')) {
            aborted = true;
            // Simulates the user closing the tab mid-answer.
            request.destroy();
            resolve({ statusCode: response.statusCode ?? 0, events: parseSse(raw) });
          }
        });
        response.on('end', () => {
          if (!aborted) resolve({ statusCode: response.statusCode ?? 0, events: parseSse(raw) });
        });
        response.on('error', (error) => {
          if (!aborted) reject(error);
        });
      },
    );
    request.on('error', (error) => {
      if (!options.abortAfterFirstEvent) reject(error);
    });
    request.end(body);
  });
}

export async function createConversation(
  app: FastifyInstance,
  cookie: string,
  spaceId: string,
  body: { scopeType: 'space' | 'source'; scopeSourceId?: string } = { scopeType: 'space' },
) {
  const response = await app.inject({
    method: 'POST',
    url: `/spaces/${spaceId}/conversations`,
    headers: { cookie },
    payload: body,
  });
  if (response.statusCode !== 201) {
    throw new Error(`createConversation failed (${response.statusCode}): ${response.body}`);
  }
  return (response.json() as { conversation: { id: string } }).conversation.id;
}
