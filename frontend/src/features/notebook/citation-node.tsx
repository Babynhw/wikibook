import { createContext, useContext } from 'react';
import { Node, mergeAttributes, type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Link } from 'react-router-dom';
import type { NoteCitation } from '@/lib/api';

/**
 * A citation the user dropped into the notebook (PRD §13 "open citations that
 * have been copied into the notebook"; §14's inline references).
 *
 * The node copies the citation's *locator* rather than only pointing at the
 * `Citation` row: that row belongs to a note or a source and is cascaded away
 * with either, and a notebook that outlives what it drew from must not fill
 * up with chips that resolve to nothing. The reader already falls back from
 * `?cite=` to `page`/`para` to the top of the source, so a chip whose row is
 * gone still lands on the right page (design "The node copies its locator").
 */
export interface CitationAttrs {
  citationId: string;
  sourceId: string;
  sourceTitle: string;
  page: number | null;
  paragraphRef: string | null;
  quotedText: string;
}

export function citationAttrsFrom(citation: NoteCitation): CitationAttrs {
  return {
    citationId: citation.id,
    sourceId: citation.sourceId,
    sourceTitle: citation.sourceTitle,
    page: citation.page,
    paragraphRef: citation.paragraphRef,
    quotedText: citation.quotedText,
  };
}

/** Where a chip opens: the reader, carrying every locator the node has, and the way back. */
export function citationHref(spaceId: string, attrs: CitationAttrs): string {
  const search = new URLSearchParams({ cite: attrs.citationId });
  if (attrs.page !== null) search.set('page', String(attrs.page));
  if (attrs.paragraphRef) search.set('para', attrs.paragraphRef);
  search.set('from', `/spaces/${spaceId}/notebook`);
  return `/spaces/${spaceId}/sources/${attrs.sourceId}?${search.toString()}`;
}

export function citationLabel(attrs: CitationAttrs): string {
  const where = attrs.page !== null ? `p. ${attrs.page}` : attrs.paragraphRef ? `¶ ${attrs.paragraphRef}` : null;
  return where ? `${attrs.sourceTitle}, ${where}` : attrs.sourceTitle;
}

/**
 * What the chips need from the page: the space they live in and which of its
 * sources still exist. A React context rather than node options so the same
 * schema serves the editor and the print view, and so a source deleted while
 * the notebook is open changes the chip on the next render, not the next load.
 */
export interface CitationContextValue {
  spaceId: string;
  /** `null` while the source list is loading — the chip then assumes present. */
  sourceIds: ReadonlySet<string> | null;
}

export const CitationContext = createContext<CitationContextValue>({ spaceId: '', sourceIds: null });

export function CitationChip({
  attrs,
  interactive = true,
}: {
  attrs: CitationAttrs;
  /** The print view renders the marker only — a link to the app is useless on paper. */
  interactive?: boolean;
}) {
  const { spaceId, sourceIds } = useContext(CitationContext);
  const removed = sourceIds !== null && !sourceIds.has(attrs.sourceId);
  const label = citationLabel(attrs);
  const className =
    'mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded border border-outline-variant bg-surface-container-low px-1.5 font-mono text-[0.8em] leading-snug text-primary no-underline align-baseline hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
  if (!interactive) {
    return (
      <span className={className}>
        [{label}]{removed ? <span className="text-on-surface-variant">(source removed)</span> : null}
      </span>
    );
  }
  return (
    <Link
      to={citationHref(spaceId, attrs)}
      className={className}
      // The REQ-186 pattern: the accessible name says where the control goes.
      aria-label={`Open citation: ${label}${removed ? ' (source removed)' : ''}`}
      title={attrs.quotedText}
      draggable={false}
    >
      <span aria-hidden="true">[{label}]</span>
      {removed ? (
        <span aria-hidden="true" className="text-on-surface-variant">
          (source removed)
        </span>
      ) : null}
    </Link>
  );
}

function CitationNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className="inline">
      <CitationChip attrs={node.attrs as CitationAttrs} />
    </NodeViewWrapper>
  );
}

export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      citationId: { default: '' },
      sourceId: { default: '' },
      sourceTitle: { default: '' },
      page: { default: null },
      paragraphRef: { default: null },
      quotedText: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-citation-id]',
        getAttrs: (element) => {
          const el = element as HTMLElement;
          const page = el.getAttribute('data-page');
          return {
            citationId: el.getAttribute('data-citation-id') ?? '',
            sourceId: el.getAttribute('data-source-id') ?? '',
            sourceTitle: el.getAttribute('data-source-title') ?? '',
            page: page ? Number(page) : null,
            paragraphRef: el.getAttribute('data-paragraph-ref'),
            quotedText: el.getAttribute('data-quoted-text') ?? '',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as CitationAttrs;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-citation-id': attrs.citationId,
        'data-source-id': attrs.sourceId,
        'data-source-title': attrs.sourceTitle,
        'data-page': attrs.page ?? undefined,
        'data-paragraph-ref': attrs.paragraphRef ?? undefined,
        'data-quoted-text': attrs.quotedText,
      }),
      `[${citationLabel(attrs)}]`,
    ];
  },

  // Plain-text copy of a chip reads as its label, so pasting into another app
  // keeps the reference legible.
  renderText({ node }) {
    return `[${citationLabel(node.attrs as CitationAttrs)}]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(CitationNodeView);
  },
});
