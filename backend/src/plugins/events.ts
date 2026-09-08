import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { env } from '../config.js';
import { tooManyRequests } from '../lib/errors.js';

interface StreamEntry {
  userId: string;
  /** Ends the response and cleans up; idempotent. */
  close: () => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    events: {
      publish(channel: string, payload: unknown): Promise<void>;
      subscribe(channel: string, handler: (payload: unknown) => void): () => void;
      /** Throws {@link tooManyRequests} when the user is at the per-user cap. */
      registerUserConnection(userId: string): void;
      releaseUserConnection(userId: string): void;
      /** Registers a live stream so sign-out can tear it down; call the returned
       * function when the stream ends by any other route. */
      trackStream(userId: string, close: () => void): () => void;
      /** Sign-out teardown: ends every live stream the user holds (see session). */
      closeStreamsForUser(userId: string): void;
    };
  }
}

/**
 * Redis channel relay for live state updates (wiki-docs/plan/phase-2-ingestion/
 * design.md "State changes are pushed over SSE").
 *
 * The worker is a different process and cannot write to the API's client
 * connections, so it publishes `{ sourceId, state, errorMessage? }` on
 * `space:<spaceId>` and this plugin relays. Two dedicated Redis connections are
 * created here on purpose:
 *
 * - A subscriber-mode ioredis connection refuses ordinary commands — it cannot
 *   even `ping` in the way the rest of the app expects.
 * - Swapping one of the two (or reusing `app.redis`, which BullMQ owns) would
 *   break either the queue or the relay.
 *
 * The channel carries state transitions only — never text, never passages (PRD
 * §17 keeps content out of transports that do not need it).
 */
export default fp(async function eventsPlugin(app: FastifyInstance) {
  const subscriber = new Redis(env.REDIS_URL);
  const publisher = new Redis(env.REDIS_URL);

  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const userConnections = new Map<string, number>();
  const streams = new Set<StreamEntry>();

  subscriber.on('message', (channel, message) => {
    const channelHandlers = handlers.get(channel);
    if (!channelHandlers) return;
    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    for (const handler of channelHandlers) {
      try {
        handler(payload);
      } catch (error) {
        app.log.warn({ err: error, channel }, 'event handler failed');
      }
    }
  });
  subscriber.on('error', (error: Error) => {
    app.log.warn({ err: error }, 'events subscriber error');
  });
  publisher.on('error', (error: Error) => {
    app.log.warn({ err: error }, 'events publisher error');
  });

  app.decorate('events', {
    async publish(channel: string, payload: unknown): Promise<void> {
      await publisher.publish(channel, JSON.stringify(payload));
    },
    subscribe(channel: string, handler: (payload: unknown) => void): () => void {
      let channelHandlers = handlers.get(channel);
      if (!channelHandlers) {
        channelHandlers = new Set();
        handlers.set(channel, channelHandlers);
        subscriber.subscribe(channel).catch((error: Error) => {
          app.log.warn({ err: error, channel }, 'subscribe failed');
        });
      }
      channelHandlers.add(handler);
      return () => {
        channelHandlers!.delete(handler);
        if (channelHandlers!.size === 0) {
          handlers.delete(channel);
          subscriber.unsubscribe(channel).catch(() => {});
        }
      };
    },
    registerUserConnection(userId: string): void {
      const current = userConnections.get(userId) ?? 0;
      if (current >= env.SSE_MAX_CONNECTIONS_PER_USER) {
        throw tooManyRequests(
          `You already have ${current} connections open here. Close another tab and try again.`,
        );
      }
      userConnections.set(userId, current + 1);
    },
    releaseUserConnection(userId: string): void {
      const current = userConnections.get(userId);
      if (!current || current <= 1) {
        userConnections.delete(userId);
      } else {
        userConnections.set(userId, current - 1);
      }
    },
    closeStreamsForUser(userId: string): void {
      for (const entry of streams) {
        if (entry.userId === userId) entry.close();
      }
    },
    trackStream(userId: string, close: () => void): () => void {
      const entry: StreamEntry = { userId, close };
      streams.add(entry);
      return () => {
        streams.delete(entry);
      };
    },
  });

  app.addHook('onClose', async () => {
    // Close live streams first so sockets release before connections.
    for (const entry of streams) entry.close();
    subscriber.disconnect();
    publisher.disconnect();
  });
});