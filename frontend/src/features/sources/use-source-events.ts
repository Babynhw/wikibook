import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { SourceState } from '@/lib/api';
import { patchCachedSource, sourceKeys } from '@/features/sources/use-sources';

/** Exactly what the server publishes: no text, no passages (PRD §17). */
interface SourceStateEvent {
  sourceId: string;
  state: SourceState;
  errorMessage?: string;
}

const RECONNECT_DELAY_MS = 1_000;
const POLL_INTERVAL_MS = 5_000;
/** Two failed opens is the threshold from the design; the third try is a poll. */
const MAX_FAILED_OPENS = 2;

/**
 * Module-level on purpose: the fallback lasts "for the rest of the session"
 * (wiki-docs/plan/phase-2-ingestion/design.md "Live updates"). Something is
 * blocking SSE — a proxy that buffers, an extension, a corporate gateway — and
 * re-attempting the stream in every space the user opens only adds latency to a
 * failure we have already seen.
 */
let streamUnavailable = false;

/** Test-only: the flag outlives a component, so a suite has to be able to clear it. */
export function resetStreamFallback(): void {
  streamUnavailable = false;
}

function applyEvent(queryClient: QueryClient, spaceId: string, raw: string): void {
  let event: SourceStateEvent;
  try {
    event = JSON.parse(raw) as SourceStateEvent;
  } catch {
    // A malformed frame is not worth tearing the stream down for; the refetch on
    // the next connect is the backstop for anything missed.
    return;
  }
  if (typeof event.sourceId !== 'string' || typeof event.state !== 'string') return;

  const patched = patchCachedSource(queryClient, spaceId, {
    id: event.sourceId,
    state: event.state,
    errorMessage: event.errorMessage ?? null,
  });
  // An event for a source this client has never seen (added in another tab):
  // the list is the only thing that can supply the rest of the row.
  if (!patched) {
    void queryClient.invalidateQueries({ queryKey: sourceKeys.list(spaceId) });
  }
}

/**
 * One `EventSource` per open space. Events patch the cached source rather than
 * invalidating the list — the payload already carries everything a state change
 * shows, and invalidating would refetch the whole library per transition.
 *
 * There is no event replay server-side, so every (re)connect triggers one list
 * refetch: the stream is a latency optimization over that refetch, never the
 * source of truth. After {@link MAX_FAILED_OPENS} failed opens the feature drops
 * to a 5 s poll for the session, so §16 stays honest where SSE is stripped.
 *
 * @returns whether the poll fallback is in effect, so the UI can say so.
 */
export function useSourceEvents(spaceId: string): { polling: boolean } {
  const queryClient = useQueryClient();
  const [polling, setPolling] = useState(streamUnavailable);

  useEffect(() => {
    if (spaceId === '') return;

    let stopped = false;
    let failedOpens = 0;
    let stream: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const refetchList = () => {
      void queryClient.invalidateQueries({ queryKey: sourceKeys.list(spaceId) });
    };

    const startPolling = () => {
      streamUnavailable = true;
      setPolling(true);
      poll = setInterval(refetchList, POLL_INTERVAL_MS);
    };

    const connect = () => {
      if (stopped) return;
      let opened = false;
      const source = new EventSource(`/api/spaces/${spaceId}/events`, { withCredentials: true });
      stream = source;

      source.onopen = () => {
        opened = true;
        failedOpens = 0;
        // The gap the stream cannot close: anything that changed while it was down.
        refetchList();
      };
      source.onmessage = (event: MessageEvent<string>) => {
        applyEvent(queryClient, spaceId, event.data);
      };
      source.onerror = () => {
        // Own the retry rather than leaving it to EventSource's built-in one:
        // the fallback has to count failed opens, which it cannot observe.
        source.close();
        if (stopped) return;
        // A stream that opened and then died is a dropped connection, not an
        // unavailable feature — reconnect without counting it against the cap.
        if (!opened) failedOpens += 1;
        if (failedOpens >= MAX_FAILED_OPENS) {
          startPolling();
          return;
        }
        reconnect = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    // `EventSource` is native everywhere the app runs; the guard is for a
    // server-rendered or stripped environment, which gets the poll instead.
    if (streamUnavailable || typeof EventSource === 'undefined') {
      startPolling();
    } else {
      connect();
    }

    return () => {
      stopped = true;
      if (reconnect !== undefined) clearTimeout(reconnect);
      if (poll !== undefined) clearInterval(poll);
      stream?.close();
    };
  }, [spaceId, queryClient]);

  return { polling };
}
