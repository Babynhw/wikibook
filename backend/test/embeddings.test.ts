import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config.js';
import { embed, EmbeddingError } from '../src/lib/embeddings.js';

/**
 * Every branch in `src/lib/embeddings.ts` is an error branch, and `src/index.ts`
 * decides whether to exit the process from `EmbeddingError.code` — so each code is
 * asserted explicitly, not just the fact that something threw.
 *
 * `fetch` is stubbed throughout: no HuggingFace call, and no token, required.
 */
describe('embed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (impl: () => Promise<unknown>) => {
    vi.stubGlobal('fetch', vi.fn(impl));
  };

  /** A response object with only the parts `embed` touches. */
  const jsonResponse = (body: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  /**
   * HuggingFace's feature-extraction pipeline answers a bare `number[][]`, not an
   * envelope — the shape every assertion below is built on.
   */
  const vectorsResponse = (vectors: number[][]) => jsonResponse(vectors);

  const vector = (length: number) => Array.from({ length }, () => 0.1);

  it('returns one vector per input, in order', async () => {
    const first = vector(env.EMBEDDING_DIM);
    const second = vector(env.EMBEDDING_DIM);
    stubFetch(async () => vectorsResponse([first, second]));

    const result = await embed(['a', 'b'], 'passage');
    expect(result).toEqual([first, second]);
  });

  /**
   * The prefix is the whole reason `task` is a required argument: an asymmetric
   * model scores a passage embedded as a query noticeably worse, and the mistake
   * is invisible in the output — every vector still has the right dimension.
   */
  /** Records what `embed` actually put on the wire. */
  const recordFetch = () => {
    const calls: { url: string; inputs: string[] }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string, init?: RequestInit) => {
        const { inputs } = JSON.parse(String(init?.body)) as { inputs: string[] };
        calls.push({ url: String(url), inputs });
        return Promise.resolve(vectorsResponse([vector(env.EMBEDDING_DIM)]));
      }),
    );
    return calls;
  };

  it('prefixes each input for the task', async () => {
    const calls = recordFetch();

    await embed(['hello'], 'query');
    await embed(['hello'], 'passage');

    expect(calls[0]?.inputs).toEqual([`${env.EMBEDDING_QUERY_PREFIX}hello`]);
    expect(calls[1]?.inputs).toEqual([`${env.EMBEDDING_PASSAGE_PREFIX}hello`]);
  });

  it("posts to the model's feature-extraction pipeline under HF_BASE_URL", async () => {
    const calls = recordFetch();

    await embed(['a'], 'query');

    // The provider segment of HF_BASE_URL (`/hf-inference`) must survive: a
    // relative `URL` join without the trailing slash silently replaces it.
    expect(calls[0]?.url).toBe(
      `${env.HF_BASE_URL}/models/${env.EMBEDDING_MODEL}/pipeline/feature-extraction`,
    );
  });

  it('short-circuits an empty input without calling the service', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    expect(await embed([], 'query')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports an unreachable service as `unreachable`', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    const error = await embed(['a'], 'query', { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).code).toBe('unreachable');
    // The original failure is preserved for the log, not swallowed.
    expect((error as EmbeddingError).cause).toBeInstanceOf(Error);
  });

  it('reports a non-2xx response as `bad_response`', async () => {
    stubFetch(async () => jsonResponse({ error: 'Bad request' }, false, 400));

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect((error as EmbeddingError).code).toBe('bad_response');
    expect((error as EmbeddingError).message).toContain('400');
    // HuggingFace's error envelope is unwrapped rather than dumped as JSON.
    expect((error as EmbeddingError).message).toContain('Bad request');
  });

  /**
   * Most Hub models have no serverless inference provider at all, so a 404 is the
   * likeliest way a model swap fails — and it must not read as "the service is
   * down". `nomic-embed-text` is exactly this case.
   */
  it('explains a 404 as a model that is not served', async () => {
    stubFetch(async () => jsonResponse({ error: 'Not Found' }, false, 404));

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect((error as EmbeddingError).code).toBe('bad_response');
    expect((error as EmbeddingError).message).toContain('serverless feature-extraction');
    expect((error as EmbeddingError).retryable).toBe(false);
  });

  /**
   * `unauthorized` is load-bearing twice over: `index.ts` exits on it and
   * `persist.ts` refuses to retry it, because a rejected token will reject
   * identically forever.
   */
  it('reports a rejected token as `unauthorized`, and never retries it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Invalid credentials' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect((error as EmbeddingError).code).toBe('unauthorized');
    expect((error as EmbeddingError).message).toContain('HF_API_KEY');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and returns the vectors the retry produces', async () => {
    const vectors = [vector(env.EMBEDDING_DIM)];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Rate limit reached' }, false, 429))
      .mockResolvedValueOnce(vectorsResponse(vectors));
    vi.stubGlobal('fetch', fetchMock);

    expect(await embed(['a'], 'query')).toEqual(vectors);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and reports the last transient failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'overloaded' }, false, 503));
    vi.stubGlobal('fetch', fetchMock);

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect((error as EmbeddingError).code).toBe('bad_response');
    expect((error as EmbeddingError).message).toContain('503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports a body that is not JSON as `bad_response`, not a raw SyntaxError', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
      text: async () => '<html>proxy error</html>',
    }));

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).code).toBe('bad_response');
  });

  it('rejects a vector count that does not match the inputs', async () => {
    stubFetch(async () => vectorsResponse([vector(env.EMBEDDING_DIM)]));

    const error = await embed(['a', 'b'], 'passage').catch((e: unknown) => e);
    expect((error as EmbeddingError).code).toBe('bad_response');
    expect((error as EmbeddingError).message).toContain('1 vectors for 2 inputs');
  });

  it('rejects a wrong dimension with `dimension_mismatch` — the code index.ts exits on', async () => {
    stubFetch(async () => vectorsResponse([vector(env.EMBEDDING_DIM - 1)]));

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).code).toBe('dimension_mismatch');
  });

  /**
   * A model served without sentence-pooling answers one vector per *token*. That
   * arrives as a well-formed 3-D array, not an error, so without this check the
   * first row's length is a token count that could coincidentally be 768.
   */
  it('rejects token-level embeddings as `dimension_mismatch`', async () => {
    stubFetch(async () => jsonResponse([[vector(env.EMBEDDING_DIM), vector(env.EMBEDDING_DIM)]]));

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect((error as EmbeddingError).code).toBe('dimension_mismatch');
    expect((error as EmbeddingError).message).toContain('token-level');
  });

  /** HuggingFace sometimes answers 200 with an error envelope instead of vectors. */
  it('rejects an error envelope returned with a 200', async () => {
    stubFetch(async () => jsonResponse({ error: 'Model is currently loading' }));

    const error = await embed(['a'], 'query').catch((e: unknown) => e);
    expect((error as EmbeddingError).code).toBe('bad_response');
    expect((error as EmbeddingError).message).toContain('Model is currently loading');
  });

  it('clears the abort timer once the body is read, so a slow body cannot hang', async () => {
    // The bug this guards: `clearTimeout` used to run when the headers arrived,
    // leaving the body read unbounded. Aborting mid-body must surface as an error
    // rather than never settling.
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      },
      text: async () => '',
    }));

    const error = await embed(['a'], 'query', { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
  });
});
