import { useState } from 'react';
import { ApiError, type Space } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, TextareaField } from '@/components/ui/field';

interface SpaceDialogProps {
  title: string;
  description?: string;
  submitLabel: string;
  /** Prefilled when editing; absent when creating. */
  space?: Space;
  pending: boolean;
  error: unknown;
  onSubmit: (input: { name: string; objective: string }) => void;
  onClose: () => void;
}

/**
 * Create and rename share one dialog: PRD §4 gives both the same two fields
 * (name required, research objective optional but prompted).
 *
 * Mount it conditionally — the parent renders it only while it is open, so each
 * opening starts from the space's current values rather than stale input.
 */
export function SpaceDialog({
  title,
  description,
  submitLabel,
  space,
  pending,
  error,
  onSubmit,
  onClose,
}: SpaceDialogProps) {
  // Controlled: a failed submit keeps what the user typed (PRD §16).
  const [name, setName] = useState(space?.name ?? '');
  const [objective, setObjective] = useState(space?.objective ?? '');

  const apiError = error instanceof ApiError ? error : null;

  return (
    <Dialog open title={title} description={description} onClose={onClose}>
      <form
        noValidate
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name, objective });
        }}
      >
        {apiError ? <Alert>{apiError.message}</Alert> : null}

        <Field
          label="Name"
          name="name"
          value={name}
          autoComplete="off"
          error={apiError?.fields.name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextareaField
          label="Research objective"
          name="objective"
          rows={3}
          value={objective}
          hint="Optional. What are you trying to find out?"
          error={apiError?.fields.objective}
          onChange={(event) => setObjective(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
