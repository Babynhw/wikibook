import 'dotenv/config';
import { pino } from 'pino';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env, isProduction, loadLimits } from './config.js';
import { createPrismaClient } from './lib/prisma.js';
import { createBullConnection, INGEST_QUEUE_NAME, PURGE_QUEUE_NAME, type IngestJobData, type PurgeJobData } from './lib/queue.js';
import { getObject, removeObject, ensureBucket } from './lib/storage.js';
import { embed } from './lib/embeddings.js';
import { runSourceIngestion, type IngestLogger } from './ingest/pipeline.js';
import { isUnretryable } from './ingest/errors.js';
import { markSourceFailed } from './ingest/persist.js';

/**
 * The ingestion worker: a separate process from the API
 * (wiki-docs/plan/phase-2-ingestion/design.md "The worker is a separate
 * process"). Parsing a large PDF is CPU-bound inside pdf.js; in the API process
 * it would stall the event loop, so the worker owns that work and can be
 * restarted, scaled, or crashed without touching sessions.
 *
 * Logs carry the source id and never source content (PRD §17).
 */

const logger = pino({
  level: 'info',
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
});

const ingestLogger: IngestLogger = {
  info: (context, message) => logger.info(context, message),
  warn: (context, message) => logger.warn(context, message),
  error: (context, message) => logger.error(context, message),
};

const prisma = createPrismaClient(env.DATABASE_URL);
const workerConnection = createBullConnection();
const publisher = new Redis(env.REDIS_URL);

// The one-time bucket bootstrap in compose may not have run yet (dev machines,
// tests); creating it here is belt-and-braces and idempotent.
await ensureBucket().catch((error: unknown) => {
  logger.warn({ err: error }, 'bucket ensure failed — uploads will fail until it is created');
});

const publish = (spaceId: string, event: { sourceId: string; state: string; errorMessage?: string }) =>
  publisher.publish(`space:${spaceId}`, JSON.stringify(event));

const deps = {
  prisma,
  storage: { getObject },
  embed,
  fetchFn: fetch,
  publish: async (spaceId: string, event: Parameters<typeof publish>[1]) => {
    await publish(spaceId, event).catch((error: unknown) => {
      logger.warn({ err: error, spaceId }, 'state publish failed');
    });
  },
  logger: ingestLogger,
};

const ingestWorker = new Worker<IngestJobData>(
  INGEST_QUEUE_NAME,
  async (job) => {
    const { sourceId, spaceId, userId } = job.data;
    logger.info({ sourceId, spaceId, attempt: job.attemptsMade + 1 }, 'ingest job started');
    try {
      await runSourceIngestion(deps, sourceId);
      logger.info({ sourceId }, 'ingest job finished');
    } catch (error) {
      // The pipeline already handled permanent failures (marked failed,
      // published, returned normally). Anything that escapes is transient —
      // BullMQ retries it with backoff. Terminal attempt: mark failed so a
      // source is never left silently `processing`.
      if (isUnretryable(error)) {
        // The source is already `failed` with its message; the job did its work,
        // so it completes. Forcing it to `failed` here would fight BullMQ for the
        // job lock and log "Missing lock ... moveToFinished" for every bad file.
        logger.warn({ err: error, sourceId }, 'permanent ingest failure');
        return;
      }
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        logger.warn({ err: error, sourceId, attempts: job.attemptsMade + 1 }, 'ingest exhausted its attempts');
        await markSourceFailed(prisma, {
          userId,
          spaceId,
          sourceId,
          message: 'Processing failed after repeated attempts. Please try again.',
        }).catch((writeError: unknown) => {
          logger.error({ err: writeError, sourceId }, 'failed to mark exhausted source as failed');
        });
        await publish(spaceId, { sourceId, state: 'failed', errorMessage: 'Processing failed after repeated attempts. Please try again.' }).catch(() => {});
        // Rethrow: BullMQ records the failure itself, and with the attempts
        // exhausted there is no further retry to suppress.
        throw error;
      }
      logger.warn({ err: error, sourceId, attempt: job.attemptsMade + 1 }, 'transient ingest failure — will retry');
      throw error;
    }
  },
  { connection: workerConnection, concurrency: env.INGEST_CONCURRENCY },
);

const purgeWorker = new Worker<PurgeJobData>(
  PURGE_QUEUE_NAME,
  async (job) => {
    logger.info({ key: job.data.key }, 'purging object');
    await removeObject(job.data.key);
  },
  { connection: workerConnection },
);

ingestWorker.on('failed', (job: Job<IngestJobData> | undefined, error: Error) => {
  if (job) logger.warn({ err: error, sourceId: job.data.sourceId }, 'ingest job failed');
});
purgeWorker.on('failed', (job: Job<PurgeJobData> | undefined, error: Error) => {
  if (job) logger.error({ err: error, key: job.data.key }, 'purge failed — orphan object remains');
});

// `/health` in the API can't see this process's queue connections; the probe
// below keeps the worker's own view honest during local development.
await loadLimits(prisma, true).catch((error: unknown) => {
  logger.error({ err: error }, 'failed to read AppConfig limits at worker boot');
});

logger.info({ concurrency: env.INGEST_CONCURRENCY }, 'ingestion worker listening');

async function shutdown() {
  logger.info('worker shutting down');
  await Promise.allSettled([ingestWorker.close(), purgeWorker.close()]);
  workerConnection.disconnect();
  publisher.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());