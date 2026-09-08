import { useParams, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { SpaceRail } from '@/components/space-shell';
import { useSpace } from '@/features/spaces/use-spaces';
import { canEditSpace } from '@/features/spaces/use-space-role';
import { SourceReader, type ReaderLink } from '@/features/reader/source-reader';
import { useUi } from '@/lib/locale';

/**
 * The reader's route — and the citation contract (PRD §8):
 *
 *   /spaces/:spaceId/sources/:sourceId?passage=<id>&page=7&para=p12&from=<path>
 *
 * `passage` is the exact target and wins over `page`/`para`; `from` is the path
 * the "back" control returns to. Phase 4 adds `?cite=<citationId>`, which resolves
 * through `GET /citations/:id/target` into this same URL.
 *
 * Layout follows the `source_detail` wireframe: a breadcrumb names where the
 * source lives (a source belongs to a space), and the reader draws itself — the
 * document header and the bordered viewer with its toolbar — below it.
 */
export function SourcePage() {
  const { text } = useUi();
  const { spaceId = '', id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const space = useSpace(spaceId);

  const page = Number(searchParams.get('page'));
  const link: ReaderLink = {
    ...(searchParams.get('passage') ? { passageId: searchParams.get('passage')! } : {}),
    ...(Number.isFinite(page) && page > 0 ? { page } : {}),
    ...(searchParams.get('para') ? { paragraphRef: searchParams.get('para')! } : {}),
    ...(searchParams.get('from') ? { from: searchParams.get('from')! } : {}),
  };

  return (
    // The reader keeps the rail on purpose: a citation deep-link drops the user
    // into a source, and without it the only way back to the space is the
    // `?from=` control, which is only there when a citation put them here.
    <AppShell rail={<SpaceRail spaceId={spaceId} space={space.data} />}>
      {/* source_detail wireframe: "← Library / Project Alpha". The breadcrumb is the
          page's top line and the only way back up — the source lives inside a space,
          so the trail names both, with "Library" being the across-spaces listing.
          `aria-current` marks the space this source belongs to. */}
      <nav
        aria-label={text.page.breadcrumb}
        className="mb-6 flex flex-wrap items-center gap-2 text-sm text-on-surface-variant"
      >
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Library
        </Link>
        <span className="text-outline-variant" aria-hidden="true">
          /
        </span>
        <Link
          to={`/spaces/${spaceId}`}
          aria-current="page"
          className="inline-flex max-w-[16rem] items-center truncate hover:text-primary hover:underline"
        >
          {space.data?.name ?? 'Space'}
        </Link>
      </nav>

      {/* An archived space is read-only, so the reader hides its write actions —
          the API would answer 409 (REQ-100), and reading stays allowed. */}
      {/* Read-only for a viewer too: the reader's write actions answer 403 for them. */}
      <SourceReader sourceId={id} link={link} readOnly={!canEditSpace(space.data)} />
    </AppShell>
  );
}
