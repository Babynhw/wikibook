import { useEffect, useId, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/locale';

/**
 * PDF page navigation (PRD §8, "navigate by PDF page when page data exists").
 * Rendered only when there is page data — a web article has no pages, and a
 * disabled pager on one would be furniture.
 *
 * Styled as the `source_detail` wireframe's viewer toolbar: a compact chevron pager
 * around an inset page field (`[ 1 ] / 5`). There is no "Go" button: the field is
 * a form, so Enter submits it, and the chevrons cover the click path.
 *
 * The jump is clamped rather than validated: a typed 900 in a 24-page source
 * lands on 24, which is what the user meant.
 */
export function PageNavigator({
  page,
  pageCount,
  onChange,
  className,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** Extra spacing when the pager sits inside a toolbar row. */
  className?: string;
}) {
  const { text } = useUi();
  const [draft, setDraft] = useState(String(page));
  const inputId = useId();

  // Prev/next and a deep link both move the page without touching the field.
  useEffect(() => setDraft(String(page)), [page]);

  const go = (next: number) => onChange(Math.min(Math.max(next, 1), pageCount));

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={page <= 1}
        onClick={() => go(page - 1)}
        aria-label={text.reader.previousPage}
      >
        <ChevronLeft className="size-4" />
      </Button>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Number(draft);
          if (Number.isFinite(parsed)) go(Math.trunc(parsed));
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {text.reader.page}
        </label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          // Deliberately no `min`/`max`: constraint validation *blocks* the
          // submit for an out-of-range value, so the browser would silently do
          // nothing where a typed 99 should land on the last page. The clamp is
          // ours, in `go`, which is the behavior this field promises.
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8 w-12 rounded border border-transparent bg-surface text-center font-mono text-sm font-medium text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <span className="font-mono text-sm text-on-surface-variant">/ {pageCount}</span>
        {/* A single-field form already submits on Enter; this button exists for
            assistive tech that lists a form's controls, not for the pointer. */}
        <button type="submit" className="sr-only">
          {text.reader.goToPage}
        </button>
      </form>

      <Button
        size="icon-sm"
        variant="ghost"
        disabled={page >= pageCount}
        onClick={() => go(page + 1)}
        aria-label={text.reader.nextPage}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
