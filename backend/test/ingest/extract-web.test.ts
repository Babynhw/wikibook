import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn() };
});

import { lookup as lookupMock } from 'node:dns/promises';
import { extractWeb } from '../../src/ingest/extract-web.js';
import { UnretryableIngestError } from '../../src/ingest/errors.js';

const resolvesTo = (addresses: string[]) => {
  (lookupMock as unknown as Mock).mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
};

const ARTICLE = `<!doctype html>
<html>
<head>
  <title>The Sleep Study</title>
  <meta property="og:site_name" content="Journal of Sleep">
  <meta name="author" content="Dr. A. Rest">
  <meta property="article:published_time" content="2026-01-02T10:00:00Z">
</head>
<body>
  <nav><a href="/ads">Sponsored junk</a></nav>
  <div id="main">
    <h1>Why Sleep Consolidates Memory</h1>
    <p>Sleep is not a passive state. The brain reorganises itself while you rest.</p>
    <h2>Slow-wave rest</h2>
    <p>During deep sleep the brain replays the day's learning.</p>
    <p>This replay strengthens the synapses that will survive into tomorrow.</p>
  </div>
</body>
</html>`;

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('extractWeb', () => {
  it('extracts the article content with metadata and heading-associated blocks', async () => {
    resolvesTo(['93.184.216.34']);
    const result = await extractWeb('https://example.com/article', {
      timeoutMs: 5_000,
      maxBytes: 100_000,
      fetchFn: async () => htmlResponse(ARTICLE),
    });

    expect(result.title).toContain('The Sleep Study');
    expect(result.author).toBe('Dr. A. Rest');
    expect(result.publisher).toBe('Journal of Sleep');
    expect(result.publishedAt).toBe('2026-01-02T10:00:00Z');
    expect(result.text).toContain('Sleep is not a passive state');
    // Navigation is dropped by Readability; article content is kept.
    expect(result.text).not.toContain('Sponsored junk');

    // Nearest preceding heading stays attached to its paragraphs (§6).
    const slowWave = result.blocks.find((block) => block.text.includes('During deep sleep'));
    expect(slowWave?.heading).toBe('Slow-wave rest');
    const intro = result.blocks.find((block) => block.text.includes('not a passive state'));
    expect(intro?.heading).toBe('Why Sleep Consolidates Memory');
  });

  it('rejects a redirect that lands on a private network (guard re-checked after each hop)', async () => {
    const fetchFn: typeof fetch = async (url) =>
      new Response(null, {
        status: 302,
        headers: String(url) === 'https://example.com/a' ? { location: 'http://10.0.0.1/steal' } : {},
      });
    const error = await extractWeb('https://example.com/a', {
      timeoutMs: 5_000,
      maxBytes: 100_000,
      fetchFn,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
    expect((error as UnretryableIngestError).userMessage).toMatch(/private network/);
  });

  it('leaves 5xx alone as a transient failure, not a permanent one', async () => {
    resolvesTo(['93.184.216.34']);
    const error = await extractWeb('https://example.com/flaky', {
      timeoutMs: 5_000,
      maxBytes: 100_000,
      fetchFn: async () => htmlResponse('', 503),
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).not.toBeInstanceOf(UnretryableIngestError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('503');
  });

  it('reports a permanent failure when no article can be found', async () => {
    resolvesTo(['93.184.216.34']);
    const error = await extractWeb('https://example.com/no-article', {
      timeoutMs: 5_000,
      maxBytes: 100_000,
      fetchFn: async () => htmlResponse('<html><body>Just some words with no structure.</body></html>'),
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
    expect((error as UnretryableIngestError).userMessage).toBe(
      'The article text could not be extracted from this page.',
    );
  });
});