import { env } from '../config.js';

/**
 * `dimension_mismatch` and `unauthorized` are load-bearing: `src/index.ts` exits
 * the process on them and only warns on the others, and `ingest/persist.ts`
 * refuses to retry them. Both fail identically on every attempt — a wrong model
 * and a rejected token are configuration, not a blip. Match on the code, never
 * on the message.
 */
export type EmbeddingErrorCode =
  | 'unreachable'
  | 'bad_response'
  | 'dimension_mismatch'
  | 'unauthorized';

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  /**
   * Whether the same call is worth repeating. Set by the transport for a 429 or a
   * 5xx from HuggingFace's shared fleet; a wrong dimension or a rejected token is
   * never retryable, so this is a property of the occasion rather than of the code.
   */
  readonly retryable: boolean;

  constructor(
    code: EmbeddingErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, options);
    this.name = 'EmbeddingError';
    this.code = code;
    this.retryable = options?.retryable ?? code === 'unreachable';
  }
}

/**
 * Which side of the retrieval pair is being embedded.
 *
 * Asymmetric models — e5, nomic, bge — are trained with a task prefix on each
 * input and lose real accuracy without one, so the task is a required argument
 * rather than a default: a new call site has to state which side it is on. The
 * prefixes themselves are configuration (`EMBEDDING_QUERY_PREFIX` /
 * `EMBEDDING_PASSAGE_PREFIX`) because they belong to the model, not to us; a
 * symmetric model sets both blank.
 *
 * Changing a prefix changes every vector the model produces, so it invalidates
 * the stored embeddings exactly like a model swap does: re-embed with
 * `pnpm reprocess:sources --all`.
 */
export type EmbeddingTask = 'query' | 'passage';

interface HuggingFaceError {
  error?: string | { message?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Attempts per `embed()` call, including the first. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Statuses worth a second try: HuggingFace's shared inference fleet answers 429
 * when a burst is too wide and 5xx while a cold model is still being placed.
 * Everything else — 400, 401, 404 — is settled and retrying only wastes quota.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * In-process cache of single-input query embeddings.
 *
 * HuggingFace's serverless Inference API has a real cost on every ask: a network
 * round-trip that, when the model has scaled to idle, also blocks on cold model
 * placement (`x-wait-for-model: true`). Re-asked questions, follow-ups that
 * restate the previous one, the startup warm-up, and the dimension check are all
 * deterministic for a fixed model + prefix, so they can reuse a stored vector.
 *
 * Only single-input calls are cached — passage ingestion batches diverge and
 * would only make this a memory bound with no hit rate — and it is bounded by an
 * insertion-order LRU so a long session cannot grow without limit.
 */
const cacheKey = (task: EmbeddingTask, text: string): string => `${task}:${text}`;

let cacheLimit = env.EMBEDDING_CACHE_SIZE;
const cache = new Map<string, number[]>();

/** Override the cache size. Intended for tests; production reads `EMBEDDING_CACHE_SIZE`. */
export function setEmbeddingCacheSize(size: number): void {
  cacheLimit = Math.max(0, Math.floor(size));
}

/** Drop every cached vector. Safe to call from tests or before a model swap. */
export function clearEmbeddingCache(): void {
  cache.clear();
}

function getCached(task: EmbeddingTask, text: string): number[] | undefined {
  if (cacheLimit <= 0) return undefined;
  const key = cacheKey(task, text);
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key); // refresh recency for the LRU
  cache.set(key, hit);
  return hit.slice(); // copy so callers cannot mutate the stored vector
}

function setCached(task: EmbeddingTask, text: string, vector: number[]): void {
  if (cacheLimit <= 0) return;
  const key = cacheKey(task, text);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, vector);
  while (cache.size > cacheLimit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const prefixFor = (task: EmbeddingTask) =>
  task === 'query' ? env.EMBEDDING_QUERY_PREFIX : env.EMBEDDING_PASSAGE_PREFIX;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Best-effort parse, so an HTML proxy page degrades to its own text. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Pulls a message out of HuggingFace's error envelope, which has two shapes. */
function errorDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as HuggingFaceError;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return undefined;
}

/**
 * Batch-embeds text with HuggingFace's serverless Inference API
 * (`POST /models/<model>/pipeline/feature-extraction`).
 *
 * Returns one vector per input, in input order, each prefixed for `task`. Every
 * vector is checked against EMBEDDING_DIM — the dimension is baked into the
 * Prisma schema as vector(768), so a model swap must fail loudly rather than
 * write unusable rows.
 */
export async function embed(
  inputs: string[],
  task: EmbeddingTask,
  options: { timeoutMs?: number; /** Skip the cache (e.g. a keep-warm ping). */ bypassCache?: boolean } = {},
): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const prefix = prefixFor(task);
  const payload = prefix ? inputs.map((input) => `${prefix}${input}`) : inputs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Single-input embedding requests — the question on every ask, a warm-up ping,
  // the startup dimension check — are deterministic for a fixed model + prefix, so
  // reuse the stored vector instead of paying another HuggingFace round-trip.
  // Multi-input batches (passage ingestion) are never cached: their inputs diverge
  // and the cache exists to make re-asked questions cheap, not to buffer batches.
  if (!options.bypassCache && inputs.length === 1) {
    const cached = getCached(task, payload[0]!);
    if (cached) return [cached];
  }

