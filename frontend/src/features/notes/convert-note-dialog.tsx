import { useState } from 'react';
import { ApiError, type Note } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useConvertNoteToSource } from './use-notes';
import { useUi } from '@/lib/locale';

export function ConvertNoteDialog({
  note,
  onClose,
  onConverted,
}: {
  note: Note;
  onClose: () => void;
  onConverted?: (sourceId: string) => void;
}) {
  const { text } = useUi();
  const [title, setTitle] = useState(note.title);
  const convert = useConvertNoteToSource(note.spaceId);
  const error = convert.error instanceof ApiError ? convert.error : null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;

    convert.mutate(
      {
        id: note.id,
        input: { title: title.trim() },
      },
      {
        onSuccess: (data) => {
          onClose();
          onConverted?.(data.source.id);
        },
      },
    );
  };

  return (
    <Dialog
      open
      title={text.notes.convertTitle}
      description={text.notes.convertDescription}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error ? <Alert>{error.message}</Alert> : null}

        <Field label={text.notes.sourceTitle} error={error?.fields.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            // No `autoFocus` — see create-note-dialog.tsx; `Dialog` focuses the first control.
          />
        </Field>

        <p className="text-sm text-on-surface-variant">
          {text.notes.customizeTitle}
        </p>

        <div className="rounded-md border border-outline-variant bg-surface-container-low p-3 text-xs text-on-surface-variant space-y-1">
          <p className="font-medium text-on-surface">{text.notes.snapshotGuarantee}</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>{text.notes.independentRecords}</li>
            <li>
              {text.notes.originatingFrom}{' '}
              {note.originType === 'saved_answer' ? text.notes.aiNote : text.notes.userNoteOrigin}.
            </li>
          </ul>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {text.notes.cancel}
          </Button>
          <Button type="submit" disabled={convert.isPending || !title.trim()}>
            {convert.isPending ? text.notes.converting : text.notes.convertToSource}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
