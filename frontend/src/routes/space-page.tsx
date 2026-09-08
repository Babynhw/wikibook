import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AppShell } from '@/components/app-shell';
import { SpaceRail } from '@/components/space-shell';
import { useOpenSpace, useRestoreSpace, useSpace } from '@/features/spaces/use-spaces';
import { useSpaceRole } from '@/features/spaces/use-space-role';
import { RoleBadge } from '@/features/spaces/role-badge';
import { AudienceCard } from '@/features/spaces/audience-card';
import { AddSourceDialog } from '@/features/sources/add-source-dialog';
import { SourceList } from '@/features/sources/source-list';
import { useSources } from '@/features/sources/use-sources';
import { useSourceEvents } from '@/features/sources/use-source-events';
import { useSourceSearch } from '@/features/sources/use-source-search';
import { SourceFilters } from '@/features/sources/source-filters';
import { useConversations } from '@/features/assistant/use-conversations';
import { useUi } from '@/lib/locale';

function EmptyRegion({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold text-on-surface">{title}</h2>
      <p className="mt-2 text-sm text-on-surface-variant">{children}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </Card>
  );
}

/**
 * The assistant's entry point on the space page (PRD §9). It names the most
 * recent conversation so returning to a thread is one click, rather than making
 * the user walk into the assistant to find out whether anything is there.
 */
function AssistantRegion({ spaceId }: { spaceId: string }) {
  const { text } = useUi();
  const conversations = useConversations(spaceId);
  const recent = conversations.data?.[0];

  return (
    <Card>
      <h2 className="text-base font-semibold text-on-surface">{text.nav.assistant}</h2>
      <p className="mt-2 text-sm text-on-surface-variant">
        {recent
          ? text.space.mostRecent.replace('{title}', recent.title)
          : text.space.noConversations}
      </p>
      <div className="mt-4">
        <Link
          to={`/spaces/${spaceId}/assistant`}
          className="inline-flex items-center rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm font-medium text-on-surface hover:bg-surface-container-low"
        >
          {text.space.openAssistant}
        </Link>
      </div>
    </Card>
  );
}

