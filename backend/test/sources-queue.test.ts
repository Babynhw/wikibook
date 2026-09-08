import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Worker } from 'bullmq';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import { createBullConnection, INGEST_QUEUE_NAME } from '../src/lib/queue.js';

/**
 * A separate file from `sources.test.ts` for the same reason `auth-hardening` is
 * separate from `auth`: `@fastify/rate-limit` keeps one in-memory bucket per app
 * instance, and `/auth/register` allows 10/minute — this suite needs its own
 * budget, and its own long-running BullMQ worker.
 */
describe('sources and the ingest queue', () => {
  let app: FastifyInstance;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  /**
   * The regression the mocked suites could not see, found by running the
   * pipeline for real: BullMQ keeps settled jobs, and `add` with an existing
   * `jobId` is a silent no-op — so a retry answered 200, moved the source to
   * `processing`, and queued nothing. Every retry after the first job settled
   * left the source stuck in `processing` forever.
   */
  it('re-enqueues a retry even after the previous job has already settled', async () => {
    const email = uniqueEmail('queue');
    emails.push(email);
    const { cookie } = await registerUser(app, email);
    const spaceId = await createSpace(app, cookie, 'Retry after a settled job');

    // Redis keeps whatever earlier runs and suites left queued, and the throwing
    // worker below would grind through that backlog three attempts at a time
    // before reaching this test's job. Start from an empty queue.
    await app.ingestQueue.drain(true);

    const created = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceId}/sources`,
      headers: { cookie },
      payload: { type: 'manual', title: 'Second chance', content: 'x' },
    });
    const source = created.json().source;

    // Burn the job's attempts with a worker that always throws, so the job ends
    // up in BullMQ's `failed` set under the source's id — the state the bug hid
    // behind. `attempts: 3` with a 1 s exponential backoff settles in ~3 s.
    const failing = new Worker(
      INGEST_QUEUE_NAME,
      () => {
        throw new Error('deliberate test failure');
      },
      { connection: createBullConnection() },
    );
    try {
      // Poll for the state that matters — a job with a `finishedOn` stamp —
      // rather than counting 'failed' events, whose attempt numbering is
      // BullMQ's business.
      const deadline = Date.now() + 25_000;
      let settled = false;
      while (Date.now() < deadline && !settled) {
        const job = await app.ingestQueue.getJob(source.id);
        settled = (job?.finishedOn ?? 0) > 0;
        if (!settled) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(settled).toBe(true);
    } finally {
      await failing.close();
    }

    await app.prisma.source.update({
      where: { id: source.id },
      data: { state: 'failed', errorMessage: 'Processing failed after repeated attempts.' },
    });

    const retried = await app.inject({
      method: 'POST',
      url: `/sources/${source.id}/retry`,
      headers: { cookie },
    });
    expect(retried.statusCode).toBe(200);

    // A fresh, unsettled job is what makes that 200 honest.
    const requeued = await app.ingestQueue.getJob(source.id);
    expect(requeued).toBeDefined();
    expect(requeued?.finishedOn).toBeUndefined();
    expect(requeued?.attemptsMade).toBe(0);
    // Best-effort: a job another worker has already picked up refuses removal,
    // and this is clean-up, not the assertion.
    await requeued?.remove().catch(() => {});
  }, 40_000);
});
