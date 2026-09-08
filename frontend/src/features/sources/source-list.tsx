import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type Source, type SourceType } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SourceStateAnnouncer, SourceStateBadge } from '@/features/sources/source-state-badge';
import { DeleteSourceDialog } from '@/features/sources/delete-source-dialog';
import { EditSourceDialog } from '@/features/sources/edit-source-dialog';
import { ArchiveSourceDialog } from '@/features/sources/archive-source-dialog';
import { useRestoreSource, useRetrySource } from '@/features/sources/use-sources';
import { useCurrentUser } from '@/features/auth/use-auth';
import { useSpace } from '@/features/spaces/use-spaces';

const TYPE_LABEL: Record<SourceType, string> = {
  pdf: 'PDF',
  web: 'Web link',
  manual: 'Text',
};

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

/** The reader's URL. A citation is a link into this same address (PRD §8). */
export function readerPath(source: Pick<Source, 'id' | 'spaceId'>): string {
  return `/spaces/${source.spaceId}/sources/${source.id}`;
}

type Dialog = 'edit' | 'archive' | 'delete' | null;

/**
 * One source card. It shows title, kind, author, state, and the date added —
 * and nothing from PRD §7's must-not-display list: no passage or chunk counts,
 * no embeddings, no storage location, no similarity scores.
 */
function SourceCard({
  source,
  readOnly,
  newSince,
}: {
  source: Source;
  readOnly: boolean;
  newSince: string | null;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const retry = useRetrySource(source.spaceId);
  const restore = useRestoreSource(source.spaceId);
  const retryError = retry.error instanceof ApiError ? retry.error : null;
  const restoreError = restore.error instanceof ApiError ? restore.error : null;
  const archived = source.archivedAt !== null;
  // Delete is permanent, so it is the one act on shared material an editor may
  // only do to their own contribution; the owner may do it to anyone's
  // (shared-spaces-v1 "Three roles"). Both queries are already in the cache.
  const { data: me } = useCurrentUser();
  const { data: space } = useSpace(source.spaceId);
  const role = space?.myRole;
  const mine = source.addedBy != null && me != null && source.addedBy.id === me.id;
  const canDelete = role === 'owner' || (role === 'editor' && mine);
  // Someone else's addition since my previous visit — text, not a dot alone (§18).
  const isNew =
    newSince !== null && !mine && source.addedBy != null && source.createdAt > newSince;

  return (
    <Card className={archived ? 'border-dashed' : undefined}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 truncate text-base font-semibold text-on-surface">
          {/* The title is the way into the reader: §8's screen is a URL, so it is
              a link rather than a click handler. */}
          <Link to={readerPath(source)} className="hover:underline">
            {source.title}
          </Link>
        </h3>
        {/* Ready is the expected state, so it is not badged — a library of green
            ticks is noise, and §18 only requires the exceptions be legible. The
            announcer stays mounted, so reaching ready is still announced. */}
        {source.state === 'ready' ? null : <SourceStateBadge state={source.state} />}
        <SourceStateAnnouncer state={source.state} title={source.title} />
      </div>

      <p className="mt-2 font-mono text-xs text-outline">
        {TYPE_LABEL[source.type]}
        {source.author ? ` · ${source.author}` : ''} · added {formatDate(source.createdAt)}
        {source.addedBy ? ` by ${mine ? 'you' : source.addedBy.name}` : ''}
        {/* Archived is text, not a colour or a dashed border alone (PRD §18). */}
        {archived ? ' · archived' : ''}
        {isNew ? (
          <span className="ml-2 rounded bg-primary-container px-1.5 py-0.5 text-on-primary-container">
            New since your last visit
          </span>
        ) : null}
      </p>

      {archived ? (
        <p className="mt-2 text-sm text-on-surface-variant">
          Archived, so the assistant will not use it as evidence. Nothing was deleted.
        </p>
      ) : null}

      {source.state === 'failed' && source.errorMessage ? (
        <Alert className="mt-3">{source.errorMessage}</Alert>
      ) : null}
      {retryError ? <Alert className="mt-3">{retryError.message}</Alert> : null}
      {restoreError ? <Alert className="mt-3">{restoreError.message}</Alert> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {source.state === 'failed' && !readOnly ? (
          <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate(source.id)}>
            {retry.isPending ? 'Retrying…' : 'Retry'}
          </Button>
        ) : null}
        <Link
          to={readerPath(source)}
          className="inline-flex h-8 items-center px-3 text-sm text-primary underline"
        >
          Open
        </Link>
        {source.type === 'web' && source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center px-3 text-sm text-primary underline"
          >
            Open the original
          </a>
        ) : null}
        {source.type === 'pdf' ? (
          <a
            // Proxied through the API, never a presigned URL: ownership is a
            // per-request obligation (PRD §17).
            href={`/api/sources/${source.id}/file`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center px-3 text-sm text-primary underline"
          >
            Open the original
          </a>
        ) : null}
        {readOnly ? null : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDialog('edit')}>
              Edit details
            </Button>
            {archived ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={restore.isPending}
                onClick={() => restore.mutate(source.id)}
              >
                {restore.isPending ? 'Restoring…' : 'Restore'}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setDialog('archive')}>
                Archive
              </Button>
            )}
          </>
        )}
        {canDelete ? (
          <Button size="sm" variant="ghost" onClick={() => setDialog('delete')}>
            Delete
          </Button>
        ) : null}
      </div>

      {dialog === 'edit' ? (
        <EditSourceDialog source={source} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'archive' ? (
        <ArchiveSourceDialog source={source} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteSourceDialog source={source} onClose={() => setDialog(null)} />
      ) : null}
    </Card>
  );
}

/**
 * The space's source library, in the order the API returns: newest first, or
 * ranked when a search is active (title matches above content-only ones, PRD §7).
 * `readOnly` covers an archived space, where writes answer 409 but deleting
 * stays allowed — archiving must not be a trap.
 */
export function SourceList({
  sources,
  readOnly = false,
  newSince = null,
}: {
  sources: Source[];
  /** An archived space or a viewer: writes are withheld; delete follows its own rule. */
  readOnly?: boolean;
  /** My previous visit, for the "new since your last visit" marker. */
  newSince?: string | null;
}) {
  return (
    <ul className="grid gap-4">
      {sources.map((source) => (
        <li key={source.id}>
          <SourceCard source={source} readOnly={readOnly} newSince={newSince} />
        </li>
      ))}
    </ul>
  );
}
