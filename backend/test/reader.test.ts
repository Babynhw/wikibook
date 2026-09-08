import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn() };
});

import { lookup as lookupMock } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import {
  cleanupUsers,
  createSpace,
  registerUser,
  startTestApp,
  uniqueEmail,
  uploadPdf,
} from './helpers.js';
import { buildMinimalPdf } from '../scripts/pdf-fixture-builder.js';
import { getObject, removeObject } from '../src/lib/storage.js';
import { runSourceIngestion, type SourceStateEvent } from '../src/ingest/pipeline.js';

const DIM = 768;

const ARTICLE = `<!doctype html>
<html><head><title>Rested Thoughts</title></head><body><div id="main">
<h1>Rested Thoughts</h1>
<h2>Slow-wave sleep</h2>
<p>Sleep spindles mark the consolidation window.</p>
<p>Recall improves after an early night of sleep.</p>
<h2>Open questions</h2>
<p>Whether naps reproduce the effect is unsettled.</p>
</div></body></html>`;

/**
 * PRD §8 (source reader): the blocks the reader renders, the outline it navigates
 * by, and the locator round-trip that makes a citation highlight exact.
 * REQ range in specs/library-reader/spec.md.
 */
describe('source reader', () => {
  let app: FastifyInstance;
  let cookie: string;
  let strangerCookie: string;
  let spaceId: string;
  const emails: string[] = [];
  const keysToClean: string[] = [];

  const ingest = (sourceId: string) =>
    runSourceIngestion(
      {
        prisma: app.prisma,
        storage: { getObject },
        embed: async (texts: string[]) => texts.map(() => Array.from({ length: DIM }, () => 0)),
        fetchFn: (async () => new Response(ARTICLE, { status: 200 })) as typeof fetch,
        publish: async (_spaceId: string, _event: SourceStateEvent) => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      sourceId,
    );

  const addManual = async (title: string, content: string) => {
    const response = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceId}/sources`,
      headers: { cookie },
      payload: { type: 'manual', title, content },
    });
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().source.id as string;
    await ingest(id);
    return id;
  };

  const blocks = async (sourceId: string, query = '', as = cookie) => {
    const response = await app.inject({
      method: 'GET',
      url: `/sources/${sourceId}/blocks${query}`,
      headers: { cookie: as },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().blocks as {
      ord: number;
      text: string;
      page: number | null;
      paragraphIndex: number | null;
      heading: string | null;
    }[];
  };

  const outline = async (sourceId: string) => {
    const response = await app.inject({
      method: 'GET',
      url: `/sources/${sourceId}/outline`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      blockCount: number;
      pageCount: number | null;
      headings: { ord: number; page: number | null; heading: string }[];
    };
  };

  let pdfId: string;
  let webId: string;
  let manualId: string;

  beforeAll(async () => {
    (lookupMock as unknown as Mock).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    app = await startTestApp();
    const email = uniqueEmail('reader');
    emails.push(email);
    cookie = (await registerUser(app, email)).cookie;
    const strangerEmail = uniqueEmail('reader-stranger');
    emails.push(strangerEmail);
    strangerCookie = (await registerUser(app, strangerEmail)).cookie;
    spaceId = await createSpace(app, cookie, 'Reader');

    const pdf = buildMinimalPdf([
      'BT /F1 24 Tf 72 720 Td (Page one talks about spindles) Tj ET',
      'BT /F1 24 Tf 72 720 Td (Page two talks about recall) Tj ET',
      'BT /F1 24 Tf 72 720 Td (Page three talks about naps) Tj ET',
    ]);
    const upload = await uploadPdf(app, cookie, spaceId, pdf, 'three-pages.pdf');
    expect(upload.statusCode, upload.body).toBe(201);
    pdfId = upload.json().source.id;
    const stored = await app.prisma.source.findUnique({
      where: { id: pdfId },
      select: { fileKey: true },
    });
    if (stored?.fileKey) keysToClean.push(stored.fileKey);
    await ingest(pdfId);

    const web = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceId}/sources`,
      headers: { cookie },
      payload: { type: 'web', url: 'https://example.com/rested' },
    });
    expect(web.statusCode, web.body).toBe(201);
    webId = web.json().source.id;
    await ingest(webId);

    manualId = await addManual(
      'Field notebook',
      Array.from({ length: 12 }, (_, index) => `Entry number ${index + 1}.`).join('\n'),
    );
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    for (const key of keysToClean) await removeObject(key).catch(() => {});
    await app.close();
  });

  it('serves a PDF page at a time, with the page numbers extraction recorded', async () => {
    const shape = await outline(pdfId);
    expect(shape.pageCount).toBe(3);
    expect(shape.blockCount).toBeGreaterThanOrEqual(3);

    const page2 = await blocks(pdfId, '?page=2');
    expect(page2.length).toBeGreaterThan(0);
    // Every block on the page carries that page, and only that page's text.
    expect(page2.every((block) => block.page === 2)).toBe(true);
    expect(page2.map((block) => block.text).join(' ')).toContain('Page two talks about recall');
    expect(page2.map((block) => block.text).join(' ')).not.toContain('spindles');

    // Ordinals are ascending and unique — the reader's scroll order.
    const ords = page2.map((block) => block.ord);
    expect(ords).toEqual([...ords].sort((a, b) => a - b));

    const page4 = await blocks(pdfId, '?page=4');
    expect(page4).toEqual([]);
  });

  it('narrows rather than switches when a page and a window are both asked for', async () => {
    // The two modes are not exclusive in the query schema, so what they do together
    // is pinned here instead of being emergent: `page` selects the page and `from`
    // is an additional lower bound on the ordinal. A page is bounded by the
    // document, so `limit` does not apply to it.
    const page2 = await blocks(pdfId, '?page=2');
    const lastOrd = page2[page2.length - 1]!.ord;

    const narrowed = await blocks(pdfId, `?page=2&from=${lastOrd}`);
    expect(narrowed.map((block) => block.ord)).toEqual([lastOrd]);
    expect(narrowed.every((block) => block.page === 2)).toBe(true);

    // A `from` past the end of the page intersects to nothing rather than falling
    // back to the whole page or to window mode.
    expect(await blocks(pdfId, `?page=2&from=${lastOrd + 1000}`)).toEqual([]);
  });

  it('serves web and manual sources through a bounded window', async () => {
    const first = await blocks(manualId, '?from=1&limit=3');
    expect(first.map((block) => block.ord)).toEqual([1, 2, 3]);
    expect(first[0]!.text).toBe('Entry number 1.');
    expect(first.every((block) => block.page === null)).toBe(true);
    // `paragraphIndex` is what `Passage.paragraphRef`'s `pN` refers to.
    expect(first.map((block) => block.paragraphIndex)).toEqual([1, 2, 3]);

    // A window can be aimed at a deep-linked block instead of scrolled to.
    const middle = await blocks(manualId, '?from=9&limit=3');
    expect(middle.map((block) => block.ord)).toEqual([9, 10, 11]);

    // The cap is the server's, not the client's: an absurd limit is clamped and
    // the request still answers.
    const clamped = await blocks(manualId, '?from=1&limit=100000');
    expect(clamped.length).toBe(12);

    const web = await blocks(webId, '?from=1&limit=50');
    expect(web.length).toBeGreaterThan(0);
    // §6 keeps section headings associated with their text, and the outline is
    // how a page-less source is navigated.
    const webOutline = await outline(webId);
    expect(webOutline.pageCount).toBeNull();
    expect(webOutline.headings.map((entry) => entry.heading)).toContain('Slow-wave sleep');
    // One entry per heading run, not one per block that repeats it.
    const headings = webOutline.headings.map((entry) => entry.heading);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('resolves every passage to a block range that contains its text', async () => {
    // The test this phase exists for: Phase 2's locators and Phase 3's blocks
    // must describe the same document, for all three source types.
    for (const sourceId of [pdfId, webId, manualId]) {
      const passages = await app.prisma.passage.findMany({
        where: { sourceId },
        orderBy: { ord: 'asc' },
      });
      expect(passages.length).toBeGreaterThan(0);

      const all = await app.prisma.sourceBlock.findMany({
        where: { sourceId },
        orderBy: { ord: 'asc' },
      });

      for (const passage of passages) {
        expect(passage.startBlockOrd, `passage ${passage.id} start`).not.toBeNull();
        expect(passage.endBlockOrd!).toBeGreaterThanOrEqual(passage.startBlockOrd!);

        const range = all.filter(
          (block) => block.ord >= passage.startBlockOrd! && block.ord <= passage.endBlockOrd!,
        );
        expect(range.length).toBeGreaterThan(0);
        expect(range.map((block) => block.text).join('\n')).toContain(passage.text);

        // A PDF passage never spans a page, so its range is on one page (REQ-089).
        if (passage.page !== null) {
          expect(new Set(range.map((block) => block.page))).toEqual(new Set([passage.page]));
        }
      }
    }
  });

  it('rewrites blocks and passages together when a source is reprocessed', async () => {
    const id = await addManual('Rewritten', 'First take.\nSecond take.');
    const before = await app.prisma.sourceBlock.findMany({
      where: { sourceId: id },
      orderBy: { ord: 'asc' },
    });
    expect(before.map((block) => block.text)).toEqual(['First take.', 'Second take.']);

    await app.prisma.source.update({
      where: { id },
      data: { state: 'processing', content: 'Only one line now.' },
    });
    await ingest(id);

    const after = await app.prisma.sourceBlock.findMany({
      where: { sourceId: id },
      orderBy: { ord: 'asc' },
    });
    // Replaced, not appended — and the ordinals restart from 1.
    expect(after.map((block) => block.text)).toEqual(['Only one line now.']);
    expect(after.map((block) => block.ord)).toEqual([1]);

    const passages = await app.prisma.passage.findMany({ where: { sourceId: id } });
    expect(passages).toHaveLength(1);
    expect(passages[0]!.endBlockOrd).toBe(1);
  });

  it('degrades instead of erroring for a source with no blocks', async () => {
    // Sources ingested before the Phase 3 migration have no blocks; the reader's
    // fallback is what covers them, and it must not be a 500.
    const id = await addManual('Pre-migration', 'Written before blocks existed.');
    await app.prisma.sourceBlock.deleteMany({ where: { sourceId: id } });

    expect(await blocks(id, '?from=1')).toEqual([]);
    const shape = await outline(id);
    expect(shape).toMatchObject({ blockCount: 0, pageCount: null, headings: [] });

    const detail = await app.inject({
      method: 'GET',
      url: `/sources/${id}`,
      headers: { cookie },
    });
    expect(detail.json().source).toMatchObject({ blockCount: 0, pageCount: null });
  });

  it('answers a passage’s location without its text, for a ?passage= link', async () => {
    const passage = await app.prisma.passage.findFirst({
      where: { sourceId: pdfId },
      orderBy: { ord: 'asc' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/passages/${passage!.id}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().passage).toMatchObject({
      id: passage!.id,
      sourceId: pdfId,
      page: passage!.page,
      startBlockOrd: passage!.startBlockOrd,
      endBlockOrd: passage!.endBlockOrd,
    });
    // The reader highlights a range; it has no use for the passage text, and §17's
    // habit is to keep content out of payloads that do not need it.
    expect(response.json().passage.text).toBeUndefined();

    const foreign = await app.inject({
      method: 'GET',
      url: `/passages/${passage!.id}`,
      headers: { cookie: strangerCookie },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('answers 404 for another user’s reader routes', async () => {
    for (const url of [`/sources/${pdfId}/blocks?page=1`, `/sources/${pdfId}/outline`]) {
      const foreign = await app.inject({ method: 'GET', url, headers: { cookie: strangerCookie } });
      expect(foreign.statusCode, url).toBe(404);
    }
  });

  describe('citation targets', () => {
    it('resolves a citation to the block range of its passage', async () => {
      const passage = await app.prisma.passage.findFirst({
        where: { sourceId: webId },
        orderBy: { ord: 'asc' },
      });
      const citation = await app.prisma.citation.create({
        data: {
          sourceId: webId,
          passageId: passage!.id,
          quotedText: passage!.text.slice(0, 30),
          page: passage!.page,
          paragraphRef: passage!.paragraphRef,
          sectionHeading: passage!.sectionHeading,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/citations/${citation.id}/target`,
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().target).toMatchObject({
        sourceId: webId,
        spaceId,
        passageId: passage!.id,
        startBlockOrd: passage!.startBlockOrd,
        endBlockOrd: passage!.endBlockOrd,
        paragraphRef: passage!.paragraphRef,
        stale: false,
      });

      const foreign = await app.inject({
        method: 'GET',
        url: `/citations/${citation.id}/target`,
        headers: { cookie: strangerCookie },
      });
      expect(foreign.statusCode).toBe(404);
    });

    it('reports a stale citation with its recorded locator instead of a wrong one', async () => {
      const id = await addManual('Quoted then rewritten', 'A sentence worth citing.\nAnd another.');
      const passage = await app.prisma.passage.findFirst({ where: { sourceId: id } });
      const citation = await app.prisma.citation.create({
        data: {
          sourceId: id,
          passageId: passage!.id,
          quotedText: 'a quote that will not survive',
          page: null,
          paragraphRef: 'p1-p2',
          sectionHeading: null,
        },
      });

      await app.prisma.source.update({
        where: { id },
        data: { state: 'processing', content: 'Entirely different text now.' },
      });
      await ingest(id);

      const response = await app.inject({
        method: 'GET',
        url: `/citations/${citation.id}/target`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      // The passage is gone, so there is no block range to highlight — and the
      // recorded paragraph reference is answered rather than a guess.
      expect(response.json().target).toMatchObject({
        sourceId: id,
        passageId: null,
        startBlockOrd: null,
        endBlockOrd: null,
        paragraphRef: 'p1-p2',
        stale: true,
      });
    });
  });
});
