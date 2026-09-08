import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { isSafeHref } from './extensions';

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
  const [href, setHref] = useState(initialHref);
  const [error, setError] = useState<string | undefined>();

  const submit = () => {
    const value = href.trim();
    if (!isSafeHref(value)) {
      setError('Enter a full web address that starts with http://, https://, or mailto:.');
      return;
    }
    onApply(value);
  };

  return (
    <Dialog open={open} title={initialHref ? 'Edit link' : 'Add link'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Link address"
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
              Remove link
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Apply</Button>
        </div>
      </form>
    </Dialog>
  );
}
