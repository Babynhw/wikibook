import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiCompatibleProvider } from '../src/lib/openai-provider.js';
import { AnswerProviderError, type AnswerEvent, type AnswerRequest } from '../src/lib/answer-provider.js';

/**
 * The `structured` tier against a stubbed endpoint. No server, no model — this is
 * about the request we send and the events we derive, which is all an adapter is
 * responsible for. Whether a citation *resolves* is `answers.ts`'s job and is
 * tested there, once, for both tiers.
 */
describe('openai-compatible provider', () => {
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
    model: 'qwen/qwen3-8b',
    effort: 'low',
    maxTokens: 2048,
  };

  /** Serves these SSE data payloads and captures the request body. */
  function stub(payloads: string[], options: { status?: number; body?: string } = {}) {
    const sent: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (options.status && options.status >= 400) {
        return Promise.resolve(new Response(options.body ?? 'upstream said no', { status: options.status }));
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return { sent };
  }

  /** One streaming chunk carrying a slice of the assistant's content. */
  const chunk = (content: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      model: 'qwen/qwen3-8b-served',
      choices: [{ delta: { content }, ...extra }],
    });

  async function collect(events: AsyncIterable<AnswerEvent>): Promise<AnswerEvent[]> {
    const out: AnswerEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  const provider = () =>
    createOpenAiCompatibleProvider({ baseURL: 'http://localhost:11434/v1', apiKey: 'k' });

  /** Collects every `enum`/`const` the request's JSON schema contains, at any depth. */
  function schemaChoices(value: unknown, found: unknown[][] = []): unknown[][] {
    if (Array.isArray(value)) {
      for (const item of value) schemaChoices(item, found);
      return found;
    }
    if (typeof value !== 'object' || value === null) return found;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.enum)) found.push(record.enum);
    // A Zod union of literals can serialise as `anyOf: [{const: 0}, …]`.
    if (Array.isArray(record.anyOf)) {
      const consts = record.anyOf
        .map((member) => (typeof member === 'object' && member !== null ? (member as Record<string, unknown>) : {}))
        .filter((member) => 'const' in member || member.type === 'null')
        .map((member) => ('const' in member ? member.const : null));
      if (consts.length > 0) found.push(consts);
    }
    for (const nested of Object.values(record)) schemaChoices(nested, found);
    return found;
  }

  it('constrains the answer to exactly the indexes it sent', async () => {
    const { sent } = stub([chunk('{"elements":[]}')]);
    await collect(provider().answer(request, new AbortController().signal));

    const body = sent[0]!;
    // Two documents were sent, so 0, 1, and "uncited" are the only choices offered
    // to the model. Asserted by *content* rather than by path: where the schema
    // sits in the body is the SDK's business, what it permits is ours.
    const choices = schemaChoices(body).map((values) => [...values].sort((a, b) => String(a).localeCompare(String(b))));
    expect(choices).toContainEqual([0, 1, null].sort((a, b) => String(a).localeCompare(String(b))));
    // OpenRouter's guard, so the router cannot route to a provider that ignores
    // the format and silently answers prose.
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.stream).toBe(true);
  });

  it('fences and numbers the excerpts, and sends history as messages', async () => {
    const { sent } = stub([chunk('{"elements":[]}')]);
    await collect(provider().answer(request, new AbortController().signal));

    const messages = sent[0]!.messages as { role: string; content: string }[];
    expect(messages[0]!.role).toBe('system');
    // Prior turns are conversation, never excerpts — the same rule as the native
    // tier, enforced by which parameter the text goes into.
    expect(messages.slice(1, 3).map((m) => m.role)).toEqual(['user', 'assistant']);

    const user = messages.at(-1)!.content;
    // Fenced, so a source whose own text contains a label-shaped line cannot
    // impersonate an excerpt and steer the credit to the wrong passage.
    expect(user).toContain('<<<EXCERPT 0>>>\nConsent Practices — Page 7');
    expect(user).toContain('<<<EXCERPT 1>>>\nSite B Report — Page 3');
    expect(user).toContain('<<<END 1>>>');
    expect(user).toContain(request.question);
  });

  it('emits a delta and a citation per completed segment', async () => {
    // `elements` is the AI SDK's wrapper for `Output.array`, not ours.
    const answer = JSON.stringify({
      elements: [
        { text: 'Withdrawal felt costly', cite: 0, quote: 'socially costly' },
        { text: ', though not everywhere', cite: 1, quote: null },
        { text: '. That reading is mine.', cite: null, quote: null },
      ],
    });
    // Split so no chunk boundary aligns with a segment boundary.
    const parts = [answer.slice(0, 30), answer.slice(30, 75), answer.slice(75)];
    stub([...parts.map((part) => chunk(part)), chunk('', { finish_reason: 'stop' })]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual([
      'Withdrawal felt costly',
      ', though not everywhere',
      '. That reading is mine.',
    ]);
    const citations = events.filter((e) => e.type === 'citation') as {
      documentIndex: number;
      quotedText: string | null;
    }[];
    // The uncited third segment produces no citation at all.
    expect(citations.map((c) => c.documentIndex)).toEqual([0, 1]);
    expect(citations[0]!.quotedText).toBe('socially costly');
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('salvages an answer that used its own top-level key', async () => {
    // Exactly what a real deployment produced: the schema declared `elements`, the
    // prompt had said "segments", and a non-strict endpoint let the model follow the
    // prose. The answer and its citations were real — and were shown to the user as
    // raw JSON with zero citations, because the wrapper name did not match.
    stub([
      chunk(
        JSON.stringify({
          segments: [
            { text: 'This document is about Einstein.', cite: 0, quote: 'Withdrawing felt socially costly.' },
            { text: ' It covers his early life.', cite: 1, quote: null },
          ],
        }),
      ),
      chunk('', { finish_reason: 'stop' }),
    ]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual([
      'This document is about Einstein.',
      ' It covers his early life.',
    ]);
    expect(
      (events.filter((e) => e.type === 'citation') as { documentIndex: number }[]).map((c) => c.documentIndex),
    ).toEqual([0, 1]);
    // And no braces anywhere near what the user reads.
    expect(events.some((e) => e.type === 'delta' && (e as { text: string }).text.includes('{'))).toBe(false);
  });

  it('salvages a bare array with no wrapper at all', async () => {
    stub([
      chunk(JSON.stringify([{ text: 'A claim.', cite: 1, quote: null }])),
      chunk('', { finish_reason: 'stop' }),
    ]);
    const events = await collect(provider().answer(request, new AbortController().signal));
    expect(events).toContainEqual({ type: 'delta', text: 'A claim.' });
    expect(events).toContainEqual({ type: 'citation', documentIndex: 1, quotedText: null });
  });

  it('fails rather than showing the user raw JSON it could not read', async () => {
    // A JSON object with nothing answer-shaped in it. Offering Retry beats printing
    // braces into the thread.
    stub([chunk('{"unexpected":{"nested":1}}'), chunk('', { finish_reason: 'stop' })]);
    await expect(
      collect(provider().answer(request, new AbortController().signal)),
    ).rejects.toBeInstanceOf(AnswerProviderError);
  });

  it('keeps a segment’s text when its citation index is out of range', async () => {
    // `elementStream` only yields elements that *validate*, so a strict enum would
    // drop this whole element — the sentence with it. Losing a sentence is worse
    // than losing a citation, so the schema coerces a bad index to "uncited"
    // (REQ-201) and REQ-155's drop rule keeps owning the real decision.
    stub([
      chunk(JSON.stringify({ elements: [{ text: 'A claim with a bogus index.', cite: 99, quote: null }] })),
      chunk('', { finish_reason: 'stop' }),
    ]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual([
      'A claim with a bogus index.',
    ]);
    expect(events.filter((e) => e.type === 'citation')).toHaveLength(0);
  });

  it('reports a well-formed but empty answer as truncated when it hit the cap', async () => {
    // Structured and valid, just with nothing in it. Treating that as prose would
    // show the user braces and mask why generation stopped.
    stub([chunk('{"elements":[]}', { finish_reason: 'length' })]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(events.filter((e) => e.type === 'delta')).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'truncated' });
  });

  it('reports the model that served, not the one requested', async () => {
    stub([chunk('{"elements":[]}')]);
    const events = await collect(provider().answer(request, new AbortController().signal));
    // A router maps and fails over; the snapshot must name what answered.
    expect(events.find((e) => e.type === 'model')).toEqual({
      type: 'model',
      id: 'qwen/qwen3-8b-served',
    });
  });

  it('streams prose with zero citations when the server ignores the schema', async () => {
    stub([
      chunk('Participants described withdrawal '),
      chunk('as socially costly.'),
      chunk('', { finish_reason: 'stop' }),
    ]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe(
      'Participants described withdrawal as socially costly.',
    );
    // An answer with no citations is ungrounded, which is honest. Attributing a
    // claim by guesswork is the one thing this design refuses to do.
    expect(events.filter((e) => e.type === 'citation')).toHaveLength(0);
  });


  it('maps finish reasons to outcomes', async () => {
    for (const [finish, reason] of [
      ['length', 'truncated'],
      ['content_filter', 'refusal'],
      ['stop', 'end'],
    ] as const) {
      stub([chunk('{"elements":[]}', { finish_reason: finish })]);
      const events = await collect(provider().answer(request, new AbortController().signal));
      expect(events.at(-1), finish).toEqual({ type: 'stop', reason });
    }
  });

  it('reports usage when the endpoint includes it', async () => {
    stub([
      JSON.stringify({
        model: 'm',
        choices: [{ delta: { content: '{"elements":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      }),
    ]);
    const events = await collect(provider().answer(request, new AbortController().signal));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
    });
  });

  it('turns a non-2xx into a provider error carrying the cause for the log', async () => {
    stub([], { status: 402, body: 'insufficient credits' });
    await expect(
      collect(provider().answer(request, new AbortController().signal)),
    ).rejects.toBeInstanceOf(AnswerProviderError);
  });

  /**
   * A reasoning model's own channel. The SDK normalises both `reasoning_content`
   * and `reasoning` to the same stream parts, so one spelling covers the tier.
   */
  const reasoningChunk = (text: string) =>
    JSON.stringify({ model: 'qwen/qwen3-8b-served', choices: [{ delta: { reasoning_content: text } }] });

  it('surfaces reasoning as thinking, and never as answer text', async () => {
    const answer = JSON.stringify({ elements: [{ text: 'An answer.', cite: 0, quote: null }] });
    stub([
      reasoningChunk('Here is a thinking '),
      reasoningChunk('process.'),
      chunk(answer),
      chunk('', { finish_reason: 'stop' }),
    ]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(
      events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text).join(''),
    ).toBe('Here is a thinking process.');
    // The whole point: reasoning is progress, not product. It must not reach the
    // text `answers.ts` accumulates and persists.
    expect(
      events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join(''),
    ).toBe('An answer.');
  });

  it('keeps both channels intact when they interleave', async () => {
    const answer = JSON.stringify({
      elements: [
        { text: 'First. ', cite: 0, quote: null },
        { text: 'Second.', cite: 1, quote: null },
      ],
    });
    // Reasoning arriving *between* slices of the answer, which the merge must not
    // reorder within either channel. No endpoint measured so far does this; the
    // ordering is a property of one model, not of the protocol.
    stub([
      reasoningChunk('one '),
      chunk(answer.slice(0, 40)),
      reasoningChunk('two'),
      chunk(answer.slice(40)),
      chunk('', { finish_reason: 'stop' }),
    ]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    expect(
      events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text).join(''),
    ).toBe('one two');
    expect(
      events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text),
    ).toEqual(['First. ', 'Second.']);
  });

  it('emits no thinking at all for a model that does not reason', async () => {
    const answer = JSON.stringify({ elements: [{ text: 'An answer.', cite: 0, quote: null }] });
    stub([chunk(answer), chunk('', { finish_reason: 'stop' })]);

    const events = await collect(provider().answer(request, new AbortController().signal));

    // The capability record says the channel exists, not that every answer uses
    // it — so a non-reasoning model must look exactly as it did before.
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(0);
  });

  it('sends the configured effort as reasoning_effort', async () => {
    const { sent } = stub([chunk('{"elements":[]}')]);
    await collect(provider().answer(request, new AbortController().signal));

    // It had been configured in `.env`, recorded in the snapshot, and sent
    // nowhere — so the model reasoned at its default depth whatever was asked.
    expect(sent[0]!.reasoning_effort).toBe('low');
  });

  it('bounds a stalled endpoint with the configured timeout', async () => {
    // Aborts on the signal, as a real fetch does. A stub that ignored it would
    // hang here rather than assert anything.
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    // Asserted by message, not just by class: every other failure on this path
    // also throws `AnswerProviderError`, so the class alone would pass even if
    // the timeout never fired and something else killed the stream.
    await expect(
      collect(provider().answer(request, new AbortController().signal)),
    ).rejects.toThrow(/did not respond in time/);
  });

  it('omits the auth header when there is no key, for a local endpoint', async () => {
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      return Promise.resolve(new Response('{"choices":[{"message":{"content":"A title"}}]}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const local = createOpenAiCompatibleProvider({ baseURL: 'http://localhost:11434/v1' });
    // A local Ollama has no auth at all; sending an empty bearer is worse than
    // sending nothing.
    expect(await local.title('A question', new AbortController().signal)).toBe('A title');
  });
});
