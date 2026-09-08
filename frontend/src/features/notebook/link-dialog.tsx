import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { isSafeHref } from './extensions';
import { useUi } from '@/lib/locale';

/**
 * The link control's dialog — the hand-written `Dialog` with a real label,
 * because `window.prompt` is a browser modal the tools cannot dismiss and a
 * §18 failure. Only http(s) and mailto are accepted, matching the server.
 */
export function LinkDialog({
  open,
  initialHref,
  onClose,
  onApply,
  onRemove,
}: {
  open: boolean;
  initialHref: string;
  onClose: () => void;
  onApply: (href: string) => void;
  onRemove: () => void;
}) {
  const { text } = useUi();
  const [href, setHref] = useState(initialHref);
  const [error, setError] = useState<string | undefined>();

  const submit = () => {
    const value = href.trim();
    if (!isSafeHref(value)) {
      setError(text.source.httpOnly);
      return;
    }
    onApply(value);
  };

  return (
    <Dialog open={open} title={initialHref ? text.notebook.link : text.notebook.insertLink} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label={text.notebook.linkUrl}
          type="url"
          value={href}
          onChange={(event) => {
            setHref(event.target.value);
            setError(undefined);
          }}
          placeholder="https://"
          error={error}
          // No `autoFocus` — it pre-empts `Dialog`'s focus bookkeeping and the
          // toolbar's Link button would not get focus back on close.
        />
        <div className="flex flex-wrap justify-end gap-2">
          {initialHref ? (
            <Button type="button" variant="ghost" onClick={onRemove}>
              {text.notebook.removeLink}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            {text.common.cancel}
          </Button>
          <Button type="submit">{text.notebook.insertLink}</Button>
        </div>
      </form>
    </Dialog>
  );
}
