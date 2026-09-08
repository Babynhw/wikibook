import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { ingestQueue, purgeQueue, type IngestJobData, type PurgeJobData } from '../lib/queue.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Enqueue ingests from the API process; consumed by the worker process. */
    ingestQueue: Queue<IngestJobData>;
    /** Deferred object deletion; consumed by the worker process. */
    purgeQueue: Queue<PurgeJobData>;
  }
}

/** Owning the two queue connections in one place so shutdown is symmetric. */
export default fp(async function queuesPlugin(app: FastifyInstance) {
  const ingest = ingestQueue();
  const purge = purgeQueue();

  app.decorate('ingestQueue', ingest);
  app.decorate('purgeQueue', purge);

  app.addHook('onClose', async () => {
    await Promise.allSettled([ingest.close(), purge.close()]);
  });
});
