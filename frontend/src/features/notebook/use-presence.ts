import { useEffect, useRef, useState } from 'react';
import { notebookApi, type Actor } from '@/lib/api';
import { useCurrentUser } from '@/features/auth/use-auth';

/** Ten seconds against the server's 30 s TTL: two missed beats before a name drops. */
export const HEARTBEAT_MS = 10_000;

interface PresenceEvent {
  type: 'notebook.presence';
  users: Actor[];
}

const isPresenceEvent = (payload: unknown): payload is PresenceEvent =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as { type?: unknown }).type === 'notebook.presence' &&
  Array.isArray((payload as { users?: unknown }).users);

/**
 * Who else has this notebook open in edit mode (shared-spaces-v1 "Notebook
 * presence"). Advisory only: the compare-and-set save is still the arbiter.
 *
 * Reads the current set once, then listens on the space's event stream for
 * `notebook.presence`; while `editing`, beats every {@link HEARTBEAT_MS} and
 * clears itself on unmount or when editing stops. The signed-in user is
 * filtered out of `others` — their own name on the indicator would be noise.
 */
export function usePresence(spaceId: string, editing: boolean): { others: Actor[]; loaded: boolean } {
  const { data: me } = useCurrentUser();
  const [users, setUsers] = useState<Actor[] | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // The set, live.
  useEffect(() => {
    if (spaceId === '') return;
    let stopped = false;
    void notebookApi
      .presence(spaceId)
      .then(({ users: current }) => {
        if (!stopped) setUsers(current);
      })
      .catch(() => {
        // Presence is a nicety: a failed read leaves the indicator empty.
        if (!stopped) setUsers([]);
      });

    if (typeof EventSource === 'undefined') return () => {
      stopped = true;
    };
    const stream = new EventSource(`/api/spaces/${spaceId}/events`, { withCredentials: true });
    stream.onmessage = (event: MessageEvent<string>) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isPresenceEvent(payload)) setUsers(payload.users);
    };
    // A dropped stream is not worth its own retry: the next heartbeat's response
    // carries the set, and the reader of a stale indicator loses nothing.
    stream.onerror = () => stream.close();
    return () => {
      stopped = true;
      stream.close();
    };
  }, [spaceId]);

  // My own heartbeat while editing.
  useEffect(() => {
    if (spaceId === '' || !editing) return;
    let cancelled = false;
    const beat = () => {
      void notebookApi
        .heartbeat(spaceId)
        .then(({ users: current }) => {
          if (!cancelled) setUsers(current);
        })
        .catch(() => {});
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      void notebookApi.leavePresence(spaceId).catch(() => {});
    };
  }, [spaceId, editing]);

  const others = (users ?? []).filter((user) => user.id !== me?.id);
  return { others, loaded: users !== null };
}
