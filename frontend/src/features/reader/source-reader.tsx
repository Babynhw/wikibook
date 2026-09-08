import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, passagesApi } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useRetrySource, useSource } from '@/features/sources/use-sources';
import { Block } from '@/features/reader/block';
import { PageNavigator } from '@/features/reader/page-navigator';
import { ReaderHeader } from '@/features/reader/reader-header';
import {
  paragraphStart,
  resolveTarget,
  useSourceBlocks,
  windowFor,
  READER_WINDOW,
} from '@/features/reader/use-source-content';

export interface ReaderLink {
  /** `?passage=` — the exact target, resolved to a block range server-side. */
  passageId?: string | undefined;
  page?: number | undefined;
  paragraphRef?: string | undefined;
  /** `?from=` — an in-app path to return to (an answer, a note). */
  from?: string | undefined;
}

/**
 * A `?from=` value is user-controllable text in the URL bar. It is rendered as a
 * link, so it must be an in-app path and nothing else: an absolute URL here
 * would be an open redirect, in a phase that has no reason to have one.
 */
export function safeReturnPath(from: string | undefined): string | null {
  if (!from) return null;
  if (!from.startsWith('/')) return null;
  // `//host` and `/\host` are protocol-relative URLs, not paths.
  if (/^[/\\]{2}/.test(from)) return null;
  return from;
}

/**
 * PRD §8's source reader, as a component rather than only a route: Phase 4's
 * three-pane layout mounts this same reader in a pane beside an answer, and a
 * reader that only existed as a route would be rewritten there.
 *
 * Reading never modifies the source — there is no open-stamp, no state change,
 * no passage rewritten. The only writes on this screen are the explicit metadata,
 * archive, and delete controls in the header.
 */
