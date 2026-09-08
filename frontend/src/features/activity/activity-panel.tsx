import { Link } from 'react-router-dom';
import { ApiError, type ActivityItem } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';
import { useActivity } from '@/features/activity/use-activity';
import { useUi } from '@/lib/locale';

const HEADING_ID = 'activity-heading';

/**
 * Recent activity across all of the user's spaces (PRD §15): newest first, one
 * link per entry to the thing it names, "Load more" while the server has a
 * cursor. Its loading, empty, and error states are its own — a failed feed
 * never takes the space list down with it.
 */
export function ActivityPanel({
  spaceId,
  heading = 'Recent activity',
}: {
  /** Set for a space's feed: every member's actions, each row naming who (shared-spaces-v1). */
  spaceId?: string;
  heading?: string;
} = {}) {
  const query = useActivity(spaceId);
  const { text } = useUi();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const withActor = spaceId !== undefined;

  return (
    <section aria-labelledby={HEADING_ID}>
      <Card>
        <h2 id={HEADING_ID} className="text-lg font-semibold text-on-surface">
          {heading}
        </h2>

        {query.isPending ? (
          <p role="status" className="mt-2 text-sm text-on-surface-variant">
            {text.activity.loading}
          </p>
        ) : query.isError ? (
          <Alert className="mt-2">
            {query.error instanceof ApiError ? query.error.message : text.common.tryAgain}{' '}
            <button type="button" onClick={() => query.refetch()} className="underline">
              {text.common.tryAgain}
            </button>
          </Alert>
        ) : items.length === 0 ? (
          <p className="mt-2 max-w-prose text-sm text-on-surface-variant">
            {text.activity.none}
          </p>
        ) : (
          <>
            {/* Beside the list (≥ lg) the feed scrolls inside its own column so it
                never pushes the page taller than the spaces do; stacked below
                the list it simply flows. */}
            <ol className="mt-3 divide-y divide-outline-variant lg:max-h-[28rem] lg:overflow-y-auto lg:pr-1">
              {items.map((item) => (
                <ActivityRow key={item.id} item={item} withActor={withActor} />
              ))}
            </ol>
            {query.hasNextPage ? (
              <Button
                variant="ghost"
                className="mt-3 w-full"
                disabled={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? text.activity.loading : text.activity.loadMore}
              </Button>
            ) : null}
          </>
        )}
      </Card>
    </section>
  );
}

function ActivityRow({ item, withActor }: { item: ActivityItem; withActor: boolean }) {
  const { verb, gone } = describe(item);
  // In a space's feed the actor leads the line; on Home every row is mine, so
  // the verb stands alone — except a membership event, which names who did it.
  const actor = withActor || item.kind.startsWith('member.') || item.kind === 'space.ownership_transferred'
    ? item.actor?.name ?? 'A former member'
    : null;
  const body = (
    <>
      <span className={`block text-sm ${gone ? 'text-on-surface-variant' : 'text-on-surface'}`}>
        {actor ? `${actor} · ` : ''}
        {verb}
      </span>
      <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-on-surface-variant">
        {item.space && !withActor ? <span className="truncate">in {item.space.name}</span> : null}
        <RelativeTime iso={item.createdAt} className="font-mono text-outline" />
      </span>
    </>
  );

  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      {item.href ? (
        <Link to={item.href} className="block min-w-0 rounded hover:bg-surface-container-low focus-visible:outline">
          {body}
        </Link>
      ) : (
        <div className="min-w-0">{body}</div>
      )}
    </li>
  );
}

const GONE = 'an item that has since been deleted';

/** Plain-language line per kind; a missing target reads as such instead of vanishing. */
function describe(item: ActivityItem): { verb: string; gone: boolean } {
  const gone =
    item.target === null &&
    item.kind !== 'note.deleted' &&
    item.kind !== 'notebook.exported' &&
    item.kind !== 'space.audience_changed' &&
    !item.kind.startsWith('member.') &&
    item.kind !== 'space.ownership_transferred';
  const name = item.target ? `“${item.target.title}”` : GONE;
  switch (item.kind) {
    case 'space.created':
      return { verb: item.target ? `Created space ${name}` : 'Created a space that has since been deleted', gone };
    case 'source.added':
      return { verb: `Added source ${name}`, gone };
    case 'source.ready':
      return { verb: `Finished processing ${name}`, gone };
    case 'source.failed':
      return { verb: `Processing failed for ${name}`, gone };
    case 'note.saved_answer':
      return { verb: `Saved an answer as note ${name}`, gone };
    case 'note.created':
      return { verb: `Created note ${name}`, gone };
    case 'note.edited':
      return { verb: `Edited note ${name}`, gone };
    case 'note.converted':
      return { verb: `Converted note ${name} into a source`, gone };
    case 'note.deleted':
      return { verb: 'Deleted a note', gone: false };
    case 'notebook.exported':
      return { verb: 'Exported the notebook', gone: false };
    case 'member.invited':
      return { verb: item.target ? `Invited ${item.target.title}` : 'Sent an invite', gone: false };
    case 'member.joined':
      return { verb: 'Joined the space', gone: false };
    case 'member.removed':
      return { verb: item.target ? `Removed ${item.target.title}` : 'Removed a member', gone: false };
    case 'member.left':
      return { verb: 'Left the space', gone: false };
    case 'member.role_changed':
      return { verb: item.target ? `Changed ${item.target.title}’s role` : 'Changed a member’s role', gone: false };
    case 'space.audience_changed':
      return { verb: 'Changed who this space’s answers are written for', gone: false };
    case 'space.ownership_transferred':
      return { verb: item.target ? `Made ${item.target.title} the owner` : 'Transferred ownership', gone: false };
    default:
      // The type says this cannot happen; the wire says `string`, so a kind
      // added on the server before the client ships still renders something.
      return { verb: 'Activity', gone };
  }
}
