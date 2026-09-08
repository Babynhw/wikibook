import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, notebookApi, type Notebook } from '@/lib/api';
import { authKeys } from '@/features/auth/use-auth';
import { clearDraft, writeDraft } from './draft-storage';
import { notebookKeys } from './use-notebook';

/**
 * Autosave (PRD §13, §16, §19):
 *
 *   edit ──▶ dirty ──(idle 1.5 s | blur | ⌘S)──▶ PUT ──▶ saved
 *                                                 └─ fail ──▶ failed · retry with backoff
 *
 * Temporary failures (network, 5xx, 429) retry forever while dirty — 2 s, 4 s,
 * … capped at 30 s. A conflict (409 `notebook_conflict`) stops and asks; an
 * archived space, an invalid document, or a lost session stops and says why.
 * The latest document is always kept in memory and mirrored to storage, so
 * nothing typed is lost to any of these (design § Autosave).
 */
export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'failed'; message: string; retrying: boolean }
  | { kind: 'conflict'; message: string; server: Notebook }
  | { kind: 'stopped'; message: string };

export const DEBOUNCE_MS = 1500;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30_000;

export function useAutosave({
  spaceId,
  notebook,
  enabled,
  onReplaceDocument,
}: {
  spaceId: string;
  /** The notebook the editor was seeded from; `updatedAt` is the first base version. */
  notebook: Notebook;
  /** False on an archived space: edits are impossible, so nothing is scheduled. */
  enabled: boolean;
  /** Called with the server's document when the user chooses Reload after a conflict. */
  onReplaceDocument: (doc: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  const baseUpdatedAtRef = useRef(notebook.updatedAt);
  const latestDocRef = useRef<unknown>(notebook.contentRich);
  // Bumped on every edit; a save that completes for an older version leaves the
  // document dirty and schedules the next one.
  const versionRef = useRef(0);
  const savedVersionRef = useRef(0);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  const isDirty = () => versionRef.current !== savedVersionRef.current;

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const save = useCallback(async () => {
    clearTimer();
    if (!enabled || stoppedRef.current || inFlightRef.current || !isDirty()) return;
    inFlightRef.current = true;
    const version = versionRef.current;
    setState({ kind: 'saving' });
    try {
      const { notebook: saved } = await notebookApi.save(spaceId, {
        contentRich: latestDocRef.current,
        baseUpdatedAt: baseUpdatedAtRef.current,
      });
      baseUpdatedAtRef.current = saved.updatedAt;
      savedVersionRef.current = version;
      attemptRef.current = 0;
      queryClient.setQueryData(notebookKeys.detail(spaceId), saved);
      if (isDirty()) {
        // Typed during the request: keep the draft mirror and go again.
        schedule();
      } else {
        clearDraft(notebook.id);
        setState({ kind: 'saved', at: saved.updatedAt });
      }
    } catch (error) {
      const api = error instanceof ApiError ? error : null;
      if (api?.status === 409 && api.code === 'notebook_conflict') {
        const server = (api.body as { notebook?: Notebook } | null)?.notebook;
        if (server) {
          stoppedRef.current = true;
          setState({ kind: 'conflict', message: api.message, server });
          return;
        }
      }
      if (api?.isUnauthorized) {
        // The save runs outside TanStack, so the query client's session-lost
        // rule never sees this 401; apply it here and `RequireAuth` redirects.
        // The text is in the draft mirror for when the user signs back in.
        stoppedRef.current = true;
        queryClient.setQueryData(authKeys.me, null);
        setState({ kind: 'stopped', message: api.message });
        return;
      }
      const terminal =
        api !== null && (api.status === 400 || api.status === 404 || api.status === 409 || api.status === 413);
      if (terminal) {
        // 404 and an archived 409 are final. A 400 (a document the server will
        // not take) or a 413 (too big) is about *this* content: the next edit
        // tries again rather than leaving the editor silently unsaveable.
        stoppedRef.current = api.status === 404 || api.status === 409;
        setState({ kind: 'stopped', message: api.message });
        return;
      }
      const wait = Math.min(BACKOFF_BASE_MS * 2 ** attemptRef.current, BACKOFF_CAP_MS);
      attemptRef.current += 1;
      setState({
        kind: 'failed',
        message: api?.message ?? 'The notebook could not be saved. Your changes are kept here until it can be.',
        retrying: true,
      });
      timerRef.current = setTimeout(() => void save(), wait);
    } finally {
      inFlightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, spaceId, notebook.id, queryClient]);

  const schedule = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => void save(), DEBOUNCE_MS);
  }, [save]);

  /** Every editor update lands here. */
  const markDirty = useCallback(
    (doc: unknown) => {
      if (!enabled) return;
      latestDocRef.current = doc;
      versionRef.current += 1;
      writeDraft(notebook.id, {
        doc,
        baseUpdatedAt: baseUpdatedAtRef.current,
        savedAt: new Date().toISOString(),
      });
      if (stoppedRef.current) return;
      setState((current) => (current.kind === 'saving' ? current : { kind: 'saving' }));
      if (!inFlightRef.current) schedule();
    },
    [enabled, notebook.id, schedule],
  );

  /** Blur, ⌘S, and the Retry control. */
  const flush = useCallback(() => {
    attemptRef.current = 0;
    void save();
  }, [save]);

  /** Conflict → Reload: take the server's document and drop the local draft. */
  const reload = useCallback(() => {
    if (state.kind !== 'conflict') return;
    const server = state.server;
    baseUpdatedAtRef.current = server.updatedAt;
    latestDocRef.current = server.contentRich;
    savedVersionRef.current = versionRef.current;
    stoppedRef.current = false;
    clearDraft(notebook.id);
    queryClient.setQueryData(notebookKeys.detail(spaceId), server);
    onReplaceDocument(server.contentRich);
    setState({ kind: 'saved', at: server.updatedAt });
  }, [state, notebook.id, spaceId, queryClient, onReplaceDocument]);

  /** Conflict → Keep mine: overwrite with the server's version as the new base. */
  const keepMine = useCallback(() => {
    if (state.kind !== 'conflict') return;
    baseUpdatedAtRef.current = state.server.updatedAt;
    stoppedRef.current = false;
    flush();
  }, [state, flush]);

  /** A restored local draft is an edit like any other. */
  const adoptDraft = useCallback(
    (doc: unknown) => {
      markDirty(doc);
    },
    [markDirty],
  );

  // Leaving the page with unsaved text is the common way a failed save becomes a
  // lost one (PRD §13).
  useEffect(() => {
    if (!enabled) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      event.preventDefault();
      // Legacy browsers read returnValue; the text itself is never shown.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [enabled]);

  useEffect(() => () => clearTimer(), []);

  return useMemo(
    () => ({ state, markDirty, flush, reload, keepMine, adoptDraft, isDirty }),
    [state, markDirty, flush, reload, keepMine, adoptDraft],
  );
}
