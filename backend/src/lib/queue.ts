import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config.js';

/**
 * BullMQ queues for ingestion (wiki-docs/plan/phase-2-ingestion/design.md).
 *
 * The API process enqueues; the worker process (`src/worker.ts`) consumes. Each
 * process owns its own connection — never share a connection that BullMQ
 * manages, and never reuse `app.redis`: BullMQ needs `maxRetriesPerRequest:
 * null`, which the API's ioredis deliberately does not set.
 */
export const INGEST_QUEUE_NAME = 'ingest';
export const PURGE_QUEUE_NAME = 'purge-object';

export interface IngestJobData {
  sourceId: string;
  spaceId: string;
  userId: string;
}

export interface PurgeJobData {
  key: string;
}

/**
 * `maxRetriesPerRequest: null` is the one BullMQ requirement on the connection:
 * a job whose command latencies outlive a retry must not be dropped.
 */
export function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export function ingestQueue(): Queue<IngestJobData> {
  return new Queue(INGEST_QUEUE_NAME, { connection: createBullConnection() });
}

export function purgeQueue(): Queue<PurgeJobData> {
  return new Queue(PURGE_QUEUE_NAME, { connection: createBullConnection() });
}

/**
 * The queue options every ingest job is enqueued with: a deterministic `jobId`
 * makes the queue a second line of defence behind the source's own state guard
 * (see design "Retry reuses the source row; the queue is not the guard"), and
 * transient failures retry three times with exponential backoff while the
 * source stays `processing`.
 *
 * BullMQ does not allow `:` in custom job ids, so the id is the plain source
 * id — still globally unique, still deterministic per source.
 */
export function ingestJobOptions(sourceId: string) {
  return {
    jobId: sourceId,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 1_000 },
  };
}