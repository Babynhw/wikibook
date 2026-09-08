import { useQuery } from '@tanstack/react-query';
import { sourcesApi, type SourceBlock, type SourceDetail, type SourceOutline } from '@/lib/api';

export const readerKeys = {
  outline: (sourceId: string) => ['reader', 'outline', sourceId] as const,
  page: (sourceId: string, page: number) => ['reader', 'page', sourceId, page] as const,
  window: (sourceId: string, from: number) => ['reader', 'window', sourceId, from] as const,
};

/** How many blocks a page-less source loads at a time. Matches the server's default. */
export const READER_WINDOW = 120;

export function useSourceOutline(sourceId: string) {
  return useQuery({
    queryKey: readerKeys.outline(sourceId),
    queryFn: () => sourcesApi.outline(sourceId),
    enabled: sourceId !== '',
  });
}

/**
 * The reader's text. A PDF is fetched a page at a time because §8 navigates it by
 * page; everything else is fetched as a window, aimed at the block the reader
 * needs — a deep link opens *the window containing the target* rather than the
 * first window followed by a scroll, which is what keeps §19's 2.5 s true for a
 * 200-page source opened at page 137.
 */
export function useSourceBlocks(
  sourceId: string,
  location: { page: number | null; from: number },
) {
  const byPage = location.page !== null;
  return useQuery({
    queryKey: byPage
      ? readerKeys.page(sourceId, location.page!)
      : readerKeys.window(sourceId, location.from),
    queryFn: () =>
      sourcesApi
        .blocks(
          sourceId,
          byPage ? { page: location.page! } : { from: location.from, limit: READER_WINDOW },
        )
        .then(({ blocks }) => blocks),
    enabled: sourceId !== '',
  });
}

export interface ReaderTarget {
  startBlockOrd: number | null;
  endBlockOrd: number | null;
  page: number | null;
  paragraphRef: string | null;
  /** Set when a target was asked for but could not be resolved to a location. */
  unresolved: boolean;
}

/**
 * Resolves the reader's URL to a location, most-exact-first (PRD §8):
 *
 * 1. A passage's block range, from the passages the reader already knows about.
 *    This is the only branch that cannot be wrong — the range was recorded when
 *    the passage was written.
 * 2. The `page` or `para` the link carries, highlighting the whole page or
 *    paragraph instead of a sentence.
 * 3. Nothing: the source opens at the top and says the cited location is gone.
 *    Not an error — the source is fine, the pointer is stale.
 *
 * The passage lookup is a server call, so this hook takes the *resolved* range
 * from `useCitationTarget`/the URL and only decides what to highlight.
 */
export function resolveTarget(params: {
  startBlockOrd: number | null;
  endBlockOrd: number | null;
  page: number | null;
  paragraphRef: string | null;
  requested: boolean;
}): ReaderTarget {
  const { startBlockOrd, endBlockOrd, page, paragraphRef, requested } = params;
  if (startBlockOrd !== null) {
    return {
      startBlockOrd,
      endBlockOrd: endBlockOrd ?? startBlockOrd,
      page,
      paragraphRef,
      unresolved: false,
    };
  }
  if (page !== null || paragraphRef !== null) {
    return { startBlockOrd: null, endBlockOrd: null, page, paragraphRef, unresolved: false };
  }
  return { startBlockOrd: null, endBlockOrd: null, page: null, paragraphRef: null, unresolved: requested };
}

/** The first block a `pN` or `pN-pM` reference names, or null if it is not one. */
export function paragraphStart(paragraphRef: string | null): number | null {
  if (!paragraphRef) return null;
  const match = /^p(\d+)/.exec(paragraphRef);
  return match ? Number(match[1]) : null;
}

/** The window a target sits in, so a deep link loads the right slice at once. */
export function windowFor(ord: number | null): number {
  if (ord === null || ord < 1) return 1;
  return Math.max(1, Math.floor((ord - 1) / READER_WINDOW) * READER_WINDOW + 1);
}

export type { SourceBlock, SourceDetail, SourceOutline };
