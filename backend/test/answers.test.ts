import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import {
  ask,
  createConversation,
  groundedScript,
  scriptedProvider,
  seedSource,
  type ScriptedProvider,
} from './assistant-helpers.js';
import type { AnswerEvent } from '../src/lib/answer-provider.js';

/**
 * The answer path (PRD §9), with a scripted provider.
 *
 * These are the tests this phase exists for: everything here is about a citation
 * being impossible to fabricate, rather than about prose quality — which is
 * hand-verified against the real API instead.
 */
describe('answers and citations', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let cookie: string;
  let spaceId: string;
  let sourceId: string;
  let passageIds: string[];
  const emails: string[] = [];

  const WITHDRAWAL = 'Participants explained that withdrawing from the study felt socially costly.';
  const SECOND = 'At the second site no such pressure was reported by any participant.';

  /** Swapped per test. The plugin decorates a plain property for exactly this. */
  let provider: ScriptedProvider;

  beforeAll(async () => {
    app = await startTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const email = uniqueEmail('answers');
    emails.push(email);
    const user = await registerUser(app, email);
    cookie = user.cookie;
    spaceId = await createSpace(app, cookie, 'Answers space');

    const seeded = await seedSource(app, spaceId, {
      title: 'Consent Practices',
      passages: [
        { text: WITHDRAWAL, page: 7 },
        { text: SECOND, page: 9 },
      ],
    });
    sourceId = seeded.sourceId;
    passageIds = seeded.passageIds;
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  const use = (options: Parameters<typeof scriptedProvider>[0]) => {
    provider = scriptedProvider(options);
    app.answerProvider = provider;
    return provider;
  };

  it('sends one document per retrieved passage, with title and locator, and history as messages', async () => {
    use({ events: groundedScript('An answer.', [0]) });
    const conversationId = await createConversation(app, cookie, spaceId);

    await ask(baseUrl, cookie, conversationId, 'Did participants feel able to withdraw?');
    await ask(baseUrl, cookie, conversationId, 'And at the other site?');

    const [first, second] = provider.requests;
    expect(first).toBeDefined();
    expect(first!.documents.length).toBeGreaterThan(0);
    // One document per passage, each naming its source and its locator — the
    // reference §9 requires a citation to carry comes from here, not from prose.
    for (const document of first!.documents) {
      expect(document.title).toBe('Consent Practices');
      expect(document.context).toMatch(/^Page \d+$/);
      expect(document.text.length).toBeGreaterThan(0);
    }

    // A follow-up carries the previous turns as conversation. Not as documents:
    // that parameter choice is what enforces "answers are never evidence" (§9).
    expect(second!.history.length).toBeGreaterThan(0);
    const historyText = second!.history.map((turn) => turn.text).join('\n');
    expect(historyText).toContain('Did participants feel able to withdraw?');
    expect(second!.documents.every((document) => !document.text.includes('An answer.'))).toBe(true);
  });

  it('writes a marker into the answer text for a provider that supplies none', async () => {
    // The regression this exists for: no provider hands over a marker. A native
    // tier attaches citations out-of-band and the model is never asked to type
    // `[1]`, so an answer with no markers renders nothing clickable — §9's
    // "citations beside the claims they support" silently unmet (REQ-185). Every
    // other fixture in this file pre-bakes markers, which is exactly how the gap
    // stayed invisible.
    use({
      events: [
        { type: 'delta', text: 'Withdrawal felt costly' },
        { type: 'citation', documentIndex: 0, quotedText: '' },
        { type: 'delta', text: ', though not everywhere' },
        { type: 'citation', documentIndex: 1, quotedText: '' },
        { type: 'delta', text: '.' },
        { type: 'stop', reason: 'end' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');

    // Streamed: the marker arrives as a delta, in position.
    const streamed = events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text as string)
      .join('');
    expect(streamed).toBe('Withdrawal felt costly [1], though not everywhere [2].');

    // Stored: the same text, so a reload renders what the user first saw.
    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { content: true },
    });
    expect(message!.content).toBe('Withdrawal felt costly [1], though not everywhere [2].');
  });

  it('reuses one marker number for a passage cited twice, and stores one row', async () => {
    use({
      events: [
        { type: 'delta', text: 'One claim' },
        { type: 'citation', documentIndex: 0, quotedText: '' },
        { type: 'delta', text: ', and a second from the same passage' },
        { type: 'citation', documentIndex: 0, quotedText: '' },
        { type: 'delta', text: '.' },
        { type: 'stop', reason: 'end' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');

    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { content: true },
    });
    // The same number both times — a second `[2]` would point at nothing.
    expect(message!.content).toBe('One claim [1], and a second from the same passage [1].');
    expect(await app.prisma.citation.count({ where: { messageId: done!.messageId as string } })).toBe(1);
  });

  it('strips citation markers from a replayed assistant turn', async () => {
    use({ events: groundedScript('Withdrawal was costly [1], though not everywhere [2].', [0, 1]) });
    const conversationId = await createConversation(app, cookie, spaceId);

    await ask(baseUrl, cookie, conversationId, 'What did participants say about withdrawing?');
    await ask(baseUrl, cookie, conversationId, 'Say more about the second site.');

    const replayed = provider.requests[1]!.history.find((turn) => turn.role === 'assistant');
    expect(replayed).toBeDefined();
    // A `[1]` from an earlier turn indexes a document set that no longer exists.
    expect(replayed!.text).not.toMatch(/\[\d+\]/);
    expect(replayed!.text).toContain('Withdrawal was costly');
  });

  it('persists a citation whose locator comes from the passage row, not from the model', async () => {
    use({ events: groundedScript('Grounded.', [0], 'withdrawing from the study') });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();

    const stored = await app.prisma.citation.findMany({
      where: { messageId: done!.messageId as string },
      select: {
        passageId: true,
        sourceId: true,
        page: true,
        paragraphRef: true,
        quotedText: true,
      },
    });
    expect(stored).toHaveLength(1);
    const citation = stored[0]!;

    // The passage the citation names, read straight from the table.
    const passage = await app.prisma.passage.findUnique({
      where: { id: citation.passageId! },
      select: { page: true, paragraphRef: true, sourceId: true },
    });
    expect(citation.sourceId).toBe(passage!.sourceId);
    expect(citation.page).toBe(passage!.page);
    expect(citation.paragraphRef).toBe(passage!.paragraphRef);
    expect(citation.quotedText).toBe('withdrawing from the study');
    expect(passageIds).toContain(citation.passageId);
  });

  it('persists nothing when every citation index addresses nothing we sent', async () => {
    use({
      events: [
        { type: 'delta', text: 'An answer whose every citation is invented.' },
        // Out of range, and negative — a model cannot make either of these real.
        { type: 'citation', documentIndex: 99, quotedText: 'invented' },
        { type: 'citation', documentIndex: -1, quotedText: 'also invented' },
        { type: 'stop', reason: 'end' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing');
    const done = events.find((event) => event.type === 'done');

    // Nothing resolved, so nothing is persisted and the answer is ungrounded —
    // this is the branch that makes fabrication unpersistable rather than merely
    // unlikely. Asserting on *zero* matters: an earlier version of this test kept
    // one valid citation alongside the invented ones, and the dedupe-by-passage
    // rule silently absorbed a mutation that resolved a bad index to passage 0.
    expect(await app.prisma.citation.count({ where: { messageId: done!.messageId as string } })).toBe(0);
    expect(done!.grounded).toBe(false);
    expect(events.filter((event) => event.type === 'citation')).toHaveLength(0);
  });

  it('keeps only the resolving citation when some indexes are invented', async () => {
    const events: AnswerEvent[] = [
      { type: 'delta', text: 'Answer with one real and two invented citations.' },
      // Deliberately not index 0: a bad index resolved to the first passage would
      // otherwise be indistinguishable from this one.
      { type: 'citation', documentIndex: 1, quotedText: 'no such pressure was reported' },
      { type: 'citation', documentIndex: 99, quotedText: 'invented' },
      { type: 'citation', documentIndex: -1, quotedText: 'also invented' },
      { type: 'stop', reason: 'end' },
    ];
    use({ events });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events: streamed } = await ask(baseUrl, cookie, conversationId, 'withdrawing');
    const done = streamed.find((event) => event.type === 'done');

    const stored = await app.prisma.citation.findMany({
      where: { messageId: done!.messageId as string },
      select: { passageId: true },
    });
    expect(stored).toHaveLength(1);
    // The second passage, not whichever one a fallback would have reached for.
    expect(stored[0]!.passageId).toBe(passageIds[1]);
    expect(streamed.filter((event) => event.type === 'citation')).toHaveLength(1);
  });

  it('discards a generated quote that is not in the passage', async () => {
    use({
      events: [
        { type: 'delta', text: 'Answer.' },
        { type: 'citation', documentIndex: 0, quotedText: 'a sentence the source never contained' },
        { type: 'stop', reason: 'end' },
      ],
      // A provider whose quote is model-written rather than API-extracted.
      capabilities: { quote: 'generated' },
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing');
    const done = events.find((event) => event.type === 'done');

    const stored = await app.prisma.citation.findMany({
      where: { messageId: done!.messageId as string },
      select: { quotedText: true, passageId: true },
    });
    // The citation survives — it names a real passage — but the unverifiable
    // quote does not, because showing it would be presenting invented evidence.
    expect(stored).toHaveLength(1);
    expect(stored[0]!.quotedText).toBe('');
  });

  it('resolves every persisted citation to a reader location containing the passage text', async () => {
    use({ events: groundedScript('Grounded on both passages.', [0, 1]) });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const citationEvents = events.filter((event) => event.type === 'citation');
    expect(citationEvents.length).toBeGreaterThan(0);

    for (const event of citationEvents) {
      const citationId = event.citationId as string;
      expect(citationId).toBeTruthy();

      // The route Phase 3 built and marked inert now has a real producer.
      const target = await app.inject({
        method: 'GET',
        url: `/citations/${citationId}/target`,
        headers: { cookie },
      });
      expect(target.statusCode).toBe(200);
      const { target: resolved } = target.json() as {
        target: { sourceId: string; startBlockOrd: number | null; endBlockOrd: number | null; stale: boolean };
      };
      expect(resolved.sourceId).toBe(sourceId);
      expect(resolved.stale).toBe(false);

      // …and the block range it names actually contains the cited passage.
      const citation = await app.prisma.citation.findUnique({
        where: { id: citationId },
        select: { passage: { select: { text: true } } },
      });
      const blocks = await app.prisma.sourceBlock.findMany({
        where: {
          sourceId: resolved.sourceId,
          ord: { gte: resolved.startBlockOrd!, lte: resolved.endBlockOrd! },
        },
        orderBy: { ord: 'asc' },
        select: { text: true },
      });
      expect(blocks.map((block) => block.text).join('\n')).toContain(citation!.passage!.text);
    }
  });

  it('answers insufficiency without calling the provider when nothing is retrieved', async () => {
    const emptySpace = await createSpace(app, cookie, 'No evidence space');
    use({ events: [], mustNotBeCalled: true });
    const conversationId = await createConversation(app, cookie, emptySpace);

    const { events } = await ask(baseUrl, cookie, conversationId, 'Anything about tides?');

    const done = events.find((event) => event.type === 'done');
    expect(done!.grounded).toBe(false);
    expect(provider.requests).toHaveLength(0);

    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { content: true, scopeSnapshot: true },
    });
    expect(message!.content).toMatch(/no sources ready|did not match|nothing in this source/i);
    expect((message!.scopeSnapshot as { grounded?: boolean }).grounded).toBe(false);
  });

  it('stores an answer with no citations as ungrounded', async () => {
    use({
      events: [
        { type: 'delta', text: 'The excerpts here do not cover that.' },
        { type: 'stop', reason: 'end' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');
    expect(done!.grounded).toBe(false);

    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { scopeSnapshot: true },
    });
    // Derived from the citation count, not stored as a second source of truth
    // that could disagree with it.
    expect((message!.scopeSnapshot as { grounded?: boolean }).grounded).toBe(false);
  });

  it('forwards reasoning as progress and keeps it out of the stored answer', async () => {
    use({
      events: [
        { type: 'thinking', text: 'Let me weigh excerpt 0 against excerpt 1.' },
        { type: 'delta', text: 'Withdrawal felt costly.' },
        { type: 'citation', documentIndex: 0, quotedText: '' },
        { type: 'stop', reason: 'end' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');

    // Reasoning reaches the client, because §19 measures the first thing the user
    // sees and on a reasoning model that is this, twenty seconds before any text.
    expect(events.find((event) => event.type === 'thinking')).toMatchObject({
      text: 'Let me weigh excerpt 0 against excerpt 1.',
    });

    const done = events.find((event) => event.type === 'done');
    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { content: true },
    });
    // …and stops there. Reasoning is progress, not product: it is not the answer,
    // it is not citable, and it must not become context for the next follow-up.
    expect(message!.content).not.toContain('weigh excerpt');
    expect(message!.content).toContain('Withdrawal felt costly.');
  });

  it('reports a refusal as a §16 failure and persists no assistant message', async () => {
    use({
      events: [
        // A refusal is a successful response whose content may be empty.
        { type: 'stop', reason: 'refusal' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');

    const error = events.find((event) => event.type === 'error');
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/still here/i);
    // No provider detail leaks to the client (§16/§17).
    expect(JSON.stringify(events)).not.toMatch(/refus|anthropic|scripted/i);

    const assistant = await app.prisma.message.count({
      where: { conversationId, role: 'assistant' },
    });
    expect(assistant).toBe(0);
    // The question survives, which is what Retry re-sends.
    expect(await app.prisma.message.count({ where: { conversationId, role: 'user' } })).toBe(1);
  });

  it('reports a provider error as the same failure, with no provider text', async () => {
    use({ events: [], fail: new Error('ECONNRESET talking to api.example.com') });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');

    const error = events.find((event) => event.type === 'error');
    expect(error).toBeDefined();
    expect(JSON.stringify(events)).not.toContain('ECONNRESET');
    expect(await app.prisma.message.count({ where: { conversationId, role: 'assistant' } })).toBe(0);
  });

  it('persists the question but no partial answer when the client disconnects', async () => {
    use({
      events: [
        { type: 'delta', text: 'A partial senten' },
        // Never reached: the client is gone by now.
        { type: 'delta', text: 'ce that would poison the next follow-up.' },
        { type: 'stop', reason: 'end' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    await ask(baseUrl, cookie, conversationId, 'withdrawing from the study', {
      abortAfterFirstEvent: true,
    });
    // The abort races the server's write loop; give it a moment to observe close.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await app.prisma.message.count({ where: { conversationId, role: 'user' } })).toBe(1);
    expect(await app.prisma.message.count({ where: { conversationId, role: 'assistant' } })).toBe(0);
  });

  it('reports truncation without treating it as an error', async () => {
    use({
      events: [
        { type: 'delta', text: 'An answer cut off mid' },
        { type: 'citation', documentIndex: 0, quotedText: '' },
        { type: 'stop', reason: 'truncated' },
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');
    expect(done!.truncated).toBe(true);
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    expect(await app.prisma.message.count({ where: { conversationId, role: 'assistant' } })).toBe(1);
  });

  it('titles the conversation from the first question and survives a title failure', async () => {
    use({ events: groundedScript('Answer.', [0]), title: 'Withdrawal pressure' });
    const first = await createConversation(app, cookie, spaceId);
    const { events } = await ask(baseUrl, cookie, first, 'What did participants say about withdrawing?');
    expect(events.find((event) => event.type === 'title')!.title).toBe('Withdrawal pressure');

    // A second question does not re-title.
    await ask(baseUrl, cookie, first, 'And then?');
    expect(provider.titleCalls).toBe(1);

    use({
      events: groundedScript('Answer.', [0]),
      title: () => Promise.reject(new Error('provider down')),
    });
    const second = await createConversation(app, cookie, spaceId);
    const { events: fallback } = await ask(baseUrl, cookie, second, 'A question about withdrawing');
    // Not an error: the question itself is a usable title.
    expect(fallback.find((event) => event.type === 'error')).toBeUndefined();
    const conversation = await app.prisma.conversation.findUnique({
      where: { id: second },
      select: { title: true },
    });
    expect(conversation!.title).toBe('A question about withdrawing');
  });

  it('ends the asking state before generating the title', async () => {
    use({ events: groundedScript('Answer.', [0]), title: 'Withdrawal pressure' });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'What did participants say?');
    const types = events.map((event) => event.type);

    // Titling is a *second* provider call and can outlast the answer: measured
    // against a reasoning model serving both, the answer finished at 21.6 s and
    // `done` arrived at 56.7 s, with the composer disabled for the 35 s between.
    // `done` is what releases the client, so it must not queue behind the title.
    expect(types.indexOf('done')).toBeLessThan(types.indexOf('title'));
    // Still announced, so the conversation list still refreshes: the client
    // settles on `done` and keeps reading until the stream closes.
    expect(events.find((event) => event.type === 'title')!.title).toBe('Withdrawal pressure');
  });

  it('records the model that served, not the one requested', async () => {
    use({
      events: [
        // A router maps or fails over, so the served id can differ from the ask.
        { type: 'model', id: 'openrouter/served-something-else' },
        ...groundedScript('Grounded.', [0]),
      ],
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');

    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { scopeSnapshot: true },
    });
    const snapshot = message!.scopeSnapshot as Record<string, unknown>;
    // Without this the snapshot describes something that never ran, which is
    // exactly what the snapshot exists to prevent.
    expect(snapshot.model).toBe('openrouter/served-something-else');
  });

  it('records the citation tier the answer was grounded by', async () => {
    use({
      events: groundedScript('Grounded by convention.', [0], 'withdrawing from the study'),
      // The `structured` tier: a schema of our own design rather than a native
      // citation channel, and a quote the model wrote rather than the API extracted.
      capabilities: { citations: 'structured', quote: 'generated' },
    });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');

    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { scopeSnapshot: true },
    });
    expect((message!.scopeSnapshot as Record<string, unknown>).citationMode).toBe('structured');

    // The rules are not re-implemented per tier: the citation still resolves to a
    // real passage with a locator copied from its row.
    const citation = await app.prisma.citation.findFirst({
      where: { messageId: done!.messageId as string },
      select: { passageId: true, page: true, quotedText: true },
    });
    expect(passageIds).toContain(citation!.passageId);
    expect(citation!.page).toBe(7);
    // A verbatim quote survives the substring check that `generated` turns on.
    expect(citation!.quotedText).toBe('withdrawing from the study');
  });

  it('records the scope and the sources actually used in the snapshot', async () => {
    use({ events: groundedScript('Grounded.', [0]) });
    const conversationId = await createConversation(app, cookie, spaceId);

    const { events } = await ask(baseUrl, cookie, conversationId, 'withdrawing from the study');
    const done = events.find((event) => event.type === 'done');

    const message = await app.prisma.message.findUnique({
      where: { id: done!.messageId as string },
      select: { scopeSnapshot: true },
    });
    const snapshot = message!.scopeSnapshot as Record<string, unknown>;
    expect(snapshot.scopeType).toBe('space');
    expect(snapshot.sourceIds).toEqual([sourceId]);
    expect(snapshot.sourceTitles).toEqual(['Consent Practices']);
    expect(snapshot.citationMode).toBe('native');
    expect(snapshot.provider).toBe('scripted');
    expect(snapshot.passageCount).toBeGreaterThan(0);
  });
});
