import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { env } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async function redisPlugin(app: FastifyInstance) {
  // Redis only backs the BullMQ ingestion queue (Phase 2). Lazy connect keeps a
  // missing Redis from blocking boot — /health reports it as degraded instead.
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  redis.on('error', (error: Error) => {
    app.log.warn({ err: error }, 'redis error');
  });

  try {
    await redis.connect();
  } catch (error) {
    app.log.warn({ err: error }, 'redis unavailable at startup');
  }

  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    redis.disconnect();
  });
});
