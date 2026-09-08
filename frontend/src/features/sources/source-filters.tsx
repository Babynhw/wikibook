import type { SourceType } from '@/lib/api';
import type { SourceSearchState } from '@/features/sources/use-source-search';
import { useUi } from '@/lib/locale';

const TYPE_TABS: (SourceType | undefined)[] = [
  undefined,
  'pdf',
  'web',
  'manual',
];

/**
 * PRD §7's search and filters. The type filter is a tablist rather than a
 * `<select>`: the options are few, always visible, and arrow-key navigable, and
 * it matches the filter row Phase 1 built for spaces.
 *
 * Filters and the query apply together — §7 requires them to combine, so nothing
 * here clears anything else.
 */
export function SourceFilters({
  search,
  resultCount,
}: {
  search: SourceSearchState;
  resultCount: number;
}) {
  const { text } = useUi();
  const { input, params, setInput, setType, setArchived } = search;
  const archivedOnly = params.archived === 'only';

  return (
    <div className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-on-surface">{text.sources.search}</span>
        <input
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={text.sources.searchPlaceholder}
          className="h-10 rounded border border-outline-variant bg-surface-container-lowest px-3 text-base text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={text.sources.filterByType} className="flex flex-wrap gap-1">
          {TYPE_TABS.map((value) => {
            const selected = params.type === value;
            const label = value === undefined
              ? text.sources.allTypes
              : value === 'pdf'
                ? 'PDF'
                : value === 'web'
                  ? text.sources.webLink
                  : text.sources.text;
            return (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setType(value)}
                className={
                  selected
                    ? 'h-8 rounded bg-primary px-3 text-sm font-medium text-on-primary'
                    : 'h-8 rounded px-3 text-sm text-on-surface-variant hover:bg-surface-container-low'
                }
              >
                {label}
              </button>
            );
          })}
        </div>

        <label className="ml-auto flex items-center gap-2 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            checked={archivedOnly}
            onChange={(event) => setArchived(event.target.checked)}
            className="size-4 rounded border-outline-variant"
          />
          {text.sources.showArchived}
        </label>
      </div>

      {/* A search that silently rewrites a list is invisible to a screen reader
          (PRD §18), so the count is announced rather than only rendered. */}
      <p aria-live="polite" className="font-mono text-xs text-outline">
        {resultCount} {resultCount === 1 ? text.sources.source : text.sources.sources}
        {archivedOnly ? ` · ${text.sources.archived}` : ''}
      </p>
    </div>
  );
}
