import type { ReactNode } from 'react';
import { CitationChip, type CitationAttrs } from './citation-node';

/**
 * A read-only renderer for the notebook document, for the print view. The same
 * shape the editor produces and the server validates; anything else renders as
 * nothing rather than as a surprise.
 */
type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: DocNode[];
  text?: string;
};

/** Twin of `backend/src/notebook/markdown.ts` `collectCitations` — no shared package, so change both. */
export function collectCitationAttrs(doc: unknown): CitationAttrs[] {
  const seen = new Map<string, CitationAttrs>();
  const walk = (node: DocNode | undefined) => {
    if (!node) return;
    if (node.type === 'citation' && node.attrs) {
      const attrs = node.attrs as unknown as CitationAttrs;
      if (!seen.has(attrs.citationId)) seen.set(attrs.citationId, attrs);
    }
    node.content?.forEach(walk);
  };
  walk(doc as DocNode);
  return [...seen.values()];
}

function Inline({ nodes, numberOf }: { nodes?: DocNode[]; numberOf: (id: string) => number }) {
  return (
    <>
      {(nodes ?? []).map((node, i) => {
        if (node.type === 'hardBreak') return <br key={i} />;
        if (node.type === 'citation') {
          const attrs = node.attrs as unknown as CitationAttrs;
          return (
            <sup key={i} className="print:text-[0.7em]">
              <span className="print:hidden">
                <CitationChip attrs={attrs} interactive={false} />
              </span>
              <span className="hidden print:inline">[{numberOf(attrs.citationId)}]</span>
            </sup>
          );
        }
        if (node.type !== 'text') return null;
        let out: ReactNode = node.text ?? '';
        const marks = node.marks ?? [];
        if (marks.some((m) => m.type === 'bold')) out = <strong>{out}</strong>;
        if (marks.some((m) => m.type === 'italic')) out = <em>{out}</em>;
        const link = marks.find((m) => m.type === 'link');
        if (link && typeof link.attrs?.href === 'string') {
          const href = link.attrs.href;
          out = (
            <a href={href} rel="noopener noreferrer" className="text-primary underline">
              {out}
              <span className="hidden print:inline"> ({href})</span>
            </a>
          );
        }
        return <span key={i}>{out}</span>;
      })}
    </>
  );
}

function Blocks({ nodes, numberOf }: { nodes?: DocNode[]; numberOf: (id: string) => number }) {
  return (
    <>
      {(nodes ?? []).map((node, i) => {
        switch (node.type) {
          case 'paragraph':
            return (
              <p key={i}>
                <Inline nodes={node.content} numberOf={numberOf} />
              </p>
            );
          case 'heading': {
            const level = Number(node.attrs?.level ?? 1);
            const Tag = (`h${Math.min(Math.max(level, 1), 3) + 1}`) as 'h2' | 'h3' | 'h4';
            return (
              <Tag key={i}>
                <Inline nodes={node.content} numberOf={numberOf} />
              </Tag>
            );
          }
          case 'blockquote':
            return (
              <blockquote key={i}>
                <Blocks nodes={node.content} numberOf={numberOf} />
              </blockquote>
            );
          case 'bulletList':
            return (
              <ul key={i}>
                <Blocks nodes={node.content} numberOf={numberOf} />
              </ul>
            );
          case 'orderedList':
            return (
              <ol key={i} start={typeof node.attrs?.start === 'number' ? node.attrs.start : undefined}>
                <Blocks nodes={node.content} numberOf={numberOf} />
              </ol>
            );
          case 'listItem':
            return (
              <li key={i}>
                <Blocks nodes={node.content} numberOf={numberOf} />
              </li>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

export function RenderDoc({ doc }: { doc: unknown }) {
  const citations = collectCitationAttrs(doc);
  const numbers = new Map(citations.map((c, i) => [c.citationId, i + 1]));
  const numberOf = (id: string) => numbers.get(id) ?? 0;
  return (
    <div className="prose-notebook font-serif text-base leading-7 text-on-surface">
      <Blocks nodes={(doc as DocNode).content} numberOf={numberOf} />
    </div>
  );
}