function NotesRegion({ spaceId, noteCount }: { spaceId: string; noteCount: number }) {
  const { text } = useUi();
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-on-surface">{text.nav.notes}</h2>
        {noteCount > 0 ? (
          <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs text-on-surface-variant">
            {noteCount}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-on-surface-variant">
        {noteCount > 0
          ? text.space.notesDescription
          : text.space.noNotesDescription}
      </p>
      <div className="mt-4">
        <Link
          to={`/spaces/${spaceId}/notes`}
          className="inline-flex items-center rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm font-medium text-on-surface hover:bg-surface-container-low"
        >
          {text.space.openNotes}
        </Link>
      </div>
    </Card>
  );
}

/**
 * The space's source library. It owns the event stream for the open space: one
 * `EventSource`, opened on mount and closed on unmount, patching cached sources
 * as they move through processing (design "Live updates").
 */
function SourceLibrary({
  spaceId,
  readOnly,
  newSince,
}: {
  spaceId: string;
  readOnly: boolean;
  /** My previous visit, so a source another member added since can say so. */
  newSince: string | null;
}) {
  const { text } = useUi();
  const [adding, setAdding] = useState(false);
  const search = useSourceSearch();
  const sources = useSources(spaceId, search.params);
  const { polling } = useSourceEvents(spaceId);
  const searching = search.hasQuery || search.filtered;

  const addAction = readOnly ? null : (
          <Button onClick={() => setAdding(true)}>{text.nav.addSource}</Button>
  );

  let body: ReactNode;
  if (sources.isPending) {
    body = (
      <Card>
        <h2 className="text-base font-semibold text-on-surface">{text.page.sourceLibrary}</h2>
        <p className="mt-2 text-sm text-on-surface-variant">{text.page.loadingSources}</p>
      </Card>
    );
  } else if (sources.isError) {
    body = (
      <Card>
        <h2 className="text-base font-semibold text-on-surface">{text.page.sourceLibrary}</h2>
        <Alert className="mt-3">
          {sources.error instanceof ApiError
            ? sources.error.message
            : text.space.loadSourcesFailed}
        </Alert>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => void sources.refetch()}>
            {text.common.tryAgain}
          </Button>
        </div>
      </Card>
    );
  }
  // An empty library is a §16 state, not a blank panel: the copy says what a
  // source is for before asking for one. It is *not* the no-results state — a
  // library with sources that this query did not match needs a way back, not an
  // invitation to add evidence that is already there.
  else if (sources.data.length === 0 && !searching) {
    body = (
      <EmptyRegion title={text.page.sourceLibrary} action={addAction}>
        {text.space.noSourcesYet}
      </EmptyRegion>
    );
  } else {
    body = (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-on-surface">{text.page.sourceLibrary}</h2>
        {addAction}
      </div>

      {polling ? (
        <p className="mt-2 text-xs text-outline">
          {text.space.liveUpdatesUnavailable}
        </p>
      ) : null}

      <SourceFilters search={search} resultCount={sources.data.length} />

      <div className="mt-4">
        {sources.data.length === 0 ? (
          <div>
            <p className="text-sm text-on-surface-variant">
              {search.hasQuery
                ? text.space.noMatchingSources.replace('{query}', search.input)
                : text.space.noFilteredSources}
            </p>
            <div className="mt-3 flex gap-2">
              {/* §7 asks for one or the other; which one depends on what is
                  actually applied, so both exist and only the apt one renders. */}
              {search.filtered ? (
                <Button size="sm" variant="secondary" onClick={search.clearAll}>
                  {text.space.clearFilters}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={search.clearQuery}>
                  {text.space.clearSearch}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <SourceList sources={sources.data} readOnly={readOnly} newSince={newSince} />
        )}
      </div>
    </Card>
    );
  }

  // The dialog is rendered at one tree position for every branch. When the
  // first source lands, the refetched list flips the empty branch to the Card;
  // a dialog rendered inside each branch would remount there, lose its
  // mutation's `onSuccess: onClose`, and stay open, blank, over the new list.
  return (
    <>
      {body}
      {adding ? <AddSourceDialog spaceId={spaceId} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/**
 * The workspace shell. PRD §4's space view: the source library (Phase 2), and
 * the conversation area, note collection, and notebook that each later phase
 * fills in, plus the prompt that evidence is needed before the assistant can
 * answer.
 */
export function SpacePage() {
  const { text } = useUi();
  const { id = '' } = useParams();
  const space = useSpace(id);
  const open = useOpenSpace();
  const restore = useRestoreSpace();
  const opened = useRef<string | null>(null);
  // The visit before this one, captured before `open` stamps a new one, so the
  // "new since your last visit" marker measures against the right moment.
  const [newSince, setNewSince] = useState<string | null>(null);

  const permissions = useSpaceRole(space.data);
  const archived = permissions.archived;

  useEffect(() => {
    // Stamp last-opened once per space, and never for an archived one — the API
    // answers 409 there, and an archived space is not "opened" (PRD §4). The ref
    // is claimed before the call so a re-render cannot double-stamp; recovering
    // from a transient failure is `useOpenSpace`'s retry, not a second effect.
    if (!space.data || archived || opened.current === space.data.id) return;
    opened.current = space.data.id;
    setNewSince(space.data.lastOpenedAt);
    open.mutate(space.data.id);
  }, [space.data, archived, open]);

  if (space.isPending) {
    return (
      <AppShell>
        <p className="text-sm text-on-surface-variant">{text.page.loadingSpace}</p>
      </AppShell>
    );
  }

  if (space.isError) {
    const notFound = space.error instanceof ApiError && space.error.status === 404;
    return (
      <AppShell>
        <h1 className="text-2xl font-semibold tracking-tight text-on-surface">
          {notFound ? text.space.notFound : text.space.loadFailed}
        </h1>
        <p className="mt-2 max-w-prose text-on-surface-variant">
          {notFound
            ? text.space.missingDescription
            : space.error instanceof ApiError
              ? space.error.message
              : text.space.pleaseTryAgain}
        </p>
        <div className="mt-6 flex gap-2">
          <Link to="/" className="text-primary underline">
            {text.space.backToSpaces}
          </Link>
          {notFound ? null : (
            <button type="button" className="underline" onClick={() => space.refetch()}>
              {text.common.tryAgain}
            </button>
          )}
        </div>
      </AppShell>
    );
  }

  return (
    // Only the success branch gets the rail: naming a space we failed to load
    // would be worse than no rail, and the error branch's "Back to your spaces"
    // is already the right way out.
    <AppShell rail={<SpaceRail spaceId={space.data.id} space={space.data} />}>
      {archived ? (
        <>
          <Alert variant="info" className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <span>
              {text.space.archivedNotice}
              {permissions.isOwner ? '' : text.space.ownerRestoreNotice}
            </span>
            {permissions.isOwner ? (
              <Button
                size="sm"
                disabled={restore.isPending}
                onClick={() => restore.mutate(space.data.id)}
              >
                {restore.isPending ? text.space.restoring : text.space.restore}
              </Button>
            ) : null}
          </Alert>
          {/* Restore is the one action here with no dialog to report into. */}
          {restore.error instanceof ApiError ? (
            <Alert className="mb-6">{restore.error.message}</Alert>
          ) : null}
        </>
      ) : null}

      <h1 className="text-3xl font-semibold tracking-tight text-on-surface">{space.data.name}</h1>
      {space.data.objective ? (
        <p className="mt-2 max-w-prose text-on-surface-variant">{space.data.objective}</p>
      ) : null}
      {/* Shared spaces v1: who else is here and what I may do, in one line. */}
      {space.data.memberCount > 1 || space.data.myRole !== 'owner' ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs text-outline">
          <RoleBadge role={space.data.myRole} />
          <span>
            {space.data.memberCount} {space.data.memberCount === 1 ? text.space.member : text.space.members}
            {space.data.myRole === 'owner' ? '' : ` · ${text.space.ownedBy} ${space.data.ownerName}`}
          </span>
          <Link to={`/spaces/${space.data.id}/members`} className="text-primary underline">
            {text.space.membersLink}
          </Link>
        </p>
      ) : null}
      {permissions.isViewer && !archived ? (
        <Alert variant="info" className="mt-4 max-w-prose">
          {text.space.viewerNotice.replace('{name}', space.data.ownerName)}
        </Alert>
      ) : null}

      <Alert variant="info" className="mt-6 max-w-prose">
        {text.space.evidenceNotice}
      </Alert>

      {/* Settings, not a workspace region, so it sits above the grid rather than
          becoming a fifth card among the four the space page is about. The
          wrapper is inside the card, not around it: `AudienceCard` renders null
          for a member who can neither set nor read a note, and a wrapper here
          would leave that member a stray margin on every such space. */}
      <AudienceCard space={space.data} />

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <SourceLibrary spaceId={space.data.id} readOnly={!permissions.canEdit} newSince={newSince} />

        <AssistantRegion spaceId={space.data.id} />

        <NotesRegion spaceId={space.data.id} noteCount={space.data.noteCount} />

        <EmptyRegion title={text.nav.notebook}>{text.space.notebookDescription}</EmptyRegion>
      </div>
    </AppShell>
  );
}
