import { ApiError, type Source } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useDeleteSource } from '@/features/sources/use-sources';

/**
 * Deleting a source is permanent and takes its answers' citations with it, so it
 * is confirmed rather than undoable (PRD §6). Archiving a space is the reversible
 * option; this one is not.
 */
export function DeleteSourceDialog({
  source,
  onClose,
  onDeleted,
}: {
  source: Source;
  onClose: () => void;
  /** The reader passes this to leave the page: there is nothing left to read. */
  onDeleted?: () => void;
}) {
  const remove = useDeleteSource(source.spaceId);
  const error = remove.error instanceof ApiError ? remove.error : null;

  return (
    <Dialog
      open
      title={`Delete “${source.title}”?`}
      description="This cannot be undone. The stored file, its passages, and any citations pointing at them are removed with it."
      onClose={onClose}
    >
      {error ? <Alert className="mt-4">{error.message}</Alert> : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(source.id, {
              onSuccess: () => {
                onClose();
                onDeleted?.();
              },
            })
          }
        >
          {remove.isPending ? 'Deleting…' : 'Delete source'}
        </Button>
      </div>
    </Dialog>
  );
}
