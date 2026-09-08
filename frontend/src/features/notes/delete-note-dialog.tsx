import { ApiError, type Note } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useDeleteNote } from './use-notes';
import { useUi } from '@/lib/locale';

export function DeleteNoteDialog({
  note,
  onClose,
  onDeleted,
}: {
  note: Note;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { text } = useUi();
  const remove = useDeleteNote(note.spaceId);
  const error = remove.error instanceof ApiError ? remove.error : null;

  return (
    <Dialog
      open
      title={`${text.notes.deleteNote} “${note.title}”?`}
      description={text.notes.deleteDescription}
      onClose={onClose}
    >
      {error ? <Alert className="mt-4">{error.message}</Alert> : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {text.notes.cancel}
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
          {remove.isPending ? text.notes.deleting : text.notes.deleteNote}
        </Button>
      </div>
    </Dialog>
  );
}
