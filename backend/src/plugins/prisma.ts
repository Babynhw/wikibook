import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../lib/prisma.js';
import { env } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp(async function prismaPlugin(app: FastifyInstance) {
  const prisma = createPrismaClient(env.DATABASE_URL, {
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  await prisma.$connect();

  app.decorate('prisma', prisma);
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});
