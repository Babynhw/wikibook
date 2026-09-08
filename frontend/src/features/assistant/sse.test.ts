import { describe, expect, it } from 'vitest';
import { asAskEvent, readEventStream } from './sse';

/** Builds a stream that delivers exactly these byte chunks, in order. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of readEventStream(stream)) events.push(event);
  return events;
}

describe('SSE reading', () => {
  it('yields events in order', async () => {
    const events = await collect(
      streamOf([
        'data: {"type":"delta","text":"Hello "}\n\n',
        'data: {"type":"delta","text":"world"}\n\n',
        'data: {"type":"done","messageId":"m1","grounded":true,"truncated":false}\n\n',
      ]),
    );
    expect(events).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'done', messageId: 'm1', grounded: true, truncated: false },
    ]);
  });

  it('reassembles an event split across chunk boundaries mid-JSON', async () => {
    // A network chunk can land anywhere, including inside a string literal. The
    // parser must wait for the blank line rather than parsing what it has.
    const events = await collect(
      streamOf(['data: {"type":"del', 'ta","text":"a partial JSON stri', 'ng"}\n\n']),
    );
    expect(events).toEqual([{ type: 'delta', text: 'a partial JSON string' }]);
  });

  it('handles several events arriving in one chunk', async () => {
    const events = await collect(
      streamOf(['data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\n']),
    );
    expect(events).toHaveLength(2);
  });

  it('drops a malformed block without ending the stream', async () => {
    const events = await collect(
      streamOf(['data: not json at all\n\n', 'data: {"type":"delta","text":"survived"}\n\n']),
    );
    // The stream is a sequence of independent events, not one document.
    expect(events).toEqual([{ type: 'delta', text: 'survived' }]);
  });

  it('ignores comment-only blocks', async () => {
    const events = await collect(streamOf([': keep-alive\n\n', 'data: {"type":"delta","text":"x"}\n\n']));
    expect(events).toEqual([{ type: 'delta', text: 'x' }]);
  });

  it('narrows unknown payloads away', () => {
    expect(asAskEvent({ type: 'delta', text: 'x' })).not.toBeNull();
    expect(asAskEvent({ type: 'something-new' })).toBeNull();
    expect(asAskEvent('a string')).toBeNull();
    expect(asAskEvent(null)).toBeNull();
  });
});
