import { useState } from 'react';
import { ApiError, type Note } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useConvertNoteToSource } from './use-notes';

export function ConvertNoteDialog({
  note,
  onClose,
  onConverted,
}: {
  note: Note;
  onClose: () => void;
  onConverted?: (sourceId: string) => void;
}) {
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
      title="Convert Note to Evidence Source"
      description="Create an independent manual evidence source snapshot from this note. Once processed, it will be eligible for assistant citation and retrieval."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error ? <Alert>{error.message}</Alert> : null}

        <Field label="Source Title" error={error?.fields.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            // No `autoFocus` — see create-note-dialog.tsx; `Dialog` focuses the first control.
          />
        </Field>

        <p className="text-sm text-on-surface-variant">
          You can customize the title of the new evidence source.
        </p>

        <div className="rounded-md border border-outline-variant bg-surface-container-low p-3 text-xs text-on-surface-variant space-y-1">
          <p className="font-medium text-on-surface">Snapshot & Provenance Guarantee (PRD §12):</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>The source and note remain completely independent records after conversion.</li>
            <li>
              The source will be labeled as originating from{' '}
              {note.originType === 'saved_answer' ? 'an AI-assisted note' : 'a user note'}.
            </li>
          </ul>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={convert.isPending || !title.trim()}>
            {convert.isPending ? 'Converting…' : 'Convert to source'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