export function SourceReader({
  sourceId,
  link,
  readOnly = false,
  showHeader = true,
}: {
  sourceId: string;
  link: ReaderLink;
  readOnly?: boolean;
  /**
   * False lets a host (the assistant's reader pane) render the header itself,
   * outside the reading body's scroll region. The pane pins it beside its own
   * Close control; this component doesn't know about that, so it must not draw
   * a second header the user would see scroll away.
   */
  showHeader?: boolean;
}) {
  const navigate = useNavigate();
  const source = useSource(sourceId);
  const retry = useRetrySource(source.data?.spaceId ?? '');

  // The exact target: a passage's recorded block range. Resolved by the API so
  // that locator interpretation lives in one place (see `/passages/:id`).
  const passage = useQuery({
    queryKey: ['reader', 'passage', link.passageId ?? ''],
    queryFn: () => passagesApi.get(link.passageId!).then(({ passage }) => passage),
    enabled: link.passageId !== undefined,
    retry: 0,
  });

  const requested = link.passageId !== undefined || link.page !== undefined || link.paragraphRef !== undefined;
  // A `?passage=` link is only resolved once its lookup has answered. Deriving the
  // location before then would open page 1 and *stay* there — the location is
  // owned by the user's navigation after arrival, so a late target could not move
  // it. This is the ordering bug the deep-link tests exist to catch.
  const targetSettled = link.passageId === undefined || passage.isSuccess || passage.isError;
  const target = resolveTarget({
    startBlockOrd: passage.data?.startBlockOrd ?? null,
    endBlockOrd: passage.data?.endBlockOrd ?? null,
    page: passage.data?.page ?? link.page ?? null,
    paragraphRef: passage.data?.paragraphRef ?? link.paragraphRef ?? null,
    requested: requested && targetSettled,
  });

  const paged = (source.data?.pageCount ?? null) !== null;
  const [page, setPage] = useState<number | null>(null);
  const [windowStart, setWindowStart] = useState<number | null>(null);

  // The location is derived from the link on arrival and then owned by the user's
  // navigation. A deep link opens the window *containing* the target rather than
  // the first one, which is what keeps a late page inside §19's budget.
  useEffect(() => {
    if (!source.data || !targetSettled) return;
    if (paged) {
      setPage((current) => current ?? target.page ?? 1);
    } else {
      setWindowStart((current) =>
        current ?? windowFor(target.startBlockOrd ?? paragraphStart(target.paragraphRef)),
      );
    }
  }, [source.data, targetSettled, paged, target.page, target.startBlockOrd, target.paragraphRef]);

  const locationKnown = paged ? page !== null : windowStart !== null;
  const blocks = useSourceBlocks(
    // Held back until the location is known: fetching page 1 first and page N a
    // moment later would double the requests and flash the wrong text.
    locationKnown ? sourceId : '',
    { page: paged ? (page ?? 1) : null, from: windowStart ?? 1 },
  );

  if (source.isPending) {
    return <p className="text-sm text-on-surface-variant">Loading this source…</p>;
  }

  if (source.isError) {
    const missing = source.error instanceof ApiError && source.error.status === 404;
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-on-surface">
          {missing ? 'We could not find that source' : 'We could not load that source'}
        </h1>
        <p className="mt-2 max-w-prose text-on-surface-variant">
          {missing
            ? 'It may have been deleted, or the link may belong to a different account.'
            : source.error instanceof ApiError
              ? source.error.message
              : 'Please try again.'}
        </p>
        {missing ? null : (
          <Button className="mt-4" variant="secondary" onClick={() => void source.refetch()}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  const detail = source.data;
  const returnPath = safeReturnPath(link.from);

  // The reference describes where the *target* is, so it is shown only while the
  // reader is still there. After Next page or Later, a leftover "page 2" would
  // name a location the user has navigated away from.
  const onTarget = paged
    ? target.page === null || page === null || page === target.page
    : windowStart === null ||
      windowStart === windowFor(target.startBlockOrd ?? paragraphStart(target.paragraphRef));
  const reference = !onTarget
    ? null
    : target.page !== null
      ? `page ${target.page}`
      : target.paragraphRef
        ? `paragraph ${target.paragraphRef.replace(/p/g, '')}`
        : null;

  // The one-line reading position. Shown in the route's viewer toolbar, or as a
  // plain line of copy in the assistant pane where there is no toolbar.
  const locationLabel =
    onTarget && target.startBlockOrd !== null
      ? `Showing the cited passage${reference ? ` · ${reference}` : ''}${
          target.paragraphRef && target.page !== null ? ` · ${target.paragraphRef}` : ''
        }`
      : reference
        ? `Showing ${reference}`
        : null;

  const pager =
    paged && detail.pageCount !== null ? (
      <PageNavigator
        page={page ?? 1}
        pageCount={detail.pageCount}
        onChange={(next) => setPage(next)}
      />
    ) : null;

  // The reading surface: extracted blocks, then the paging controls for a page-less
  // long source. Shared by the route's paper and the pane's plain column.
  const content = (
    <>
      {blocks.isPending ? (
        <p className="text-sm text-on-surface-variant">Loading this source’s text…</p>
      ) : blocks.isError ? (
        <Alert>
          {blocks.error instanceof ApiError
            ? blocks.error.message
            : 'We could not load this source’s text.'}
        </Alert>
      ) : blocks.data.length === 0 ? (
        <p className="text-sm text-on-surface-variant">
          {detail.state === 'ready'
            ? 'There is no extracted text to show for this part of the source.'
            : 'No text yet.'}
        </p>
      ) : (
        <article className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          {blocks.data.map((block) => {
            const cited =
              target.startBlockOrd !== null &&
              block.ord >= target.startBlockOrd &&
              block.ord <= (target.endBlockOrd ?? target.startBlockOrd);
            return (
              <Block
                key={block.ord}
                block={block}
                cited={cited}
                scrollTo={cited && block.ord === target.startBlockOrd}
                {...(reference ? { reference } : {})}
              />
            );
          })}
        </article>
      )}

      {!paged && detail.blockCount > READER_WINDOW ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={(windowStart ?? 1) <= 1}
            onClick={() => setWindowStart(Math.max(1, (windowStart ?? 1) - READER_WINDOW))}
          >
            Earlier
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={(windowStart ?? 1) + READER_WINDOW > detail.blockCount}
            onClick={() => setWindowStart((windowStart ?? 1) + READER_WINDOW)}
          >
            Later
          </Button>
          <span className="font-mono text-xs text-outline">
            paragraphs {windowStart ?? 1}–
            {Math.min((windowStart ?? 1) + READER_WINDOW - 1, detail.blockCount)} of{' '}
            {detail.blockCount}
          </span>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {showHeader ? (
        <>
          {returnPath ? (
            // §8: the user must be able to return to the originating answer or note.
            // Labelled with where it goes, not just "Back". The route's breadcrumb
            // already leads back to the space, so this is the only extra line, and
            // only when a citation put the user here.
            <Link to={returnPath} className="text-sm text-primary underline">
              Back to the answer
            </Link>
          ) : null}

          <ReaderHeader
            source={detail}
            readOnly={readOnly}
            onDeleted={() => navigate(`/spaces/${detail.spaceId}`, { replace: true })}
          />
        </>
      ) : null}

      {detail.state === 'processing' ? (
        <Alert variant="info">
          This source is still being processed. Its text appears here once it is ready.
        </Alert>
      ) : null}

      {detail.state === 'failed' ? (
        <Card>
          <p className="text-sm text-on-surface">
            {detail.errorMessage ?? 'This source could not be processed.'}
          </p>
          {readOnly ? null : (
            <Button
              className="mt-4"
              size="sm"
              disabled={retry.isPending}
              onClick={() => retry.mutate(detail.id)}
            >
              {retry.isPending ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </Card>
      ) : null}

      {target.unresolved ? (
        <Alert variant="info">
          The cited location is no longer available in this source — it may have been reprocessed
          since. The source itself is unchanged.
        </Alert>
      ) : null}

      {/* The location reads in one place: in the route's viewer toolbar, or as a
          line of copy in the assistant pane, which has no toolbar. */}
      {!showHeader && locationLabel ? (
        <p className="text-sm text-on-surface-variant">{locationLabel}</p>
      ) : null}

      {showHeader ? (
        // source_detail wireframe: a bordered viewer — a quiet toolbar bar over a
        // paper-white reading surface. The pane gets no chrome; it already sits
        // inside the assistant's own Card and scrolls there.
        <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-sm">
          {pager || locationLabel ? (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-outline-variant bg-surface-container-low px-5 py-2.5">
              {pager}
              {locationLabel ? (
                <p className="text-sm text-on-surface-variant">{locationLabel}</p>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-[24rem] px-6 py-10 sm:px-16 sm:py-16">{content}</div>
        </div>
      ) : (
        <>
          {pager}
          {content}
        </>
      )}
    </div>
  );
}
