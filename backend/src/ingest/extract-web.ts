import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { UnretryableIngestError } from './errors.js';
import { assertSafeUrl } from './url-guard.js';
import type { LocatedBlock } from './chunk.js';
import type { WebExtractionResult } from './extracted.js';

export interface ExtractWebOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

const MAX_REDIRECTS = 5;
// Treated as blocks in article HTML; headings are tracked separately below.
const CONTAINERS = new Set([
  'div',
  'section',
  'article',
  'main',
  'figure',
  'ul',
  'ol',
  'aside',
  'header',
  'footer',
  'span',
  'em',
  'strong',
  'cite',
  'time',
  'a',
]);
const TEXT_BLOCKS = new Set(['p', 'li', 'pre', 'blockquote', 'td', 'th', 'figcaption', 'dt', 'dd']);

/**
 * Fetches the primary article content of a URL: capped, timeout-guarded fetch
 * (SSRF-safe after every redirect) → jsdom → Readability. Captures title,
 * publisher, author, and publication date when available (PRD §5.2).
 *
 * A JS-only or paywalled page that Readability cannot work with is a permanent
 * failure with a retry action — there is deliberately no headless browser (§20,
 * wiki-docs/plan/phase-2-ingestion/design.md).
 */
export async function extractWeb(
  rawUrl: string,
  { timeoutMs, maxBytes, fetchFn = fetch }: ExtractWebOptions,
): Promise<WebExtractionResult> {
  const html = await fetchHtmlCapped(rawUrl, { timeoutMs, maxBytes, fetchFn });

  const dom = new JSDOM(html, { url: rawUrl });
  const parse = new Readability(dom.window.document);
  const article = parse.parse();
  if (!article || !article.content) {
    throw new UnretryableIngestError('The article text could not be extracted from this page.');
  }

  const meta = readMeta(dom.window.document);
  const blocks = htmlToBlocks(article.content);
  if (blocks.length === 0) {
    throw new UnretryableIngestError('The article text could not be extracted from this page.');
  }

  return {
    text: blocks.map((block) => block.text).join('\n'),
    blocks,
    title: article.title?.trim() || meta.ogTitle || meta.titleTag || rawUrl,
    author: article.byline?.trim() || meta.author || null,
    publisher: article.siteName?.trim() || meta.siteName || null,
    publishedAt: meta.publishedTime?.trim() || article.publishedTime || null,
    url: rawUrl,
  };
}

async function fetchHtmlCapped(
  url: string,
  opts: ExtractWebOptions & { fetchFn: typeof fetch },
): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current);

    let response: Response;
    try {
      response = await opts.fetchFn(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'user-agent': 'WikiBookLM-ingest (+research assistant)',
        },
      });
    } catch (error) {
      // Timeout and connection failure are transient: BullMQ's attempts will
      // retry, and the source stays `processing` in the meantime.
      throw new Error(`Could not fetch ${current}.`, { cause: error });
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new UnretryableIngestError('The page redirected without a destination.');
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      // Transient: a 5xx usually clears up. The source stays `processing`.
      throw new Error(`The site answered ${response.status}.`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UnretryableIngestError(`The page could not be fetched (${response.status}).`);
    }

    const html = await readBody(response.body, opts.maxBytes);
    if (html.trim().length === 0) {
      throw new UnretryableIngestError('The page came back empty.');
    }
    return html;
  }
  throw new UnretryableIngestError('The page redirected too many times.');
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new UnretryableIngestError('This page is too large to read.');
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readMeta(document: Document) {
  const byName = (name: string) =>
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;
  const byProperty = (property: string) =>
    document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)?.content ?? null;
  return {
    ogTitle: byProperty('og:title'),
    siteName: byProperty('og:site_name'),
    author: byName('author') ?? byProperty('article:author') ?? byName('dc.creator'),
    publishedTime: byProperty('article:published_time') ?? byProperty('og:updated_time'),
    titleTag: document.querySelector<HTMLTitleElement>('title')?.textContent?.trim() ?? null,
  };
}

/**
 * Walks the Readability content into located blocks, tracking the nearest
 * preceding heading so `chunkBlocks` can attach `sectionHeading` (§6). `p`
 * and `li` at any depth are blocks; headings update the running value; plain
 * containers recurse without producing a block of their own (their text is
 * already covered by the leaves).
 */
function htmlToBlocks(html: string): LocatedBlock[] {
  const dom = new JSDOM(html);
  const root = dom.window.document.body;
  const blocks: LocatedBlock[] = [];
  let heading: string | undefined;

  const walk = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const text = element.textContent?.trim();
      if (text) heading = text;
      return;
    }
    if (TEXT_BLOCKS.has(tag)) {
      const text = element.textContent?.trim();
      if (text) {
        blocks.push({ text, paragraphIndex: blocks.length + 1, heading });
      }
      return;
    }
    if (!CONTAINERS.has(tag)) {
      // Unknown element with direct text (e.g. a wrapped sentence): keep it as
      // a block only if it has text and no block descendants will catch it.
      const hasBlockChild = Array.from(element.children).some(
        (child) => TEXT_BLOCKS.has(child.tagName.toLowerCase()),
      );
      if (!hasBlockChild) {
        const text = element.textContent?.trim();
        if (text) {
          blocks.push({ text, paragraphIndex: blocks.length + 1, heading });
        }
        return;
      }
    }
    for (const child of Array.from(element.children)) walk(child);
  };

  for (const child of Array.from(root.children)) walk(child);
  return blocks;
}