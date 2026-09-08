import { useEffect, useRef, useState } from 'react';
import type { SourceState } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Icon + text, never color alone (PRD §18). The glyphs are `aria-hidden`: the
 * label is the accessible name, so a screen reader hears "Processing", not
 * "clock Processing".
 */
const PRESENTATION: Record<SourceState, { label: string; icon: string; className: string }> = {
  processing: {
    label: 'Processing',
    icon: '◐',
    className: 'border-outline-variant bg-surface-container-low text-on-surface-variant',
  },
  ready: {
    label: 'Ready',
    icon: '✓',
    className: 'border-outline-variant bg-secondary-container text-on-surface',
  },
  failed: {
    label: 'Failed',
    icon: '!',
    className: 'border-error/30 bg-error-container text-on-error-container',
  },
};

export function SourceStateBadge({ state }: { state: SourceState }) {
  const { label, icon, className } = PRESENTATION[state];

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
  const previous = useRef(state);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (previous.current === state) return;
    previous.current = state;
    setAnnouncement(
      state === 'ready'
        ? `${title} is ready to use.`
        : state === 'failed'
          ? `${title} could not be processed.`
          : `${title} is processing.`,
    );
  }, [state, title]);

  return (
    <span role="status" aria-live="polite" className="sr-only">
      {announcement}
    </span>
  );
}
