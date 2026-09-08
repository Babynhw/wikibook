import { useEffect, useRef, useState } from 'react';
import type { SourceState } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/locale';

/**
 * Icon + text, never color alone (PRD §18). The glyphs are `aria-hidden`: the
 * label is the accessible name, so a screen reader hears "Processing", not
 * "clock Processing".
 */
const PRESENTATION: Record<SourceState, { icon: string; className: string }> = {
  processing: {
    icon: '◐',
    className: 'border-outline-variant bg-surface-container-low text-on-surface-variant',
  },
  ready: {
    icon: '✓',
    className: 'border-outline-variant bg-secondary-container text-on-surface',
  },
  failed: {
    icon: '!',
    className: 'border-error/30 bg-error-container text-on-error-container',
  },
};

export function SourceStateBadge({ state }: { state: SourceState }) {
  const { text } = useUi();
  const { icon, className } = PRESENTATION[state];
  const label = { processing: text.source.processing, ready: text.source.ready, failed: text.source.failed }[state];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-xs',
        className,
      )}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

/**
 * A state change is announced politely, once, and only when it *changes* — the
 * first render is what the user already sees on screen, so announcing it would
 * read the whole library out on arrival (PRD §18).
 *
 * Separate from the badge because the badge is hidden once a source is ready,
 * and "it is ready now" is exactly the transition worth announcing.
 */
export function SourceStateAnnouncer({ state, title }: { state: SourceState; title: string }) {
  const { text } = useUi();
  const previous = useRef(state);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (previous.current === state) return;
    previous.current = state;
    setAnnouncement((state === 'ready' ? text.source.readyAnnouncement : state === 'failed' ? text.source.failedAnnouncement : text.source.processingAnnouncement).replace('{title}', title));
  }, [state, title, text.source]);

  return (
    <span role="status" aria-live="polite" className="sr-only">
      {announcement}
    </span>
  );
}
