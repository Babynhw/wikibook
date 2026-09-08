import { useState } from 'react';
import { ApiError, type Source } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { useUpdateSource } from '@/features/sources/use-sources';
import { useUi } from '@/lib/locale';

/**
 * PRD §7/§8: the title and the author or publisher. Those two fields and no
 * others — the extracted text is derived, and editing it would leave every
 * passage, embedding, and citation describing text the source no longer has.
 *
 * "Author or publisher" is one field because the PRD never separates them: a
 * paper has a byline, an article has a masthead, and both live here.
 */
export function EditSourceDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const [title, setTitle] = useState(source.title);
  const [author, setAuthor] = useState(source.author ?? '');
  const update = useUpdateSource(source.spaceId);
  const { text } = useUi();
  const error = update.error instanceof ApiError ? update.error : null;

  const submit = () => {
    // What the user typed survives a rejection (PRD §16): the state is not reset
    // here, so the dialog stays open with the values still in it.
    update.mutate({ id: source.id, title, author }, { onSuccess: onClose });
  };

  return (
    <Dialog open title={text.source.editDetails} onClose={onClose}>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label={text.common.title}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={error?.fields.title}
          required
        />
        <Field
          label={text.source.authorPublisher}
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          error={error?.fields.author}
          hint={text.source.noByline}
        />

        {error && Object.keys(error.fields).length === 0 ? <Alert>{error.message}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {text.common.cancel}
          </Button>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? text.common.saving : text.space.saveChanges}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
