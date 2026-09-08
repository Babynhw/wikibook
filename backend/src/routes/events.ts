import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../config.js';
import { assertAccess } from '../middleware/assert-access.js';

/**
 * Server-Sent Events for source state changes
 * (wiki-docs/plan/phase-2-ingestion/design.md "State changes are pushed over
 * SSE"). One `data:` event per state transition: `{ sourceId, state,
 * errorMessage? }` — nothing else, no text, no passages (§17).
 *
 * - Ownership is asserted before the stream opens; a foreign space gets 404
 *   before any socket is consumed.
 * - The response is hijacked: the raw socket is owned by this handler from
 *   `reply.hijack()` onward, kept open by a 15 s heartbeat comment, and closed
 *   on socket death or sign-out (`closeStreamsForUser`).
 * - There is no event replay. The client refetches the list once per connect,
 *   so this stream is a latency optimization over that refetch, not a source of
 *   truth — see design on why there is no `Last-Event-ID` buffer.
 */
const eventsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/spaces/:id/events',
    {
      onRequest: [app.requireUser],
      preHandler: [assertAccess('space', 'id')],
      config: { rateLimit: false },
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const spaceId = request.params.id;

      // Throws 429 when the user is at `SSE_MAX_CONNECTIONS_PER_USER` — a
      // leaked tab must not pin connections open indefinitely.
      app.events.registerUserConnection(userId);

      const channel = `space:${spaceId}`;
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        // The SPA is cross-origin on :5173; `EventSource` with withCredentials
        // needs the same origin + credentials headers CORS grants elsewhere.
        'access-control-allow-origin': env.CORS_ORIGIN,
        'access-control-allow-credentials': 'true',
      });

      const send = (payload: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const unsubscribe = app.events.subscribe(channel, send);
      const heartbeat = setInterval(() => {
        reply.raw.write(': keep-alive\n\n');
      }, 15_000);

      // Writing the headers alone is not enough to flush the hijacked response:
      // the client would see nothing until the first write. An opening comment
      // both flushes headers and is valid SSE (proxies learn the stream is live).
      reply.raw.write(': connected\n\n');

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        app.events.releaseUserConnection(userId);
      };
      const close = () => {
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
      };

      const dispose = app.events.trackStream(userId, close);
      // Socket death ends the stream from underneath us; dispose the registry
      // entry (the entry is only needed for sign-out teardown, which just ran).
      reply.raw.on('close', () => {
        dispose();
        cleanup();
      });
    },
  );
};

export default eventsRoutes;