import { useEffect, useRef } from 'react';
import type { SourceBlock } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * A block *is* a heading when its nearest heading is its own text — the
 * convention the PDF extractor emits (backend `LocatedBlock.heading`). Web and
 * manual blocks never satisfy it, so they always read as paragraphs.
 */
export const isHeadingBlock = (block: SourceBlock) =>
  block.heading !== null && block.heading === block.text;

/**
 * One block of extracted text, highlighted when a citation points at it.
 *
 * Body blocks are set in the reading face (DESIGN.md "Reading face"); a heading
 * block is an `<h2>` in the UI face, so the document's own structure shows
 * without the reader having to guess it from the text.
 *
 * The highlight is background **plus** a left border **plus** visually hidden
 * text: §18 forbids colour as the only channel, and a screen reader has to be
 * able to tell that this is the cited passage.
 *
 * Scrolling happens once, when the first cited block mounts. A highlight that
 * re-scrolls on every render fights the user who is reading around it.
 */
export function Block({
  block,
  cited,
  scrollTo,
  reference,
}: {
  block: SourceBlock;
  cited: boolean;
  scrollTo: boolean;
  reference?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    if (!scrollTo || scrolled.current) return;
    scrolled.current = true;
    // Optional call, not a bare one: `scrollIntoView` is absent in jsdom and in
    // some embedded webviews, and a missing convenience must not take the reader
    // down with it — the highlight is still rendered either way.
    ref.current?.scrollIntoView?.({ block: 'center' });
  }, [scrollTo]);

  const heading = isHeadingBlock(block);
  const shared = {
    // A callback ref: React's `RefObject` is typed per element, so one object ref
    // cannot be handed to both `h2` and `p` without a cast; a callback can.
    ref: (node: HTMLElement | null) => {
      ref.current = node;
    },
    'data-ord': block.ord,
    'data-cited': cited ? 'true' : undefined,
    ...(cited ? { 'aria-current': 'location' as const } : {}),
  };
  const children = (
    <>
      {cited ? <span className="sr-only">Cited passage{reference ? `, ${reference}` : ''}. </span> : null}
      {block.text}
    </>
  );
  const citedClass = cited && 'border-l-4 border-primary bg-primary/10 py-1 pl-3';

  // Two explicit branches rather than a dynamic tag: `h2` and `p` are both
  // `HTMLElement`, so one ref serves both without a cast.
  return heading ? (
    <h2
      {...shared}
      className={cn(
        'mt-6 wrap-anywhere font-sans text-2xl font-bold leading-tight tracking-tight text-on-surface first:mt-0',
        citedClass,
      )}
    >
      {children}
    </h2>
  ) : (
    // `wrap-anywhere`: a bare URL or an unspaced run in the extracted text must
    // wrap, not widen the column — in the assistant pane that widening was a
    // horizontal scrollbar over the cited passage.
    <p {...shared} className={cn('wrap-anywhere font-serif text-base leading-7 text-on-surface', citedClass)}>
      {children}
    </p>
  );
}
