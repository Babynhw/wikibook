import { ApiError, type Source } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useArchiveSource } from '@/features/sources/use-sources';

/**
 * Archiving withdraws a source from the assistant's evidence without deleting
 * anything (PRD §7). It is confirmed — not because it is destructive, but because
 * its effect is invisible from the library: answers stop being able to cite the
 * source, and that is worth saying out loud before it happens.
 *
 * Restoring needs no confirmation, so it has no dialog.
 */
export function ArchiveSourceDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const archive = useArchiveSource(source.spaceId);
  const error = archive.error instanceof ApiError ? archive.error : null;

  return (
    <Dialog
      open
      title={`Archive “${source.title}”?`}
      description="It stays in this space and nothing is deleted, but the assistant will stop using it as evidence. You can restore it at any time from Show archived."
      onClose={onClose}
    >
      {error ? <Alert className="mt-4">{error.message}</Alert> : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={archive.isPending}
          onClick={() => archive.mutate(source.id, { onSuccess: onClose })}
        >
          {archive.isPending ? 'Archiving…' : 'Archive source'}
        </Button>
      </div>
    </Dialog>
  );
}
