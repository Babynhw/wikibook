import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type Space } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { SpaceDialog } from '@/features/spaces/space-dialog';
import { useArchiveSpace, useRestoreSpace, useUpdateSpace } from '@/features/spaces/use-spaces';
import { RelativeTime } from '@/components/relative-time';
import { RoleBadge } from '@/features/spaces/role-badge';
import { useUi } from '@/lib/locale';

function RenameDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  const update = useUpdateSpace(space.id);
  const { text } = useUi();

  return (
    <SpaceDialog
      title={text.space.details}
      submitLabel={text.space.saveChanges}
      space={space}
      pending={update.isPending}
      error={update.error}
      onClose={onClose}
      onSubmit={({ name, objective }) =>
        update.mutate({ name, objective }, { onSuccess: onClose })
      }
    />
  );
}

function ArchiveDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  const archive = useArchiveSpace();
  const { text } = useUi();
  const error = archive.error instanceof ApiError ? archive.error : null;

  return (
    <Dialog
      open
      title={text.space.archiveQuestion.replace('{name}', space.name)}
      description={text.space.archiveDescription}
      onClose={onClose}
    >
      {error ? <Alert className="mt-4">{error.message}</Alert> : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {text.common.cancel}
        </Button>
        <Button
          disabled={archive.isPending}
          onClick={() => archive.mutate(space.id, { onSuccess: onClose })}
        >
          {archive.isPending ? text.common.archiving : text.space.archiveSpace}
        </Button>
      </div>
    </Dialog>
  );
}

function SpaceCard({ space, resume }: { space: Space; resume: boolean }) {
  const [dialog, setDialog] = useState<'rename' | 'archive' | null>(null);
  const restore = useRestoreSpace();
  const archived = space.archivedAt !== null;
  const restoreError = restore.error instanceof ApiError ? restore.error : null;
  const shared = space.myRole !== 'owner' || space.memberCount > 1;
  const isOwner = space.myRole === 'owner';
  const canEdit = space.myRole !== 'viewer';
  const { text } = useUi();

  return (
    <Card className={resume ? 'border-primary' : undefined}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {resume ? (
            <p className="font-mono text-xs tracking-widest text-primary uppercase">{text.space.resume}</p>
          ) : null}
          {/* h2: the page's h1 is the welcome line and nothing sits between (axe heading-order). */}
          <h2 className="truncate text-lg font-semibold text-on-surface">
            {archived ? (
              space.name
            ) : (
              <Link to={`/spaces/${space.id}`} className="hover:underline">
                {space.name}
              </Link>
            )}
          </h2>
          {space.objective ? (
            <p className="mt-1 line-clamp-2 text-sm text-on-surface-variant">{space.objective}</p>
          ) : null}
        </div>
      </div>

      <p className="mt-4 font-mono text-xs text-outline">
        {space.sourceCount} {space.sourceCount === 1 ? text.common.source : text.common.sources} · {space.noteCount}{' '}
        {space.noteCount === 1 ? text.common.note : text.common.notes} · <RelativeTime iso={space.updatedAt} />
      </p>
      {shared ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs text-outline">
          <RoleBadge role={space.myRole} />
          <span>
            {space.memberCount} {space.memberCount === 1 ? text.common.member : text.common.members}
            {isOwner ? '' : ` · ${text.space.ownedBy} ${space.ownerName}`}
          </span>
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {archived ? (
          isOwner ? (
            <Button size="sm" disabled={restore.isPending} onClick={() => restore.mutate(space.id)}>
              {restore.isPending ? text.common.restoring : text.common.restore}
            </Button>
          ) : (
            <span className="text-xs text-on-surface-variant">{text.space.archivedByOwner}</span>
          )
        ) : (
          <>
            <Link to={`/spaces/${space.id}`} className={buttonVariants({ size: 'sm' })}>
              {text.common.open}
            </Link>
            {canEdit ? (
              <Button size="sm" variant="secondary" onClick={() => setDialog('rename')}>
                {text.common.editDetails}
              </Button>
            ) : null}
            {isOwner ? (
              <Button size="sm" variant="ghost" onClick={() => setDialog('archive')}>
                {text.common.archive}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {/* A failed restore has no dialog to fall back on, so it reports here. */}
      {restoreError ? <Alert className="mt-4">{restoreError.message}</Alert> : null}

      {dialog === 'rename' ? (
        <RenameDialog space={space} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'archive' ? (
        <ArchiveDialog space={space} onClose={() => setDialog(null)} />
      ) : null}
    </Card>
  );
}

/**
 * Active spaces arrive most-recently-opened first (PRD §4); the first one is
 * marked as the space to resume (PRD §3) rather than redirected to, so the list
 * and the create action stay reachable.
 */
export function SpaceList({ spaces }: { spaces: Space[] }) {
  const resumeId = spaces.find((space) => space.lastOpenedAt !== null && !space.archivedAt)?.id;

  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {spaces.map((space) => (
        <li key={space.id}>
          <SpaceCard space={space} resume={space.id === resumeId} />
        </li>
      ))}
    </ul>
  );
}
