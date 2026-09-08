import { useEffect, useState } from 'react';
import { ApiError, type Space } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextareaField } from '@/components/ui/field';
import { useSetSpaceAudience } from './use-spaces';
import { useSpaceRole } from './use-space-role';
import { useUi } from '@/lib/locale';

/**
 * The space's "Audience & style" note (wiki-docs/plan/space-audience-style).
 *
 * Who the assistant's answers are written for, and in what register. The owner
 * writes it; **every** role reads it, because a member should be able to see what
 * is shaping the answers they are given rather than have the voice change under
 * them.
 *
 * The line about what it does *not* do is not decoration. This field shapes how
 * the assistant writes; it does not restrict what anyone can read, since every
 * member can open every source in the reader, the notebook, and the export. Left
 * unsaid, an owner would reasonably read it as a content control and invite
 * people on that basis.
 *
 * Renders nothing at all when there is no note and the reader cannot set one —
 * an empty labelled box on every space that never uses this would be a permanent
 * invitation to fill it in.
 */
export function AudienceCard({ space }: { space: Space }) {
  const { text } = useUi();
  const { isOwner, archived } = useSpaceRole(space);
  const editable = isOwner && !archived;
  const setAudience = useSetSpaceAudience(space.id);

  const [draft, setDraft] = useState(space.audienceInstruction ?? '');
  // The mutation writes the space into the cache, so the saved value arrives as
  // a prop; a note changed in another tab should not be shadowed by stale input.
  useEffect(() => {
    setDraft(space.audienceInstruction ?? '');
  }, [space.audienceInstruction]);

  if (!editable) {
    if (!space.audienceInstruction) return null;
    return (
      <Card className="mt-6">
        <h2 className="text-base font-semibold text-on-surface">{text.space.audienceStyle}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-on-surface-variant">
          {space.audienceInstruction}
        </p>
        <p className="mt-2 text-xs text-outline">
          {text.space.setByOwner}
        </p>
      </Card>
    );
  }

  const max = space.audienceInstructionMaxChars;
  const apiError = setAudience.error instanceof ApiError ? setAudience.error : null;
  const dirty = draft.trim() !== (space.audienceInstruction ?? '');
  const overCap = draft.trim().length > max;

  return (
    <Card className="mt-6">
      <h2 className="text-base font-semibold text-on-surface">{text.space.audienceStyle}</h2>
      <form
        className="mt-3 flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          setAudience.mutate(trimmed.length === 0 ? null : trimmed);
        }}
      >
        {apiError && !apiError.fields.audience ? <Alert>{apiError.message}</Alert> : null}

        <TextareaField
          label={text.space.audienceLabel}
          name="audience"
          rows={3}
          value={draft}
          hint={text.space.audienceHint}
          error={apiError?.fields.audience}
          onChange={(event) => setDraft(event.target.value)}
        />

        <div className="flex items-center justify-between gap-4">
          <p
            className={`font-mono text-xs ${overCap ? 'text-on-error-container' : 'text-outline'}`}
            // The count changes on every keystroke; announcing each one would
            // bury the rest of the form in chatter (PRD §18).
            aria-live="off"
          >
            {draft.trim().length} / {max}
          </p>
          <Button type="submit" disabled={setAudience.isPending || overCap || !dirty}>
            {setAudience.isPending ? text.common.saving : text.common.save}
          </Button>
        </div>
      </form>

      <p className="mt-3 text-xs text-outline">
        {text.space.audienceHelp}
      </p>
    </Card>
  );
}
