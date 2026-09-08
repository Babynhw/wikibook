import type { ScopeInput, Source } from '@/lib/api';

/**
 * The retrieval scope, which §9 requires to be **visible at all times** — not
 * hidden behind a menu, and not only shown while it is being changed.
 *
 * Only ready, unarchived sources are offered: scoping to anything else is refused
 * by the server, and offering a choice the server will reject is a worse
 * experience than not offering it.
 *
 * Takes a `ScopeInput`, not a conversation, so the history hub can offer the same
 * choice *before* a conversation exists: the scope is snapshotted per request
 * (REQ-171), so a first question asked with the wrong scope has already spent a
 * retrieval it did not want.
 */
export function ScopeSelector({
  value,
  sources,
  onChange,
  disabled = false,
  id = 'assistant-scope',
}: {
  value: ScopeInput;
  sources: Source[];
  onChange: (input: ScopeInput) => void;
  disabled?: boolean;
  id?: string;
}) {
  const askable = sources.filter((source) => source.state === 'ready' && source.archivedAt === null);
  const current = value.scopeType === 'source' && value.scopeSourceId ? value.scopeSourceId : 'space';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm text-on-surface-variant">
        Asking about
      </label>
      <select
        id={id}
        value={current}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          onChange(
            value === 'space'
              ? { scopeType: 'space' }
              : { scopeType: 'source', scopeSourceId: value },
          );
        }}
        className="min-w-0 max-w-full rounded-md border border-outline-variant bg-surface-container-lowest px-2 py-1 text-sm text-on-surface disabled:opacity-60"
      >
        <option value="space">This entire space</option>
        {askable.map((source) => (
          <option key={source.id} value={source.id}>
            Only “{source.title}”
          </option>
        ))}
      </select>
    </div>
  );
}
