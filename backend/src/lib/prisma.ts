import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma 7 connects through a driver adapter rather than a connection string on
 * the client, so every entry point (server, seed, tests) builds its client here.
 */
export function createPrismaClient(
  connectionString: string,
  options: { log?: ('warn' | 'error' | 'info' | 'query')[] } = {},
): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter, ...(options.log ? { log: options.log } : {}) });
}