  let lastRetryable: EmbeddingError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = check(await request(payload, timeoutMs), inputs.length);
      if (!options.bypassCache && inputs.length === 1) setCached(task, payload[0]!, result[0]!);
      return result;
    } catch (error) {
      // Only a 429/5xx or an unreachable host is worth repeating; anything else —
      // a wrong dimension, a rejected token, a body that is not JSON — is settled
      // and propagates now.
      if (!(error instanceof EmbeddingError) || !error.retryable) throw error;
      lastRetryable = error;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw lastRetryable ?? new EmbeddingError('bad_response', 'Embedding call made no attempt.');
}

/** One HTTP round-trip. Returns the parsed body; throws EmbeddingError. */
async function request(payload: string[], timeoutMs: number): Promise<unknown> {
  const url = new URL(
    `models/${env.EMBEDDING_MODEL}/pipeline/feature-extraction`,
    // A trailing slash keeps the model path from replacing the provider segment
    // of HF_BASE_URL (`/hf-inference`) instead of appending to it.
    `${env.HF_BASE_URL.replace(/\/+$/, '')}/`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const unreachable = (error: unknown) =>
    new EmbeddingError(
      'unreachable',
      `Could not reach the embedding service at ${env.HF_BASE_URL}.`,
      { cause: error },
    );

  // `fetch` resolves as soon as the headers arrive, so the body reads below must
  // stay inside this try — otherwise the abort timer is already cleared and a
  // stalled response stream hangs forever.
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.HF_API_KEY ? { authorization: `Bearer ${env.HF_API_KEY}` } : {}),
          // Blocks until a cold model is loaded instead of answering 503 with an
          // `estimated_time` we would only turn around and sleep on ourselves.
          'x-wait-for-model': 'true',
        },
        body: JSON.stringify({ inputs: payload }),
        signal: controller.signal,
      });
    } catch (error) {
      throw unreachable(error);
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      // An unauthenticated call to the router answers with a full HTML sign-in
      // page; quoting 200 characters of it buries the real message.
      const detail =
        errorDetail(parseJson(raw)) ?? (raw.trimStart().startsWith('<') ? '' : raw.slice(0, 200));

      if (response.status === 401 || response.status === 403) {
        throw new EmbeddingError(
          'unauthorized',
          `HuggingFace rejected the credential (${response.status})${detail ? `: ${detail}` : ''}. ` +
            'Set HF_API_KEY to a token with "Make calls to Inference Providers" permission.',
        );
      }
      if (response.status === 404) {
        throw new EmbeddingError(
          'bad_response',
          `HuggingFace has no serverless feature-extraction endpoint for model ` +
            `"${env.EMBEDDING_MODEL}" (404)${detail ? `: ${detail}` : ''}. Not every model on the ` +
            'Hub is served: check the model page for a live inference provider, or run the model ' +
            'yourself and point HF_BASE_URL at it.',
        );
      }

      throw new EmbeddingError(
        'bad_response',
        `Embedding service returned ${response.status}${detail ? `: ${detail}` : ''}`,
        { retryable: RETRYABLE_STATUS.has(response.status) },
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch (error) {
      // A body that never finishes arriving aborts here, not at the fetch.
      if (controller.signal.aborted) throw unreachable(error);
      throw new EmbeddingError(
        'bad_response',
        'Embedding service returned a body that is not JSON.',
        { cause: error },
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validates the feature-extraction body: a plain `number[][]`, one row per input,
 * every row EMBEDDING_DIM wide.
 */
function check(body: unknown, expected: number): number[][] {
  if (!Array.isArray(body)) {
    const detail = errorDetail(body);
    throw new EmbeddingError(
      'bad_response',
      detail
        ? `Embedding service returned an error body: ${detail}`
        : 'Embedding service did not return an array of vectors.',
    );
  }

  if (body.length !== expected) {
    throw new EmbeddingError(
      'bad_response',
      `Embedding service returned ${body.length} vectors for ${expected} inputs.`,
    );
  }

  for (const vector of body) {
    if (!Array.isArray(vector)) {
      throw new EmbeddingError(
        'bad_response',
        'Embedding service returned a row that is not a vector.',
      );
    }
    // A model served without sentence-pooling answers one vector *per token*,
    // which arrives as a well-formed 3-D array rather than an error.
    if (Array.isArray(vector[0])) {
      throw new EmbeddingError(
        'dimension_mismatch',
        `Model "${env.EMBEDDING_MODEL}" returned token-level embeddings, not one vector per ` +
          'input. It needs a sentence-transformers pooling configuration; pick a model whose ' +
          'Hub page lists the sentence-similarity or feature-extraction task.',
      );
    }
    if (vector.length !== env.EMBEDDING_DIM) {
      throw new EmbeddingError(
        'dimension_mismatch',
        `Embedding dimension mismatch: model "${env.EMBEDDING_MODEL}" returned ` +
          `${vector.length} dimensions, but the database column is ` +
          `vector(${env.EMBEDDING_DIM}). Changing the embedding model requires a ` +
          `migration and a full re-embed.`,
      );
    }
  }

  return body as number[][];
}

/**
 * Startup gate: proves the configured model is served and its dimension matches
 * the schema. Throws EmbeddingError with an actionable message otherwise.
 *
 * Embeds as a `query`: it is the cheaper of the two prefixes and the one a user's
 * very next action exercises.
 */
export async function assertEmbeddingDimension(): Promise<number> {
  const [vector] = await embed(['dimension check'], 'query', { timeoutMs: 60_000 });
  if (!vector) {
    throw new EmbeddingError(
      'bad_response',
      'Embedding service returned no vector for the startup check.',
    );
  }
  return vector.length;
}

/** Formats a vector for a pgvector parameter (`$1::vector`). */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
