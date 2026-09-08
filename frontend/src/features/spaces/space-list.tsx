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

function RenameDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  const update = useUpdateSpace(space.id);

  return (
    <SpaceDialog
      title="Space details"
      submitLabel="Save changes"
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
  const error = archive.error instanceof ApiError ? archive.error : null;

  return (
    <Dialog
      open
      title={`Archive “${space.name}”?`}
      description="Its sources, notes, conversations, and notebook are kept. Restore the space at any time to pick up where you left off."
      onClose={onClose}
    >
      {error ? <Alert className="mt-4">{error.message}</Alert> : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={archive.isPending}
          onClick={() => archive.mutate(space.id, { onSuccess: onClose })}
        >
          {archive.isPending ? 'Archiving…' : 'Archive space'}
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

  return (
    <Card className={resume ? 'border-primary' : undefined}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {resume ? (
            <p className="font-mono text-xs tracking-widest text-primary uppercase">Resume</p>
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
        {space.sourceCount} {space.sourceCount === 1 ? 'source' : 'sources'} · {space.noteCount}{' '}
        {space.noteCount === 1 ? 'note' : 'notes'} · updated <RelativeTime iso={space.updatedAt} />
      </p>
      {shared ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs text-outline">
          <RoleBadge role={space.myRole} />
          <span>
            {space.memberCount} {space.memberCount === 1 ? 'member' : 'members'}
            {isOwner ? '' : ` · owned by ${space.ownerName}`}
          </span>
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {archived ? (
          isOwner ? (
            <Button size="sm" disabled={restore.isPending} onClick={() => restore.mutate(space.id)}>
              {restore.isPending ? 'Restoring…' : 'Restore'}
            </Button>
          ) : (
            <span className="text-xs text-on-surface-variant">Archived by the owner.</span>
          )
        ) : (
          <>
            <Link to={`/spaces/${space.id}`} className={buttonVariants({ size: 'sm' })}>
              Open
            </Link>
            {canEdit ? (
              <Button size="sm" variant="secondary" onClick={() => setDialog('rename')}>
                Edit details
              </Button>
            ) : null}
            {isOwner ? (
              <Button size="sm" variant="ghost" onClick={() => setDialog('archive')}>
                Archive
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
