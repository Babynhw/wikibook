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
} from './assistant-helpers.js';

/**
 * Conversations, scope, and feedback (PRD §9). Ownership and the frozen-space rule
 * are the §17/REQ-100 half; the rest is what §9 requires a conversation to be.
 *
 * Every test isolates by *space* and shares one account: `/auth/register` is
 * limited to 10 per minute per app instance, and a suite that registers an
 * eleventh user fails with a 429 that looks like an unrelated bug (the lesson
 * `sources.test.ts` records). The ownership test asks for the one second account.
 */
describe('conversations', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let cookie: string;
  let spaceId: string;
  let sourceId: string;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    app.answerProvider = scriptedProvider({ events: groundedScript('Answer.', [0]) });

    const email = uniqueEmail('conversations');
    emails.push(email);
    const user = await registerUser(app, email);
    cookie = user.cookie;
    spaceId = await createSpace(app, cookie, 'Conversations space');
    const seeded = await seedSource(app, spaceId, {
      title: 'A ready source',
      passages: [{ text: 'Sleep deprivation reduced recall accuracy in every cohort.', page: 1 }],
    });
    sourceId = seeded.sourceId;
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('creates a conversation with a space scope and lists it', async () => {
    const space = await createSpace(app, cookie, 'List space');
    const id = await createConversation(app, cookie, space);

    const list = await app.inject({
      method: 'GET',
      url: `/spaces/${space}/conversations`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const { conversations } = list.json() as {
      conversations: { id: string; scopeType: string; title: string }[];
    };
    expect(conversations.map((conversation) => conversation.id)).toContain(id);
    expect(conversations[0]!.scopeType).toBe('space');
    // A list row needs a name before the first question supplies one.
    expect(conversations[0]!.title).toBeTruthy();
  });

  it('orders conversations most-recently-updated first', async () => {
    const space = await createSpace(app, cookie, 'Order space');
    const older = await createConversation(app, cookie, space);
    const newer = await createConversation(app, cookie, space);

    // Touch the older one so recency, not creation, decides the order.
    await app.prisma.conversation.update({
      where: { id: older },
      data: { updatedAt: new Date(Date.now() + 60_000) },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/spaces/${space}/conversations`,
      headers: { cookie },
    });
    const ids = (list.json() as { conversations: { id: string }[] }).conversations.map((row) => row.id);
    expect(ids).toEqual([older, newer]);
  });

  it('rejects a source scope with no source, and a source from another space', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceId}/conversations`,
      headers: { cookie },
      payload: { scopeType: 'source' },
    });
    expect(missing.statusCode).toBe(400);

    const otherSpace = await createSpace(app, cookie, 'Foreign scope space');
    const foreign = await seedSource(app, otherSpace, {
      title: 'Elsewhere',
      passages: [{ text: 'Unrelated text.', page: 1 }],
    });
    // Scoping to a source in another space would be a cross-space read (§20).
    const crossSpace = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceId}/conversations`,
      headers: { cookie },
      payload: { scopeType: 'source', scopeSourceId: foreign.sourceId },
    });
    expect(crossSpace.statusCode).toBe(404);
  });

  it('changes the active scope and nothing else', async () => {
    const id = await createConversation(app, cookie, spaceId);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/conversations/${id}`,
      headers: { cookie },
      payload: { scopeType: 'source', scopeSourceId: sourceId },
    });
    expect(patched.statusCode).toBe(200);
    const { conversation } = patched.json() as {
      conversation: { scopeType: string; scopeSourceId: string | null };
    };
    expect(conversation.scopeType).toBe('source');
    expect(conversation.scopeSourceId).toBe(sourceId);

    // A title is not editable through this route: §9 lists new conversation,
    // follow-up, and view previous — renaming is not among them.
    const rename = await app.inject({
      method: 'PATCH',
      url: `/conversations/${id}`,
      headers: { cookie },
      payload: { scopeType: 'space', title: 'Renamed' },
    });
    expect(rename.statusCode).toBe(200);
    const after = await app.prisma.conversation.findUnique({
      where: { id },
      select: { title: true },
    });
    expect(after!.title).not.toBe('Renamed');
  });

  it('returns messages with their citations, oldest first', async () => {
    const id = await createConversation(app, cookie, spaceId);
    await ask(baseUrl, cookie, id, 'What happened to recall accuracy?');

    const thread = await app.inject({ method: 'GET', url: `/conversations/${id}`, headers: { cookie } });
    expect(thread.statusCode).toBe(200);
    const { messages } = thread.json() as {
      messages: {
        role: string;
        citations: { index: number; sourceTitle: string; reference: string; stale: boolean }[];
        sourcesUsed: { title: string }[];
        grounded: boolean | null;
      }[];
    };

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const answer = messages[1]!;
    expect(answer.grounded).toBe(true);
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations[0]!.index).toBe(1);
    expect(answer.citations[0]!.sourceTitle).toBe('A ready source');
    expect(answer.citations[0]!.reference).toBe('Page 1');
    expect(answer.sourcesUsed.map((source) => source.title)).toContain('A ready source');
    // A user turn carries no groundedness claim.
    expect(messages[0]!.grounded).toBeNull();
  });

  it('keeps previous conversations when a new one starts', async () => {
    const space = await createSpace(app, cookie, 'History space');
    const first = await createConversation(app, cookie, space);
    await ask(baseUrl, cookie, first, 'A first question about recall.');
    const second = await createConversation(app, cookie, space);

    const list = await app.inject({
      method: 'GET',
      url: `/spaces/${space}/conversations`,
      headers: { cookie },
    });
    const ids = (list.json() as { conversations: { id: string }[] }).conversations.map((row) => row.id);
    expect(ids).toContain(first);
    expect(ids).toContain(second);

    // And the old thread is still readable.
    const thread = await app.inject({
      method: 'GET',
      url: `/conversations/${first}`,
      headers: { cookie },
    });
    expect((thread.json() as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
  });

  it('lists a preview of the newest question and a message count', async () => {
    const space = await createSpace(app, cookie, 'Preview space');
    const asked = await createConversation(app, cookie, space);
    const long = `Why does recall accuracy drop ${'when sleep is short '.repeat(12)}?`;
    await ask(baseUrl, cookie, asked, long);
    const empty = await createConversation(app, cookie, space);

    const list = await app.inject({
      method: 'GET',
      url: `/spaces/${space}/conversations`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as {
      conversations: { id: string; preview: string | null; messageCount: number }[];
    }).conversations;

    const withTurns = rows.find((row) => row.id === asked)!;
    // Question plus its answer.
    expect(withTurns.messageCount).toBe(2);
    // The preview is the user's question, not the answer, cut to one line.
    expect(withTurns.preview).not.toBeNull();
    expect(withTurns.preview!.startsWith('Why does recall accuracy drop')).toBe(true);
    expect(withTurns.preview!.endsWith('…')).toBe(true);
    expect(withTurns.preview!.length).toBeLessThanOrEqual(141);

    const blank = rows.find((row) => row.id === empty)!;
    expect(blank.preview).toBeNull();
    expect(blank.messageCount).toBe(0);
  });

  it('collapses a preview to one line and leaves a short one uncut', async () => {
    const space = await createSpace(app, cookie, 'Preview whitespace space');
    const id = await createConversation(app, cookie, space);
    await ask(baseUrl, cookie, id, '  Does\n\nsleep\thelp   recall? 🧠  ');

    const list = await app.inject({
      method: 'GET',
      url: `/spaces/${space}/conversations`,
      headers: { cookie },
    });
    const row = (list.json() as { conversations: { id: string; preview: string | null }[] })
      .conversations.find((candidate) => candidate.id === id)!;
    expect(row.preview).toBe('Does sleep help recall? 🧠');
  });

  it('records, changes, and clears feedback on an answer only', async () => {
    const id = await createConversation(app, cookie, spaceId);
    await ask(baseUrl, cookie, id, 'What happened to recall accuracy?');

    const thread = await app.inject({ method: 'GET', url: `/conversations/${id}`, headers: { cookie } });
    const { messages } = thread.json() as { messages: { id: string; role: string }[] };
    const answer = messages.find((message) => message.role === 'assistant')!;
    const question = messages.find((message) => message.role === 'user')!;

    for (const feedback of ['useful', 'not_useful', null] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/messages/${answer.id}/feedback`,
        headers: { cookie },
        payload: { feedback },
      });
      expect(response.statusCode).toBe(200);
      const stored = await app.prisma.message.findUnique({
        where: { id: answer.id },
        select: { feedback: true },
      });
      expect(stored!.feedback).toBe(feedback);
    }

    // Feedback on the user's own question would store a rating nothing can act on.
    const onQuestion = await app.inject({
      method: 'POST',
      url: `/messages/${question.id}/feedback`,
      headers: { cookie },
      payload: { feedback: 'useful' },
    });
    expect(onQuestion.statusCode).toBe(400);
  });

  it('refuses to ask in an archived space and keeps the thread readable', async () => {
    const space = await createSpace(app, cookie, 'Frozen space');
    await seedSource(app, space, {
      title: 'Frozen evidence',
      passages: [{ text: 'Recall accuracy dropped sharply.', page: 1 }],
    });
    const id = await createConversation(app, cookie, space);
    await ask(baseUrl, cookie, id, 'What happened to recall?');

    await app.inject({ method: 'POST', url: `/spaces/${space}/archive`, headers: { cookie } });

    // Asking creates rows, so it is a write (REQ-100). Refused before the hijack,
    // which is why `inject` sees the status at all.
    const asking = await app.inject({
      method: 'POST',
      url: `/conversations/${id}/messages`,
      headers: { cookie },
      payload: { question: 'Another question' },
    });
    expect(asking.statusCode).toBe(409);
    expect(asking.json()).toMatchObject({ error: { code: 'space_archived' } });

    // Changing scope is a write too.
    const patching = await app.inject({
      method: 'PATCH',
      url: `/conversations/${id}`,
      headers: { cookie },
      payload: { scopeType: 'space' },
    });
    expect(patching.statusCode).toBe(409);

    // Reading stays allowed.
    const thread = await app.inject({ method: 'GET', url: `/conversations/${id}`, headers: { cookie } });
    expect(thread.statusCode).toBe(200);
  });

  it('refuses a source scope whose source is not retrievable', async () => {
    const space = await createSpace(app, cookie, 'Unusable scope space');
    const seeded = await seedSource(app, space, {
      title: 'Archived scope',
      passages: [{ text: 'Recall accuracy dropped sharply.', page: 1 }],
    });
    const id = await createConversation(app, cookie, space, {
      scopeType: 'source',
      scopeSourceId: seeded.sourceId,
    });
    await app.inject({
      method: 'POST',
      url: `/sources/${seeded.sourceId}/archive`,
      headers: { cookie },
    });

    const asking = await app.inject({
      method: 'POST',
      url: `/conversations/${id}/messages`,
      headers: { cookie },
      payload: { question: 'What happened to recall?' },
    });
    // Refused, not answered with insufficiency: insufficiency means "we looked and
    // found nothing", which would be a lie about a source the user archived.
    expect(asking.statusCode).toBe(409);
    expect(asking.json()).toMatchObject({ error: { code: 'scope_not_retrievable' } });
  });

  it('answers 404 for another user’s conversation and message', async () => {
    const id = await createConversation(app, cookie, spaceId);
    await ask(baseUrl, cookie, id, 'What happened to recall accuracy?');
    const thread = await app.inject({ method: 'GET', url: `/conversations/${id}`, headers: { cookie } });
    const messageId = (thread.json() as { messages: { id: string }[] }).messages[0]!.id;

    const stranger = uniqueEmail('conversations-stranger');
    emails.push(stranger);
    const other = await registerUser(app, stranger);

    for (const url of [
      `/conversations/${id}`,
      `/spaces/${spaceId}/conversations`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: other.cookie } });
      // 404, never 403 — a 403 would confirm the id exists (§17).
      expect(response.statusCode).toBe(404);
    }

    const feedback = await app.inject({
      method: 'POST',
      url: `/messages/${messageId}/feedback`,
      headers: { cookie: other.cookie },
      payload: { feedback: 'useful' },
    });
    expect(feedback.statusCode).toBe(404);

    const asking = await app.inject({
      method: 'POST',
      url: `/conversations/${id}/messages`,
      headers: { cookie: other.cookie },
      payload: { question: 'Whose conversation is this?' },
    });
    expect(asking.statusCode).toBe(404);
  });

  it('leaves no orphan question when the SSE connection cap is hit', async () => {
    const space = await createSpace(app, cookie, 'Capped space');
    await seedSource(app, space, {
      title: 'Capped evidence',
      passages: [{ text: 'Recall accuracy dropped sharply.', page: 1 }],
    });
    const id = await createConversation(app, cookie, space);

    // Fill the per-user stream budget, as three open tabs would.
    const userId = (await app.prisma.conversation.findUniqueOrThrow({
      where: { id },
      select: { space: { select: { ownerId: true } } },
    })).space.ownerId;
    for (let i = 0; i < 3; i += 1) app.events.registerUserConnection(userId);

    try {
      const asking = await app.inject({
        method: 'POST',
        url: `/conversations/${id}/messages`,
        headers: { cookie },
        payload: { question: 'What happened to recall?' },
      });
      expect(asking.statusCode).toBe(429);

      // The question must not be stored: it would be an answerless orphan, and
      // every Retry would add another.
      expect(await app.prisma.message.count({ where: { conversationId: id } })).toBe(0);
    } finally {
      for (let i = 0; i < 3; i += 1) app.events.releaseUserConnection(userId);
    }
  });

  it('requires a question and caps its length', async () => {
    const id = await createConversation(app, cookie, spaceId);
    for (const question of ['', '   ', 'x'.repeat(2001)]) {
      const response = await app.inject({
        method: 'POST',
        url: `/conversations/${id}/messages`,
        headers: { cookie },
        payload: { question },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
