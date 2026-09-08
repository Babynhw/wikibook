import { useEffect, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, type Source } from '@/lib/api';
import { useSpace } from '@/features/spaces/use-spaces';
import { useSources } from '@/features/sources/use-sources';
import { CitationContext, citationLabel } from '@/features/notebook/citation-node';
import { RenderDoc, collectCitationAttrs } from '@/features/notebook/render-doc';
import { useNotebook } from '@/features/notebook/use-notebook';

/**
 * `/spaces/:spaceId/notebook/print` — PRD §14's "browser print and save as PDF".
 * The document read-only, the space's name and objective above, the source
 * list below; `@media print` hides everything that is not those. Headings stay
 * with their paragraphs (`break-after: avoid`). Calls `window.print()` once the
 * data has painted; the on-screen controls are for when the dialog was closed.
 *
 * Source titles come from the space's source list — a renamed source prints
 * under its current name without a second serialiser.
 */
export function NotebookPrintPage() {
  const { spaceId = '' } = useParams<{ spaceId: string }>();
  const space = useSpace(spaceId);
  const notebook = useNotebook(spaceId);
  const active = useSources(spaceId);
  const archived = useSources(spaceId, { archived: 'only' });
  const printedRef = useRef(false);

  const sources = useMemo(() => {
    if (!active.data || !archived.data) return null;
    return new Map<string, Source>([...active.data, ...archived.data].map((s) => [s.id, s]));
  }, [active.data, archived.data]);

  const ready = Boolean(space.data && notebook.data && sources);
  const citations = useMemo(() => (notebook.data ? collectCitationAttrs(notebook.data.contentRich) : []), [notebook.data]);

  useEffect(() => {
    if (!ready || printedRef.current) return;
    printedRef.current = true;
    // After paint, so the dialog previews the document rather than the skeleton.
    const frame = requestAnimationFrame(() => window.print());
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  const error = space.error ?? notebook.error;

  return (
    <CitationContext.Provider value={{ spaceId, sourceIds: sources ? new Set(sources.keys()) : null }}>
      <div className="mx-auto max-w-2xl px-6 py-10 print:max-w-none print:px-0 print:py-0">
        <nav className="mb-8 flex items-center justify-between print:hidden" aria-label="Print controls">
          <Link
            to={`/spaces/${spaceId}/notebook`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to notebook
          </Link>
          <Button size="sm" onClick={() => window.print()} disabled={!ready}>
            <Printer className="size-4" aria-hidden="true" />
            Print
          </Button>
        </nav>

        {error ? (
          <Alert>{error instanceof ApiError ? error.message : 'The notebook could not be loaded for printing.'}</Alert>
        ) : !ready ? (
          <div className="space-y-3" aria-busy="true" aria-label="Preparing print view">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : (
          <article className="print-document">
            <header className="mb-8 border-b border-outline-variant pb-6">
              <h1 className="text-3xl font-bold tracking-tight text-on-surface">{space.data!.name}</h1>
              {space.data!.objective ? (
                <p className="mt-2 text-base text-on-surface-variant">
                  <span className="font-semibold">Objective:</span> {space.data!.objective}
                </p>
              ) : null}
            </header>

            <RenderDoc doc={notebook.data!.contentRich} />

            {citations.length > 0 ? (
              <section className="mt-10 border-t border-outline-variant pt-6" aria-labelledby="print-sources">
                <h2 id="print-sources" className="text-lg font-bold text-on-surface">
                  Sources
                </h2>
                <ol className="mt-3 list-none space-y-2 p-0 text-sm text-on-surface">
                  {citations.map((citation, index) => {
                    const live = sources!.get(citation.sourceId);
                    const where = citation.page !== null ? `p. ${citation.page}` : citation.paragraphRef ? `¶ ${citation.paragraphRef}` : null;
                    return (
                      <li key={citation.citationId} className="flex gap-2">
                        <span className="font-mono">[{index + 1}]</span>
                        <span>
                          {live ? (
                            <>
                              {live.title}
                              {live.author ? ` — ${live.author}` : ''}
                              {where ? ` — ${where}` : ''}
                              {live.url ? (
                                <>
                                  {' — '}
                                  <a href={live.url} rel="noopener noreferrer" className="underline">
                                    {live.url}
                                  </a>
                                </>
                              ) : null}
                            </>
                          ) : (
                            <>
                              {citationLabel(citation)} <span className="text-on-surface-variant">(source removed)</span>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}
          </article>
        )}
      </div>
    </CitationContext.Provider>
  );
}
