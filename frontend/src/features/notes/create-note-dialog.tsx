import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useCreateNote } from './use-notes';
import { useUi } from '@/lib/locale';

export function CreateNoteDialog({
  spaceId,
  onClose,
  onCreated,
}: {
  spaceId: string;
  onClose: () => void;
  onCreated?: (noteId: string) => void;
}) {
  const { text } = useUi();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const create = useCreateNote(spaceId);
  const error = create.error instanceof ApiError ? create.error : null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;

    create.mutate(
      {
        title: title.trim(),
        contentRich: content.trim()
          ? {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: content.trim() }],
                },
              ],
            }
          : undefined,
      },
      {
        onSuccess: (data) => {
          onClose();
          onCreated?.(data.note.id);
        },
      },
    );
  };

  return (
    <Dialog
      open
      title={text.notes.newNoteTitle}
      description={text.notes.newNoteDescription}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error ? <Alert>{error.message}</Alert> : null}

        <Field label={text.notes.titleLabel} error={error?.fields.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={text.page.noteTitlePlaceholder}
            // No `autoFocus`: it runs before `Dialog` records the opener, which
            // then could not get focus back on close. `Dialog` focuses this anyway.
            required
            maxLength={200}
          />
        </Field>

        <Field label={text.notes.contentOptional}>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={text.page.noteContentPlaceholder}
            rows={5}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {text.notes.cancel}
          </Button>
          <Button type="submit" disabled={create.isPending || !title.trim()}>
            {create.isPending ? text.notes.creating : text.notes.created}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
