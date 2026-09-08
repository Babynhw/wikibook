/**
 * Reads a `text/event-stream` response body.
 *
 * Hand-written rather than installed: the alternative is a dependency for a
 * `TextDecoder` and a split on a blank line. `EventSource` is not an option — it
 * only issues GET requests and cannot carry the question in a body, which is why
 * the answer streams on its own POST response
 * (wiki-docs/plan/phase-4-assistant/design.md).
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) return;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. A chunk boundary can land anywhere,
      // including mid-JSON, so only complete blocks are parsed.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = block.split('\n').find((part) => part.startsWith('data: '));
        if (line) {
          try {
            yield JSON.parse(line.slice(6));
          } catch {
            // A malformed block is dropped rather than ending the answer: the
            // stream is a sequence of independent events, not one document.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** One event on an answer stream. Mirrors what the ask route sends. */
export type AskEvent =
  | { type: 'user_message'; id: string; createdAt: string }
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | {
      type: 'citation';
      index: number;
      citationId: string | null;
      sourceId: string;
      sourceTitle: string;
      reference: string;
      quotedText: string;
    }
  | { type: 'sources'; sources: { id: string; title: string }[] }
  | { type: 'title'; title: string }
  | { type: 'done'; messageId: string; grounded: boolean; truncated: boolean }
  | { type: 'error'; message: string };

/** Narrows an unknown payload to a known event, dropping anything unrecognised. */
export function asAskEvent(payload: unknown): AskEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  const known = [
    'user_message',
    'thinking',
    'delta',
    'citation',
    'sources',
    'title',
    'done',
    'error',
  ];
  return known.includes(type) ? (payload as AskEvent) : null;
}
