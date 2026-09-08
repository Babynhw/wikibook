import { Readable } from 'node:stream';
import type { PrismaClient } from '../generated/prisma/client.js';
import { env, loadLimits } from '../config.js';
import { embed } from '../lib/embeddings.js';
import { chunkBlocks } from './chunk.js';
import { extractManual } from './extract-manual.js';
import { extractPdf } from './extract-pdf.js';
import { extractWeb } from './extract-web.js';
import { isUnretryable, UnretryableIngestError } from './errors.js';
import { markSourceFailed, persistReady, type EmbedFn } from './persist.js';
import type { ExtractionResult } from './extracted.js';
import type { WebExtractionResult } from './extracted.js';

export interface SourceStateEvent {
  sourceId: string;
  state: 'processing' | 'ready' | 'failed';
  errorMessage?: string;
}

interface ObjectStoreReader {
  getObject(key: string): Promise<{ body: NodeJS.ReadableStream }>;
}

/** Minimal logger surface — the worker adapts a pino logger, tests a stub. */
export interface IngestLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface IngestDeps {
  prisma: PrismaClient;
  storage: ObjectStoreReader;
  /** Injectable for tests; defaults to the Ollama client. */
  embed?: EmbedFn;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  publish: (spaceId: string, event: SourceStateEvent) => Promise<void>;
  logger: IngestLogger;
}

/**
 * Runs one source through the pipeline: extract → chunk → embed → write
 * (wiki-docs/plan/phase-2-ingestion/design.md). Steps before the write touch
 * the database only to read; the single write in `persistReady` is what makes a
 * crashed job harmless — a source that never reaches it stays `processing` and
 * is recovered by the same retry path a user would use.
 *
 * - Permanent failures ({@link UnretryableIngestError}) end with the source
 *   marked `failed` and an SSE event; the function returns normally, so the job
 *   does not keep burning BullMQ attempts.
 * - Transient failures rethrow; the worker lets BullMQ retry, and the source
 *   stays `processing` between attempts.
 */
export async function runSourceIngestion(deps: IngestDeps, sourceId: string): Promise<void> {
  const source = await deps.prisma.source.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      spaceId: true,
      type: true,
      url: true,
      content: true,
      title: true,
      author: true,
      fileKey: true,
      state: true,
      addedById: true,
      space: { select: { ownerId: true } },
    },
  });
  if (!source) {
    deps.logger.warn({ sourceId }, 'ingest job for a source that no longer exists');
    return;
  }
  if (source.state === 'ready') {
    // A stray duplicate job must not re-embed an already-ready source.
    deps.logger.warn({ sourceId }, 'ingest job for an already-ready source; skipping');
    return;
  }

  // Activity is attributed to whoever added the source; the owner only when
  // that account is gone (shared-spaces-v1 "Activity.userId is the actor").
  const actorId = source.addedById ?? source.space.ownerId;

  try {
    let extracted: ExtractionResult & Partial<Pick<WebExtractionResult, 'title' | 'author' | 'url'>>;

    if (source.type === 'pdf') {
      if (!source.fileKey) {
        throw new UnretryableIngestError('This source has no stored file to process.');
      }
      const object = await deps.storage.getObject(source.fileKey);
      const buffer = await streamToBuffer(object.body);
      const limits = await loadLimits(deps.prisma, true);
      extracted = await extractPdf(buffer, { maxPages: limits.pdf_max_pages });
    } else if (source.type === 'web') {
      if (!source.url) {
        throw new UnretryableIngestError('This source has no web address to fetch.');
      }
      extracted = await extractWeb(source.url, {
        timeoutMs: env.WEB_FETCH_TIMEOUT_MS,
        maxBytes: env.WEB_FETCH_MAX_BYTES,
        fetchFn: deps.fetchFn === undefined ? fetch : deps.fetchFn,
      });
    } else {
      if (!source.content) {
        throw new UnretryableIngestError('This source has no text to process.');
      }
      extracted = extractManual(source.content);
    }

    const passages = chunkBlocks(extracted.blocks);
    if (passages.length === 0) {
      throw new UnretryableIngestError('No readable text was found in this source.');
    }

    await persistReady(
      deps.prisma,
      { embed: deps.embed ?? embed },
      {
        sourceId: source.id,
        userId: actorId,
        spaceId: source.spaceId,
        content: extracted.text,
        blocks: extracted.blocks,
        ...(source.type === 'web'
          ? {
              title: extracted.title,
              author: extracted.author,
              url: (extracted as WebExtractionResult).url,
            }
          : {}),
        passages,
      },
    );

    await publishState(deps, source.spaceId, { sourceId, state: 'ready' });
  } catch (error) {
    if (isUnretryable(error)) {
      const message = error.userMessage;
      try {
        await markSourceFailed(deps.prisma, {
          userId: actorId,
          spaceId: source.spaceId,
          sourceId: source.id,
          message,
        });
      } catch (writeError) {
        // The failure itself failed to persist: log loudly, the source stays
        // `processing` and the same retry path will attempt again.
        deps.logger.error({ err: writeError, sourceId }, 'failed to mark a source as failed');
        return;
      }
      await publishState(deps, source.spaceId, {
        sourceId,
        state: 'failed',
        errorMessage: message,
      });
      return;
    }
    throw error;
  }
}

function publishState(
  deps: IngestDeps,
  spaceId: string,
  event: SourceStateEvent,
): Promise<void> {
  return deps.publish(spaceId, event).catch((error: unknown) => {
    // SSE is a latency optimization, never a correctness dependency.
    deps.logger.warn({ err: error, spaceId, sourceId: event.sourceId }, 'state publish failed');
  });
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    Readable.from(stream)
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}