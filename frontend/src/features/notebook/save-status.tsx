import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SaveState } from './use-autosave';
import { useUi } from '@/lib/locale';

/**
 * The save state, visible and announced (PRD §13, §18). Icon plus text, never
 * colour alone. The live region carries the *state word* only and changes only
 * when the state does — the REQ-187 pattern — so a screen reader hears
 * "Saving", "Saved", "Save failed", and not a timestamp ticking.
 */
export function SaveStatus({
  state,
  onRetry,
  onReload,
  onKeepMine,
  frozen = false,
}: {
  state: SaveState;
  onRetry: () => void;
  onReload: () => void;
  onKeepMine: () => void;
  /** Archived space: there is nothing to save, and saying "Saved" would be a lie. */
  frozen?: boolean;
}) {
  const { text } = useUi();
  if (frozen) {
    return (
      <p role="status" aria-live="polite" className="font-mono text-xs text-on-surface-variant">
        {text.common.archived}
      </p>
    );
  }
  const word =
    state.kind === 'saving'
      ? text.notebook.saving
      : state.kind === 'saved'
        ? text.notebook.saved
        : state.kind === 'failed' || state.kind === 'conflict' || state.kind === 'stopped'
          ? text.notebook.saveFailed
          : '';
  const trouble = state.kind === 'failed' || state.kind === 'conflict' || state.kind === 'stopped';

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p
        role="status"
        aria-live="polite"
        className={`inline-flex items-center gap-1.5 font-mono text-xs ${trouble ? 'text-error' : 'text-on-surface-variant'}`}
      >
        {state.kind === 'saving' ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
        {state.kind === 'saved' ? <Check className="size-3.5" aria-hidden="true" /> : null}
        {trouble ? <AlertTriangle className="size-3.5" aria-hidden="true" /> : null}
        <span>{word}</span>
      </p>
      {state.kind === 'saved' ? (
        <time dateTime={state.at} className="font-mono text-xs text-outline">
          · {new Date(state.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </time>
      ) : null}
      {state.kind === 'failed' ? (
        <>
          <span className="text-xs text-on-surface-variant">{state.message}</span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {text.notebook.retry}
          </Button>
        </>
      ) : null}
      {state.kind === 'stopped' ? (
        <span className="text-xs text-on-surface-variant">{state.message}</span>
      ) : null}
      {state.kind === 'conflict' ? (
        <>
          <span className="text-xs text-on-surface-variant">
            {state.server.updatedBy
              ? `${state.server.updatedBy.name} saved a newer version at ${new Date(state.server.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. Reload to see it, or keep yours to overwrite it.`
              : state.message}
          </span>
          <Button variant="secondary" size="sm" onClick={onReload}>
            {text.common.tryAgain}
          </Button>
          <Button variant="ghost" size="sm" onClick={onKeepMine}>
            {text.notebook.save}
          </Button>
        </>
      ) : null}
    </div>
  );
}
