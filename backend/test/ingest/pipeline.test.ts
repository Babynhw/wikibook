import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn() };
});

import { lookup as lookupMock } from 'node:dns/promises';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createPrismaClient } from '../../src/lib/prisma.js';
import { keyFor, getObject, putObject, removeObject } from '../../src/lib/storage.js';
import { runSourceIngestion, type SourceStateEvent } from '../../src/ingest/pipeline.js';
import { buildMinimalPdf } from '../../scripts/pdf-fixture-builder.js';
import { EmbeddingError } from '../../src/lib/embeddings.js';
import type { EmbedFn } from '../../src/ingest/persist.js';

const DIM = 768;
const zeroVector = (size = 200) => Array.from({ length: DIM }, () => 0);

const ARTICLE = `<!doctype html>
<html><head><title>Rested Thoughts</title><meta property="og:site_name" content="Sleep Journal"></head>
<body><div id="main"><h1>Rested Thoughts</h1><p>Web articles become sources too.</p></div></body></html>`;

describe('ingestion pipeline', () => {
  let prisma: PrismaClient;
  let userId: string;
  let spaceId: string;
  const publishEvents: Array<{ spaceId: string; event: SourceStateEvent }> = [];
  let embedStub: EmbedFn;
  let fetchStub: typeof fetch;
  const loggerWarnings: Array<{ context: Record<string, unknown>; message: string }> = [];

  const deps = () => ({
    prisma,
    storage: { getObject },
    embed: embedStub,
    fetchFn: fetchStub,
    publish: async (spaceId: string, event: SourceStateEvent) => {
      publishEvents.push({ spaceId, event });
    },
    logger: {
      info: () => {},
      warn: (context: Record<string, unknown>, message: string) => {
        loggerWarnings.push({ context, message });
      },
      error: () => {},
    },
  });

  const reset = () => {
    publishEvents.length = 0;
    loggerWarnings.length = 0;
    embedStub = async (texts) => texts.map(() => zeroVector());
    fetchStub = async () => new Response(ARTICLE, { status: 200 });
    (lookupMock as unknown as Mock).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
  };

  const newUserSpace = async () => {
    const user = await prisma.user.create({
      data: { name: 'Ingest Tester', email: `ingest+${Math.random()}@example.test`, passwordHash: 'x' },
    });
    const space = await prisma.space.create({
      data: {
        ownerId: user.id,
        name: 'Ingest test space',
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    userId = user.id;
    spaceId = space.id;
    return { userId: user.id, spaceId: space.id };
  };

  const createSource = (overrides: Record<string, unknown> = {}) =>
    prisma.source.create({
      data: {
        spaceId,
        type: 'manual',
        title: 'Probe source',
        content: 'Line one.\nLine two.',
        state: 'processing',
        ...overrides,
      },
    });

  beforeEach(reset);

  beforeAll(async () => {
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    await newUserSpace();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'ingest+' } } });
    await prisma.$disconnect();
  });

  it('processes a manual source to ready with located passages and activity', async () => {
    const source = await createSource({ content: 'Paragraph alpha.\n\nParagraph beta.' });
    await runSourceIngestion(deps(), source.id);

    const updated = await prisma.source.findUnique({ where: { id: source.id } });
    expect(updated?.state).toBe('ready');
    expect(updated?.errorMessage).toBeNull();
    expect(updated?.content).toBe('Paragraph alpha.\nParagraph beta.');

    // Both short paragraphs merge into one passage — parseable content, so ord
    // runs 1..n with a paragraph-range locator, exactly what §6 requires.
    const passages = await prisma.passage.findMany({
      where: { sourceId: source.id },
      orderBy: { ord: 'asc' },
      select: { ord: true, text: true, page: true, paragraphRef: true },
    });
    expect(passages.map((p) => p.ord)).toEqual([1]);
    expect(passages[0]).toMatchObject({ page: null, paragraphRef: 'p1-p2' });

    const activity = await prisma.activity.findMany({
      where: { spaceId, refId: source.id },
    });
    expect(activity.map((row) => row.kind)).toEqual(['source.ready']);

    expect(publishEvents).toEqual([
      { spaceId, event: { sourceId: source.id, state: 'ready' } },
    ]);
  });

  it('reprocesses idempotently: same passage count, ord sequence, no duplicate source', async () => {
    const source = await createSource();
    await runSourceIngestion(deps(), source.id);
    const first = await prisma.passage.findMany({ where: { sourceId: source.id }, orderBy: { ord: 'asc' } });

    // Retry resets to `processing` first, exactly as POST /sources/:id/retry does.
    await prisma.source.update({ where: { id: source.id }, data: { state: 'processing' } });
    await runSourceIngestion(deps(), source.id);

    const second = await prisma.passage.findMany({ where: { sourceId: source.id }, orderBy: { ord: 'asc' } });
    expect(second.map((p) => p.ord)).toEqual(first.map((p) => p.ord));
    expect(second.map((p) => p.text)).toEqual(first.map((p) => p.text));
    // Replaced, not appended.
    const allForSource = await prisma.passage.count({ where: { sourceId: source.id } });
    expect(allForSource).toBe(first.length);
    // One source row, still.
    const rows = await prisma.source.count({ where: { id: source.id } });
    expect(rows).toBe(1);
  });

  it('re-matches surviving citations and marks the rest stale (PRD §6)', async () => {
    const source = await createSource({
      content: 'The brain reorganises itself. Nothing else matters for memory.\nMore of the same.',
    });
    await runSourceIngestion(deps(), source.id);
    const oldPassages = await prisma.passage.findMany({ where: { sourceId: source.id } });
    const oldId = oldPassages[0]!.id;

    const surviving = await prisma.citation.create({
      data: { sourceId: source.id, passageId: oldId, quotedText: 'The brain reorganises itself.' },
    });
    const gone = await prisma.citation.create({
      data: { sourceId: source.id, passageId: oldId, quotedText: 'a quote that never existed' },
    });

    // Reproduce, with the same content: the row survives, passages are replaced.
    await prisma.source.update({ where: { id: source.id }, data: { state: 'processing' } });
    await runSourceIngestion(deps(), source.id);

    const newPassages = await prisma.passage.findMany({ where: { sourceId: source.id } });
    const rematched = await prisma.citation.findUnique({ where: { id: surviving.id } });
    const staled = await prisma.citation.findUnique({ where: { id: gone.id } });

    expect(rematched?.passageId).not.toBe(oldId);
    expect(newPassages.some((p) => p.id === rematched?.passageId)).toBe(true);
    expect(rematched?.stale).toBe(false);

    expect(staled?.stale).toBe(true);
    expect(staled?.passageId).toBeNull();
  });

  it('keeps a citation whose quote spans a former line break (whitespace-insensitive rematch)', async () => {
    // Yesterday's passage joined two printed lines with `\n`; the reflowed one
    // joins them with a space. Same evidence, so the citation must not go stale.
    const source = await createSource({
      content: 'The brain reorganises itself during sleep. Nothing else matters for memory.',
    });
    await runSourceIngestion(deps(), source.id);
    const oldPassage = (await prisma.passage.findMany({ where: { sourceId: source.id } }))[0]!;

    const citation = await prisma.citation.create({
      data: {
        sourceId: source.id,
        passageId: oldPassage.id,
        quotedText: 'reorganises itself\nduring sleep.  Nothing else',
      },
    });

    await prisma.source.update({ where: { id: source.id }, data: { state: 'processing' } });
    await runSourceIngestion(deps(), source.id);

    const rematched = await prisma.citation.findUnique({ where: { id: citation.id } });
    expect(rematched?.stale).toBe(false);
    expect(rematched?.passageId).not.toBeNull();
  });

  it('processes a web source and surfaces the extracted title/author/url', async () => {
    const source = await createSource({
      type: 'web',
      title: 'https://example.com/article',
      url: 'https://example.com/article',
    });
    await runSourceIngestion(deps(), source.id);

    const updated = await prisma.source.findUnique({ where: { id: source.id } });
    expect(updated?.state).toBe('ready');
    expect(updated?.title).toBe('Rested Thoughts');
    expect(updated?.url).toBe('https://example.com/article');
  });

  it('processes a PDF placed in object storage, keeping structural page numbers', async () => {
    const pdf = buildMinimalPdf([
      'BT /F1 24 Tf 72 720 Td (First page content) Tj ET',
      'BT /F1 24 Tf 72 720 Td (Second page content) Tj ET',
    ]);
    const source = await createSource({
      type: 'pdf',
      title: 'Two pages',
      fileKey: undefined,
    });

    // Wire the object up like the upload route does, then hand the source to
    // the worker path.
    const key = keyFor(spaceId, source.id);
    const input = new (await import('node:stream')).PassThrough();
    input.end(pdf);
    await putObject(input, { key, contentType: 'application/pdf', maxBytes: 10_000 });
    await prisma.source.update({ where: { id: source.id }, data: { fileKey: key } });

    await runSourceIngestion(deps(), source.id);

    const updated = await prisma.source.findUnique({ where: { id: source.id } });
    expect(updated?.state).toBe('ready');

    const passages = await prisma.passage.findMany({ where: { sourceId: source.id } });
    const pageNumbers = passages.map((p) => p.page).sort();
    expect(pageNumbers[0]).toBe(1);
    expect(pageNumbers[pageNumbers.length - 1]).toBe(2);

    await removeObject(key);
  });

  it('leaves a source processing when embed fails transiently, and retries cleanly', async () => {
    const source = await createSource();
    let calls = 0;
    embedStub = async () => {
      calls += 1;
      throw new EmbeddingError('unreachable', 'embedding service unavailable');
    };

    await expect(runSourceIngestion(deps(), source.id)).rejects.toThrow();
    const stuck = await prisma.source.findUnique({ where: { id: source.id } });
    expect(stuck?.state).toBe('processing');
    expect(publishEvents).toEqual([]);
    expect((await prisma.activity.findMany({ where: { refId: source.id } })).length).toBe(0);

    // The retry succeeds once the service is back.
    embedStub = async (texts) => texts.map(() => zeroVector());
    await runSourceIngestion(deps(), source.id);
    expect((await prisma.source.findUnique({ where: { id: source.id } }))?.state).toBe('ready');
  });

  it('treats an embedding dimension mismatch as permanent, not a retry', async () => {
    const source = await createSource();
    embedStub = async () => {
      throw new EmbeddingError('dimension_mismatch', 'expected 768 dimensions, got 384');
    };

    // Returns normally: burning three attempts on a misconfigured model only
    // delays the message the operator needs to see.
    await runSourceIngestion(deps(), source.id);

    const failed = await prisma.source.findUnique({ where: { id: source.id } });
    expect(failed?.state).toBe('failed');
    expect(failed?.errorMessage).toBe(
      'This source could not be indexed because of a server configuration problem.',
    );
    expect(publishEvents.map((entry) => entry.event.state)).toEqual(['failed']);
    // Nothing half-written: the transaction never opened.
    expect(await prisma.passage.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('marks a source failed on a permanent extraction error and publishes it', async () => {
    const source = await createSource({ type: 'pdf', fileKey: undefined });
    const key = keyFor(spaceId, source.id);
    const input = new (await import('node:stream')).PassThrough();
    input.end(Buffer.from('%PDF-1.4\n--- corrupt ---\n%%EOF'));
    await putObject(input, { key, contentType: 'application/pdf', maxBytes: 10_000 });
    await prisma.source.update({ where: { id: source.id }, data: { fileKey: key } });

    await runSourceIngestion(deps(), source.id);

    const failed = await prisma.source.findUnique({ where: { id: source.id } });
    expect(failed?.state).toBe('failed');
    expect(failed?.errorMessage).toBe('This file could not be read as a PDF.');

    const activity = await prisma.activity.findMany({ where: { refId: source.id } });
    expect(activity.map((row) => row.kind)).toEqual(['source.failed']);

    expect(publishEvents).toEqual([
      {
        spaceId,
        event: { sourceId: source.id, state: 'failed', errorMessage: 'This file could not be read as a PDF.' },
      },
    ]);
    await removeObject(key);
  });
});