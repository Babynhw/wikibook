import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env, isProduction } from '../config.js';

const dependencySchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  detail: z.string().optional(),
});

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: dependencySchema,
  redis: dependencySchema,
  queue: dependencySchema,
  embeddings: dependencySchema,
});

type Dependency = z.infer<typeof dependencySchema>;

const PROBE_TIMEOUT_MS = 2_000;

/**
 * `/health` is unauthenticated, so a failure detail is world-readable — Prisma
 * reports the connection target, HuggingFace the base URL. The full error always goes
 * to the log; the client only sees it when `exposeDetail` is set, which the route
 * ties to non-production (PRD §16).
 *
 * Exported for the unit test: the flag is a parameter rather than a direct
 * `isProduction` read so both behaviors are reachable without rebuilding the app
 * under a different NODE_ENV.
 */
export async function probe(
  name: string,
  log: FastifyBaseLogger,
  exposeDetail: boolean,
  check: () => Promise<string | void>,
): Promise<Dependency> {
  const startedAt = Date.now();
  try {
    const detail = await withTimeout(check(), PROBE_TIMEOUT_MS);
    // A success detail is as world-readable as a failure one — the queue probe
    // reports depth — so it is gated on the same flag rather than always sent.
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      ...(detail && exposeDetail ? { detail } : {}),
    };
  } catch (error) {
    log.warn({ err: error, dependency: name }, 'health probe failed');
    const detail = error instanceof Error ? error.message : 'unreachable';
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      ...(exposeDetail ? { detail } : {}),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: { response: { 200: healthSchema, 503: healthSchema } },
    },
    async (request, reply) => {
      const expose = !isProduction;
      const [db, redis, queue, embeddings] = await Promise.all([
        probe('db', request.log, expose, async () => {
          await app.prisma.$queryRaw`SELECT 1`;
        }),
        probe('redis', request.log, expose, async () => {
          const pong = await app.redis.ping();
          return pong === 'PONG' ? undefined : `unexpected reply: ${pong}`;
        }),
        // The queue is the one dependency whose absence is invisible until work
        // arrives: the API stays up and sources sit in `processing` forever. A
        // probe next to the others makes that failure visible instead (PRD §16).
        probe('queue', request.log, expose, async () => {
          const counts = await app.ingestQueue.getJobCounts();
          return `ingest waiting=${counts.waiting} active=${counts.active}`;
        }),
        // Deliberately not an embedding call: `/health` is unauthenticated and
        // exempt from the rate limiter, so probing it must not spend inference
        // quota that anyone on the internet can drain. `whoami-v2` is free and
        // proves the two things that actually break — the Hub is reachable and
        // HF_API_KEY is still valid. A model that has lost its serverless
        // provider surfaces on the first real call instead, as a 404 that names
        // the model.
        probe('embeddings', request.log, expose, async () => {
          if (!env.HF_API_KEY) throw new Error('HF_API_KEY is not set');
          const response = await fetch(new URL('/api/whoami-v2', env.HF_HUB_URL), {
            headers: { authorization: `Bearer ${env.HF_API_KEY}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          if (response.status === 401) throw new Error('HF_API_KEY was rejected');
          if (!response.ok) throw new Error(`returned ${response.status}`);
          return `${env.EMBEDDING_MODEL} via ${env.HF_BASE_URL}`;
        }),
      ]);

      const status = db.ok && redis.ok && queue.ok && embeddings.ok ? 'ok' : 'degraded';
      // Postgres is the only hard dependency for the API to be useful at all.
      return reply
        .status(db.ok ? 200 : 503)
        .send({ status, db, redis, queue, embeddings });
    },
  );
};

export default healthRoutes;
