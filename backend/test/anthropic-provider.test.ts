import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/lib/anthropic-provider.js';
import { AnswerProviderError, type AnswerEvent, type AnswerRequest } from '../src/lib/answer-provider.js';

/**
 * The `native` tier against a stubbed endpoint.
 *
 * This adapter is the default in production and had no tests at all until a code
 * review pointed that out: the scripted provider used everywhere else bypasses it,
 * so a dropped `citations.enabled`, an unread `citations_delta`, or a missing
 * served-model report would all have been invisible.
 *
 * The flag matters more than it looks: the API requires citations on **all or
 * none** of a request's documents, so getting it wrong is a 400 rather than a
 * quietly worse answer.
 */
describe('anthropic provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const request: AnswerRequest = {
    question: 'Did participants feel pressure not to withdraw?',
    documents: [
      { title: 'Consent Practices', context: 'Page 7', text: 'Withdrawing felt socially costly.' },
      { title: 'Site B Report', context: 'Page 3', text: 'No such pressure was reported.' },
    ],
    history: [
      { role: 'user', text: 'An earlier question' },
      { role: 'assistant', text: 'An earlier answer' },
    ],
    model: 'claude-opus-5',
    effort: 'low',
    maxTokens: 2048,
  };

  /** Serves an Anthropic-shaped SSE stream and captures the request body. */
  function stub(events: unknown[], options: { status?: number } = {}) {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        if (options.status && options.status >= 400) {
          return Promise.resolve(
            new Response(JSON.stringify({ type: 'error', error: { message: 'nope' } }), {
              status: options.status,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const event of events) {
              const payload = event as { type: string };
              controller.enqueue(
                encoder.encode(`event: ${payload.type}\ndata: ${JSON.stringify(event)}\n\n`),
              );
            }
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      }),
    );
    return { sent };
  }

  const messageStart = (model = 'claude-opus-5-served') => ({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  const textDelta = (text: string) => ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  const citationDelta = (documentIndex: number, citedText: string) => ({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'char_location',
        document_index: documentIndex,
        document_title: 'Consent Practices',
        cited_text: citedText,
        start_char_index: 0,
        end_char_index: 10,
      },
    },
  });
  const blockStop = { type: 'content_block_stop', index: 0 };
  const messageDelta = (stopReason: string) => ({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 40, cache_read_input_tokens: 512 },
  });
  const messageStop = { type: 'message_stop' };

  const provider = (baseURL?: string) => createAnthropicProvider('test-key', baseURL);

  async function collect(events: AsyncIterable<AnswerEvent>): Promise<AnswerEvent[]> {
    const out: AnswerEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  it('enables citations on every document and sends history as messages', async () => {
    const { sent } = stub([messageStart(), blockStart, textDelta('An answer.'), blockStop, messageDelta('end_turn'), messageStop]);
    await collect(provider().answer(request, new AbortController().signal));

    const body = sent[0]!;
    const messages = body.messages as { role: string; content: unknown }[];
    // Prior turns are conversation, never documents — the parameter choice that
    // enforces "answers are never evidence" (§9).
    expect(messages.slice(0, 2).map((m) => m.role)).toEqual(['user', 'assistant']);

    const content = messages.at(-1)!.content as { type: string; citations?: { enabled: boolean }; title?: string; context?: string }[];
    const documents = content.filter((block) => block.type === 'document');
    expect(documents).toHaveLength(2);
    // All or none: a mixture is a 400, and a missing flag means no citations at
    // all, which this system would report as an ungrounded answer.
    expect(documents.every((doc) => doc.citations?.enabled === true)).toBe(true);
    expect(documents.map((doc) => doc.title)).toEqual(['Consent Practices', 'Site B Report']);
    expect(documents.map((doc) => doc.context)).toEqual(['Page 7', 'Page 3']);
    // The question is the last block, after the documents.
    expect(content.at(-1)!.type).toBe('text');
  });

  it('reads a citations_delta into a citation event', async () => {
    stub([
      messageStart(),
      blockStart,
      textDelta('Withdrawal felt costly'),
      citationDelta(0, 'socially costly'),
      blockStop,
      messageDelta('end_turn'),
      messageStop,
    ]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(events).toContainEqual({ type: 'delta', text: 'Withdrawal felt costly' });
    expect(events).toContainEqual({
      type: 'citation',
      documentIndex: 0,
      quotedText: 'socially costly',
    });
  });

  it('reports the served model from message_start', async () => {
    stub([messageStart('claude-opus-5-via-proxy'), blockStart, blockStop, messageDelta('end_turn'), messageStop]);
    const events = await collect(provider().answer(request, new AbortController().signal));
    // A proxy or router may map the model; the snapshot records what answered.
    expect(events[0]).toEqual({ type: 'model', id: 'claude-opus-5-via-proxy' });
  });

  it.each([
    ['end_turn', 'end'],
    ['max_tokens', 'truncated'],
    ['refusal', 'refusal'],
  ] as const)('maps stop reason %s to %s', async (stopReason, expected) => {
    stub([messageStart(), blockStart, blockStop, messageDelta(stopReason), messageStop]);
    const events = await collect(provider().answer(request, new AbortController().signal));
    expect(events.find((event) => event.type === 'stop')).toEqual({ type: 'stop', reason: expected });
  });

  it('reports usage including the cache read', async () => {
    stub([messageStart(), blockStart, blockStop, messageDelta('end_turn'), messageStop]);
    const events = await collect(provider().answer(request, new AbortController().signal));
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      outputTokens: 40,
      cacheReadTokens: 512,
    });
  });

  it('caches the system prompt and nothing else', async () => {
    const { sent } = stub([messageStart(), blockStart, blockStop, messageDelta('end_turn'), messageStop]);
    await collect(provider().answer(request, new AbortController().signal));

    const system = sent[0]!.system as { cache_control?: unknown }[];
    // The documents change every question, so they are past the last breakpoint by
    // construction; only this prefix is cacheable.
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('honours a base URL, which is all the Anthropic Skin needs', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        calls.push(String(input));
        const encoder = new TextEncoder();
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                // A minimal but *ordered* stream: the SDK rejects a message_stop
                // that arrives before its message_start.
                for (const event of [messageStart(), blockStart, blockStop, messageDelta('end_turn'), messageStop]) {
                  const payload = event as { type: string };
                  controller.enqueue(
                    encoder.encode(`event: ${payload.type}\ndata: ${JSON.stringify(event)}\n\n`),
                  );
                }
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }),
    );

    await collect(provider('https://openrouter.ai/api').answer(request, new AbortController().signal));
    expect(calls[0]).toContain('https://openrouter.ai/api');
  });

  it('turns a non-2xx into a provider error', async () => {
    stub([], { status: 401 });
    await expect(
      collect(provider().answer(request, new AbortController().signal)),
    ).rejects.toBeInstanceOf(AnswerProviderError);
  });
});
