import { ApiError, type Note } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useDeleteNote } from './use-notes';

export function DeleteNoteDialog({
  note,
  onClose,
  onDeleted,
}: {
  note: Note;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteNote(note.spaceId);
  const error = remove.error instanceof ApiError ? remove.error : null;

  return (
    <Dialog
      open
      title={`Delete “${note.title}”?`}
      description="Are you sure you want to delete this note? This action cannot be undone. If this note was already converted to a source, the converted source will remain unaffected."
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
            remove.mutate(note.id, {
              onSuccess: () => {
                onClose();
                onDeleted?.();
              },
            })
          }
        >
          {remove.isPending ? 'Deleting…' : 'Delete note'}
        </Button>
      </div>
    </Dialog>
  );
}
