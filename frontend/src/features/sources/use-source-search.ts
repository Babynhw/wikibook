import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SourceListParams, SourceType } from '@/lib/api';

/** Long enough that a typed word is one request, short enough to feel live. */
export const SEARCH_DEBOUNCE_MS = 250;

const TYPES: SourceType[] = ['pdf', 'web', 'manual'];

function readType(raw: string | null): SourceType | undefined {
  return TYPES.find((type) => type === raw);
}

export interface SourceSearchState {
  /** What is in the input, updated on every keystroke. */
  input: string;
  /** What the API is asked with — the debounced query plus the filters. */
  params: SourceListParams;
  filtered: boolean;
  hasQuery: boolean;
  setInput: (value: string) => void;
  setType: (type: SourceType | undefined) => void;
  setArchived: (only: boolean) => void;
  clearQuery: () => void;
  clearAll: () => void;
}

/**
 * PRD §7's search and filters, held in the URL so a filtered library survives a
 * reload and the back button steps through it — the same reason a citation link
 * is a URL rather than component state.
 *
 * The query is debounced on the way *out* only: the input stays immediate, so
 * typing never lags, while `params` (and therefore the request) settles.
 */
export function useSourceSearch(): SourceSearchState {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const type = readType(searchParams.get('type'));
  const archivedOnly = searchParams.get('archived') === 'only';

  const [input, setInput] = useState(urlQuery);
  const [debounced, setDebounced] = useState(urlQuery);
  /** The last value this hook wrote into the URL, so its own echo is ignored. */
  const written = useRef(urlQuery);

  // A link into the library (or the back button) arrives with a query already in
  // the URL; the input follows it rather than the other way around.
  //
  // Only a query this hook did not write, though: the URL is written from
  // `debounced` a render later, and adopting that echo unconditionally would reset
  // `input` to it — discarding any keystroke typed in between.
  useEffect(() => {
    if (urlQuery === written.current) return;
    written.current = urlQuery;
    setInput(urlQuery);
    setDebounced(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    if (input === debounced) return;
    const timer = setTimeout(() => setDebounced(input), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, debounced]);

  // The settled query goes into the URL, replacing rather than pushing: every
  // keystroke would otherwise become a history entry to back out of.
  useEffect(() => {
    if (debounced === urlQuery) return;
    written.current = debounced;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (debounced) next.set('q', debounced);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [debounced, urlQuery, setSearchParams]);

  const update = (mutate: (next: URLSearchParams) => void) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      mutate(next);
      return next;
    });
  };

  return {
    input,
    params: {
      ...(debounced ? { q: debounced } : {}),
      ...(type ? { type } : {}),
      archived: archivedOnly ? 'only' : 'exclude',
    },
    filtered: type !== undefined || archivedOnly,
    hasQuery: debounced !== '',
    setInput,
    setType: (next) =>
      update((params) => {
        if (next) params.set('type', next);
        else params.delete('type');
      }),
    setArchived: (only) =>
      update((params) => {
        if (only) params.set('archived', 'only');
        else params.delete('archived');
      }),
    clearQuery: () => {
      setInput('');
      setDebounced('');
    },
    clearAll: () => {
      setInput('');
      setDebounced('');
      // Cleared here rather than by the sync effect, which sees `debounced` and the
      // URL already agreeing. Leaving it stale would make a later back button into
      // this query look like our own echo, and the input would not follow it.
      written.current = '';
      update((params) => {
        params.delete('q');
        params.delete('type');
        params.delete('archived');
      });
    },
  };
}
