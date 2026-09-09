import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite talks to the docker-compose Postgres, so tests share one worker
    // and clean up after themselves.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    env: {
      // Asking is capped at 20 questions per minute per user in production. One
      // suite file legitimately asks more than that against a shared account, and
      // the 429 arrives as a JSON envelope instead of a stream — which surfaces as
      // a confusing "no `done` event" several tests later. Raised here rather than
      // relaxed in the route, so the limiter itself still runs.
      ANSWER_RATE_PER_MINUTE: '2000',
      // Pinned so the suite does not read a developer's own `.env`: flipping this
      // locally made an adapter test fail with no code change, which is a test
      // depending on ambient config rather than on the thing it asserts.
      ANSWER_PROVIDER_ROUTING: 'true',
      // The default dialect the adapter computes its body spelling from. Pinned
      // for the same reason: the regression test asserts the default spelling,
      // and a local `.env` that set the older one would fail it with no code
      // change. The older-dialect path is covered by a provider constructed
      // with the option set explicitly.
      ANSWER_MAX_TOKENS_PARAM: 'max_completion_tokens',
      ANSWER_PROVIDER: 'anthropic',
      // Off in tests: the embeddings suite asserts exact `fetch` call counts
      // against reused inputs (e.g. 'a'), and a cache would serve the second
      // call from memory.
      EMBEDDING_CACHE_SIZE: '0',
      // Short enough that the OpenAI-compatible tier's timeout can be asserted by
      // letting it actually fire, rather than by mocking a native `AbortSignal`
      // that `vi.useFakeTimers` does not reach. Every other test answers from a
      // stub immediately, so nothing else comes near it.
      ANSWER_TIMEOUT_MS: '1500',
    },
  },
});
