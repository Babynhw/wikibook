import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, type ConversationListItem } from '@/lib/api';
import { useUi } from '@/lib/locale';

/**
 * Every conversation in a space, most recently updated first (PRD §9, REQ-169 /
 * REQ-170). A row is a link and nothing else: there is no rename, no delete and
 * no share (REQ-173, PRD §20), so there is no menu to hang off it.
 *
 * Threads with no messages are not shown. The hub creates a conversation only
 * when a question is submitted, so none are made from here on; the ones the old
 * "New conversation" button left behind stay in the database and reachable by
 * URL — hidden, not deleted (REQ-170).
 */
export function ConversationList({
  conversations,
  spaceId,
  isPending = false,
  error = null,
  archived = false,
  now = new Date(),
  locale,
}: {
  conversations: ConversationListItem[] | undefined;
  spaceId: string;
  isPending?: boolean;
  error?: unknown;
  /** True in an archived space: there is no composer above to point at. */
  archived?: boolean;
  /** Injected by tests so the date column is deterministic. */
  now?: Date;
  /** Injected by tests; the browser locale otherwise. */
  locale?: string;
}) {
  const { text } = useUi();
  if (isPending) {
    return (
      <div aria-busy="true" className="space-y-px" data-testid="conversation-list-loading">
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-2 border-b border-outline-variant px-3 py-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert>
        {error instanceof ApiError ? error.message : text.common.tryAgain}
      </Alert>
    );
  }

  const rows = (conversations ?? []).filter((conversation) => conversation.messageCount > 0);

  if (rows.length === 0) {
    return (
      <Card>
        <h2 className="text-base font-semibold text-on-surface">
          {archived ? text.activity.none : text.assistant.askSources}
        </h2>
        <p className="mt-2 text-sm text-on-surface-variant">
          {archived ? text.assistant.archived : text.assistant.askSourcesDescription}
        </p>
      </Card>
    );
  }

  return (
    <nav aria-label={text.assistant.askSources}>
      <ul className="divide-y divide-outline-variant">
        {rows.map((conversation) => (
          <li key={conversation.id}>
            <Link
              to={`/spaces/${spaceId}/assistant/${conversation.id}`}
              className="flex items-start justify-between gap-4 rounded-md px-3 py-4 hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-base font-semibold text-on-surface">
                    {conversation.title}
                  </span>
                  {/* REQ-171: the scope is visible on the assistant screen. */}
                  {conversation.scopeType === 'source' ? (
                    <span className="shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs font-medium text-on-secondary-container">
                      {text.nav.sources}
                    </span>
                  ) : null}
                </span>
                {conversation.preview ? (
                  <span className="mt-1 block truncate text-sm text-on-surface-variant">
                    {conversation.preview}
                  </span>
                ) : null}
              </span>
              <time
                dateTime={conversation.updatedAt}
                title={new Date(conversation.updatedAt).toLocaleString(locale)}
                className="shrink-0 pt-0.5 text-sm text-on-surface-variant"
              >
                {formatConversationDate(conversation.updatedAt, now, locale)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Today → the time; this year → `Jul 6`; otherwise `Jul 6, 2025`. Browser locale,
 * so a Vietnamese user sees `6 thg 7` rather than a hard-coded English form.
 */
export function formatConversationDate(
  iso: string,
  now: Date = new Date(),
  locale?: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
