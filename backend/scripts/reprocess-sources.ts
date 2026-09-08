/**
 * Re-runs ingestion for sources that are already `ready`.
 *
 *   pnpm reprocess:sources <sourceId>
 *   pnpm reprocess:sources --all [--type pdf|web|manual] [--dry-run]
 *
 * There is deliberately no API route for this (PRD §8 never asks a user to
 * re-extract), and `runSourceIngestion` refuses a `ready` source — so this
 * script does what the retry route does for a `failed` one: an atomic
 * `ready → processing` guard, the settled job cleared, and a fresh enqueue with
 * the standard job options. The worker must be running; `persistReady` then
 * deletes and rewrites blocks and passages in one transaction (REQ-129) and
 * rematches citations. Archived spaces are frozen and are skipped.
 */
import 'dotenv/config';
import { env } from '../src/config.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { ingestJobOptions, ingestQueue } from '../src/lib/queue.js';
import { markSourceFailed } from '../src/ingest/persist.js';

const SOURCE_TYPES = ['pdf', 'web', 'manual'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];
const isSourceType = (value: string): value is SourceType =>
  (SOURCE_TYPES as readonly string[]).includes(value);

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    'usage: reprocess-sources <sourceId> | --all [--type pdf|web|manual] [--dry-run]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const all = args.includes('--all');
const dryRun = args.includes('--dry-run');
const typeIndex = args.indexOf('--type');
const typeArg = typeIndex === -1 ? null : (args[typeIndex + 1] ?? '');
if (typeArg !== null && !isSourceType(typeArg)) usage(`unknown type: ${typeArg}`);
const type: SourceType | null = typeArg;
const ids = args.filter(
  (arg, index) => !arg.startsWith('--') && (typeIndex === -1 || index !== typeIndex + 1),
);
if (!all && ids.length === 0) usage();
if (all && ids.length > 0) usage('pass either --all or source ids, not both');

const prisma = createPrismaClient(env.DATABASE_URL);
const queue = ingestQueue();

// A `finally` that exits would swallow a thrown error and report success;
// the failure is caught, printed, and turned into the exit code instead.
let failed = false;
try {
  const sources = await prisma.source.findMany({
    where: {
      state: 'ready',
      space: { archivedAt: null },
      ...(all ? {} : { id: { in: ids } }),
      ...(type ? { type } : {}),
    },
    select: { id: true, spaceId: true, type: true, title: true, space: { select: { ownerId: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const missing = all ? [] : ids.filter((id) => !sources.some((source) => source.id === id));
  for (const id of missing) console.warn(`skip ${id}: not found, not ready, or in an archived space`);

  if (sources.length === 0) {
    console.log('nothing to reprocess');
  }

  let queued = 0;
  for (const source of sources) {
    const label = `${source.id} (${source.type}) ${source.title}`;
    if (dryRun) {
      console.log(`would reprocess ${label}`);
      continue;
    }

    // Same guard as `POST /sources/:id/retry`: only the row that is still
    // `ready` flips, so a source the worker picked up meanwhile is left alone.
    const flipped = await prisma.source.updateMany({
      where: { id: source.id, state: 'ready' },
      data: { state: 'processing', errorMessage: null },
    });
    if (flipped.count !== 1) {
      console.warn(`skip ${label}: state changed underneath`);
      continue;
    }

    try {
      // A settled job with this id would make `add` a silent no-op
      // (`enqueueOrFail` has the same two steps, for the same reason).
      await queue.remove(source.id).catch(() => undefined);
      await queue.add(
        'process',
        { sourceId: source.id, spaceId: source.spaceId, userId: source.space.ownerId },
        ingestJobOptions(source.id),
      );
      queued++;
      console.log(`queued ${label}`);
    } catch (error) {
      console.error(`enqueue failed for ${label}`, error);
      await markSourceFailed(prisma, {
        userId: source.space.ownerId,
        spaceId: source.spaceId,
        sourceId: source.id,
        message:
          'Processing could not be started. Check that the pipeline is running, then retry.',
      });
    }
  }

  if (!dryRun) console.log(`${queued} of ${sources.length} queued`);
} catch (error) {
  console.error('reprocess failed', error);
  failed = true;
} finally {
  await queue.close();
  await prisma.$disconnect();
  // The ioredis connection BullMQ holds can outlive `close()` by a keep-alive;
  // a CLI has nothing left to wait for.
  process.exit(failed ? 1 : 0);
}
