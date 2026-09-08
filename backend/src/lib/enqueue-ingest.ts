import type { FastifyInstance } from 'fastify';
import { markSourceFailed } from '../ingest/persist.js';
import { ingestJobOptions } from './queue.js';

/**
 * Hands a source to the ingest queue, and writes the failure to the source
 * rather than throwing it at the caller.
 *
 * A queue rejection must never leave a source sitting in `processing` with no
 * job coming (PRD §16): the row lands `failed` with a plain-language message the
 * user can act on, and the caller re-reads the row to answer with that state.
 *
 * This lives outside every route on purpose. It is the single copy of the
 * "a queue rejection is written to the source, not thrown" invariant, and the
 * message text below is what the specs assert on — two copies would drift
 * silently.
 */
export async function enqueueOrFail(
  app: FastifyInstance,
  sourceId: string,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  try {
    // BullMQ keeps completed and failed jobs, and `add` with an existing `jobId`
    // is a silent no-op — so a retry would set the source back to `processing`
    // with no job behind it, which is the trap the state guard exists to avoid.
    // Removing the settled job first is what makes the id reusable; an *active*
    // job refuses removal, which is exactly the double-click case to leave alone
    // (design "Retry reuses the source row; the queue is not the guard").
    await app.ingestQueue.remove(sourceId).catch((error: unknown) => {
      app.log.warn({ err: error, sourceId }, 'could not clear the previous ingest job');
    });
    await app.ingestQueue.add('process', { sourceId, spaceId, userId }, ingestJobOptions(sourceId));
    return true;
  } catch (error) {
    app.log.error({ err: error, sourceId, spaceId }, 'failed to enqueue ingest job');
    try {
      await markSourceFailed(app.prisma, {
        userId,
        spaceId,
        sourceId,
        message:
          'Processing could not be started. Check that the pipeline is running, then retry.',
      });
    } catch (writeError) {
      app.log.error({ err: writeError, sourceId }, 'failed to mark enqueue-failed source');
    }
    return false;
  }
}
