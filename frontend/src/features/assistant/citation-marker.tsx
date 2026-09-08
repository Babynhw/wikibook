import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { citationsApi, type MessageCitation } from '@/lib/api';

/**
 * The `[n]` beside a claim.
 *
 * A `<button>`, not a superscript: it does something, and §18 wants the semantic
 * element. Its accessible name says where it goes — "1" announced on its own tells
 * a screen-reader user nothing.
 *
 * The reader URL is **never assembled here.** The client asks
 * `GET /citations/:id/target` and navigates to what that answers, because Phase 3
 * spent a whole phase putting locator interpretation in exactly one place
 * (wiki-docs/plan/phase-3-library-reader/design.md "The reader's URL is the
 * citation contract"). A stale target still navigates: the reader says the exact
 * passage is gone and shows the recorded page (REQ-134).
 */
export function CitationMarker({
  citation,
  spaceId,
  returnTo,
  onOpenInPane,
}: {
  citation: MessageCitation;
  spaceId: string;
  /** `?from=` — where the reader's back control returns to. */
  returnTo: string;
  /** Set on wide viewports, where the reader is a pane rather than a route. */
  onOpenInPane?: (target: { sourceId: string; passageId: string | null; page: number | null }) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (!citation.id || busy) return;
    setBusy(true);
    try {
      const { target } = await citationsApi.target(citation.id);
      if (onOpenInPane) {
        onOpenInPane({
          sourceId: target.sourceId,
          passageId: target.passageId,
          page: target.page,
        });
        return;
      }
      const search = new URLSearchParams();
      if (target.passageId) search.set('passage', target.passageId);
      else if (target.page !== null) search.set('page', String(target.page));
      else if (target.paragraphRef) search.set('para', target.paragraphRef);
      search.set('from', returnTo);
      navigate(`/spaces/${spaceId}/sources/${target.sourceId}?${search.toString()}`);
    } catch {
      // A citation that cannot be resolved is not an error state for the answer:
      // the answer is still correct, the pointer is not reachable right now.
    } finally {
      // Reset on *every* path. Leaving it set on success made the marker inert
      // after one click in pane mode — close the reader, click again, nothing.
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={!citation.id}
      aria-label={`Citation ${citation.index}: ${citation.sourceTitle}, ${citation.reference}${
        citation.stale ? ' (passage no longer available)' : ''
      }`}
      title={citation.stale ? 'The cited passage is no longer available' : undefined}
      className="mx-0.5 inline-flex min-w-5 items-center justify-center gap-0.5 rounded border border-outline-variant bg-surface-container-low px-1 align-baseline text-xs font-medium text-primary hover:bg-surface-container disabled:opacity-50"
    >
      {citation.index}
      {/* Stale is a glyph plus the name above, never a colour alone (PRD §18). */}
      {citation.stale ? <span aria-hidden="true">!</span> : null}
    </button>
  );
}
