import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import { persistReady } from '../src/ingest/persist.js';

describe('notes and saved answers (Phase 5, PRD §10, §11, §12)', () => {
  let app: FastifyInstance;
  /** One registration shared by the extra review tests below — /auth/register
   * is capped at 10/minute per app instance (test/helpers.ts), so tests that do
   * not need isolation must reuse a user rather than register another. */
  let shared: { cookie: string; userId: string };
  const emails: string[] = [];

  const newUser = async () => {
    const email = uniqueEmail('notes');
    emails.push(email);
    const { cookie, userId } = await registerUser(app, email);
    return { cookie, userId };
  };

  const createSpace = async (cookie: string, name = 'Research Space') => {
    const res = await app.inject({
      method: 'POST',
      url: '/spaces',
      headers: { cookie },
      payload: { name },
    });
    return res.json().space;
  };

  beforeAll(async () => {
    app = await startTestApp();
    const registered = await registerUser(app, uniqueEmail('notes'));
    emails.push(registered.email);
    shared = { cookie: registered.cookie, userId: registered.userId };
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  // The queue enqueue-failure test stubs `ingestQueue.add`; a real worker is not
  // running, so a restored spy leaves every later enqueue on the real queue.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates, lists, retrieves, updates, and deletes manual notes', async () => {
    const { cookie, userId } = await newUser();
    const space = await createSpace(cookie);

    // Initial empty list
    const initial = await app.inject({
      method: 'GET',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().notes).toEqual([]);

    // Create note
    const created = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Initial working hypotheses',
        contentRich: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Participants may experience social withdrawal.' }],
            },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const note = created.json().note;
    expect(note.title).toBe('Initial working hypotheses');
    expect(note.originType).toBe('user');
    expect(note.originConversationId).toBeNull();
    expect(note.originMessageId).toBeNull();
    expect(note.citationCount).toBe(0);
    expect(note.convertedSource).toBeNull();

    // Verify activity recorded
    const createActivity = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'note.created' },
    });
    expect(createActivity).not.toBeNull();
    expect(createActivity?.refId).toBe(note.id);

    // Get note detail
    const detail = await app.inject({
      method: 'GET',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().note.id).toBe(note.id);

    // Update note
    const updated = await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: {
        title: 'Updated working hypotheses',
        contentRich: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Social withdrawal observed in 3 of 4 sites.' }],
            },
          ],
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().note.title).toBe('Updated working hypotheses');

    // List notes with search query
    const searchMatch = await app.inject({
      method: 'GET',
      url: `/spaces/${space.id}/notes?q=Updated`,
      headers: { cookie },
    });
    expect(searchMatch.statusCode).toBe(200);
    expect(searchMatch.json().notes.length).toBe(1);

    const searchMiss = await app.inject({
      method: 'GET',
      url: `/spaces/${space.id}/notes?q=NonExistentQuery`,
      headers: { cookie },
    });
    expect(searchMiss.statusCode).toBe(200);
    expect(searchMiss.json().notes.length).toBe(0);

    // Delete note
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(afterDelete.statusCode).toBe(404);

    const deleteActivity = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'note.deleted' },
    });
    expect(deleteActivity).not.toBeNull();
  });

  it('records note.edited activity coalesced within the window (REQ-271)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);

    const created = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: { title: 'Editable note', contentRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v1' }] }] } },
    });
    const note = created.json().note;

    // First edit — creates a new row
    await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: { title: 'Edited title' },
    });
    const firstEdit = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'note.edited', refId: note.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(firstEdit).not.toBeNull();

    // Second edit within the window — coalesced (bumps createdAt, no new row)
    const firstEditCreatedAt = firstEdit!.createdAt;
    await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: { contentRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v2' }] }] } },
    });
    const secondEdit = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'note.edited', refId: note.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(secondEdit).not.toBeNull();
    expect(secondEdit!.createdAt.getTime()).toBeGreaterThan(firstEditCreatedAt.getTime());

    // Only one row still
    const count = await app.prisma.activity.count({
      where: { userId, spaceId: space.id, kind: 'note.edited', refId: note.id },
    });
    expect(count).toBe(1);
  });

  it('records a second note.edited row after the coalesce window (REQ-272)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);

    const created = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: { title: 'Window test', contentRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v1' }] }] } },
    });
    const note = created.json().note;

    // Write an edit with an old timestamp (outside the window)
    await app.prisma.activity.create({
      data: { userId, spaceId: space.id, kind: 'note.edited', refId: note.id, createdAt: new Date(Date.now() - 20 * 60 * 1000) },
    });

    // Edit now — should be outside the window and create a second row
    await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: { title: 'Outside window' },
    });

    const count = await app.prisma.activity.count({
      where: { userId, spaceId: space.id, kind: 'note.edited', refId: note.id },
    });
    expect(count).toBe(2);
  });

  it('does not write note.edited when a PATCH changes nothing (REQ-273)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'same' }] }] };

    const created = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: { title: 'No-op note', contentRich: body },
    });
    const note = created.json().note;
    const where = { userId, spaceId: space.id, kind: 'note.edited', refId: note.id };

    // The editor saves on blur: the same title and the same document come back.
    const same = await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: { title: 'No-op note', contentRich: body },
    });
    expect(same.statusCode).toBe(200);
    expect(await app.prisma.activity.count({ where })).toBe(0);

    const changed = await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: { title: 'Renamed note' },
    });
    expect(changed.statusCode).toBe(200);
    expect(await app.prisma.activity.count({ where })).toBe(1);
  });

  it('records note.converted activity alongside source.added (REQ-274)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Convert me to a source',
        contentRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Convert this note into a source for later retrieval.' }] }] },
      },
    });
    const note = noteRes.json().note;

    await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });

    const convertedActivity = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'note.converted', refId: note.id },
    });
    expect(convertedActivity).not.toBeNull();

    // Both kinds should exist
    const sourceAdded = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'source.added' },
    });
    expect(sourceAdded).not.toBeNull();
  });

  it('saves an assistant answer as a note with citations and prevents duplicate saves (PRD §10)', async () => {
    const { cookie, userId } = await newUser();
    const space = await createSpace(cookie);

    // Seed a source and passage for citation
    const source = await app.prisma.source.create({
      data: {
        spaceId: space.id,
        type: 'manual',
        title: 'Consent Practices Protocol',
        content: 'Participants described withdrawal as socially costly.',
        state: 'ready',
      },
    });

    const passage = await app.prisma.passage.create({
      data: {
        sourceId: source.id,
        ord: 1,
        text: 'Participants described withdrawal as socially costly.',
        page: 7,
        paragraphRef: 'p1',
      },
    });

    // Create conversation and messages
    // Fixtures bypass the API, so they must say whose thread this is —
    // conversations are private to their member (shared-spaces-v1).
    const conversation = await app.prisma.conversation.create({
      data: {
        spaceId: space.id,
        userId,
        title: 'Consent Q&A',
        scopeType: 'space',
      },
    });

    const userMessage = await app.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: 'What did participants say about withdrawing from the study?',
      },
    });

    const assistantMessage = await app.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Participants described withdrawal as socially costly [1].',
        citations: {
          create: [
            {
              sourceId: source.id,
              passageId: passage.id,
              quotedText: 'Participants described withdrawal as socially costly.',
              page: 7,
              paragraphRef: 'p1',
            },
          ],
        },
      },
    });

    // Attempt to save user turn -> bad request
    const saveUserTurn = await app.inject({
      method: 'POST',
      url: `/messages/${userMessage.id}/save-as-note`,
      headers: { cookie },
    });
    expect(saveUserTurn.statusCode).toBe(400);
    expect(saveUserTurn.json().error.code).toBe('not_an_assistant_message');

    // Save assistant answer as note
    const saved = await app.inject({
      method: 'POST',
      url: `/messages/${assistantMessage.id}/save-as-note`,
      headers: { cookie },
    });
    expect(saved.statusCode).toBe(201);
    const note = saved.json().note;
    expect(note.originType).toBe('saved_answer');
    expect(note.originConversationId).toBe(conversation.id);
    expect(note.originMessageId).toBe(assistantMessage.id);
    expect(note.title).toBe('What did participants say about withdrawing from the study?');
    expect(note.citationCount).toBe(1);
    expect(note.citations[0].sourceTitle).toBe('Consent Practices Protocol');
    expect(note.citations[0].page).toBe(7);

    // Verify activity recorded
    const saveActivity = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'note.saved_answer' },
    });
    expect(saveActivity).not.toBeNull();
    expect(saveActivity?.refId).toBe(note.id);

    // Saving the same answer a second time is rejected with 409 conflict (PRD §10 anti-duplication)
    const duplicate = await app.inject({
      method: 'POST',
      url: `/messages/${assistantMessage.id}/save-as-note`,
      headers: { cookie },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('note_already_saved');
  });

  it('converts a note to a manual source snapshot idempotently (PRD §12)', async () => {
    const { cookie } = await newUser();
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Synthesis on Fieldwork Obstacles',
        contentRich: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Field researchers faced delays securing local government clearances across 3 regions.',
                },
              ],
            },
          ],
        },
      },
    });
    expect(noteRes.statusCode).toBe(201);
    const note = noteRes.json().note;

    // Convert note to source
    const convertRes = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
      payload: { title: 'Fieldwork Obstacles Evidence' },
    });
    expect(convertRes.statusCode).toBe(201);
    const source = convertRes.json().source;
    expect(source.type).toBe('manual');
    expect(source.title).toBe('Fieldwork Obstacles Evidence');
    expect(source.author).toBe('User note');
    expect(source.state).toBe('processing');

    // Note detail now reflects the converted source
    const detailAfter = await app.inject({
      method: 'GET',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(detailAfter.json().note.convertedSource.id).toBe(source.id);

    // Converting again returns the existing source without creating a duplicate (PRD §12 idempotency)
    const convertAgain = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    expect(convertAgain.statusCode).toBe(200);
    expect(convertAgain.json().source.id).toBe(source.id);

    // Snapshot behavior: updating the note afterwards does NOT alter the created source
    await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: {
        title: 'Modified Note Title',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Brand new text.' }] }],
        },
      },
    });

    const sourceDetail = await app.inject({
      method: 'GET',
      url: `/sources/${source.id}`,
      headers: { cookie },
    });
    expect(sourceDetail.json().source.title).toBe('Fieldwork Obstacles Evidence');
  });

  it('enforces ownership across all note routes (PRD §17)', async () => {
    const userA = await newUser();
    const userB = await newUser();

    const spaceA = await createSpace(userA.cookie, 'User A Space');
    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceA.id}/notes`,
      headers: { cookie: userA.cookie },
      payload: { title: 'Secret Note' },
    });
    const note = noteRes.json().note;

    // User B attempting to access User A's space/note receives 404
    const list = await app.inject({
      method: 'GET',
      url: `/spaces/${spaceA.id}/notes`,
      headers: { cookie: userB.cookie },
    });
    expect(list.statusCode).toBe(404);

    const get = await app.inject({
      method: 'GET',
      url: `/notes/${note.id}`,
      headers: { cookie: userB.cookie },
    });
    expect(get.statusCode).toBe(404);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie: userB.cookie },
      payload: { title: 'Hacked' },
    });
    expect(patch.statusCode).toBe(404);

    const convert = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie: userB.cookie },
    });
    expect(convert.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/notes/${note.id}`,
      headers: { cookie: userB.cookie },
    });
    expect(del.statusCode).toBe(404);
  });

  it('enforces archived space write guards on notes', async () => {
    const { cookie } = await newUser();
    const space = await createSpace(cookie, 'Space to Archive');

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Pre-archive note',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Some text.' }] }],
        },
      },
    });
    const note = noteRes.json().note;

    // Archive space
    await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/archive`,
      headers: { cookie },
    });

    // Create note in archived space -> 409 conflict
    const createInArchived = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: { title: 'Forbidden Note' },
    });
    expect(createInArchived.statusCode).toBe(409);

    // Update note in archived space -> 409 conflict
    const patchInArchived = await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: { title: 'Modified' },
    });
    expect(patchInArchived.statusCode).toBe(409);

    // Convert note in archived space -> 409 conflict
    const convertInArchived = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    expect(convertInArchived.statusCode).toBe(409);

    // Read and Delete remain allowed in archived space
    const getInArchived = await app.inject({
      method: 'GET',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(getInArchived.statusCode).toBe(200);

    const deleteInArchived = await app.inject({
      method: 'DELETE',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(deleteInArchived.statusCode).toBe(204);
  });

  it('marks note citations stale when underlying source passages change (PRD §10)', async () => {
    const { cookie, userId } = await newUser();
    const space = await createSpace(cookie);

    const source = await app.prisma.source.create({
      data: {
        spaceId: space.id,
        type: 'manual',
        title: 'Original Source',
        content: 'Initial text that will be reprocessed.',
        state: 'ready',
      },
    });

    const note = await app.prisma.note.create({
      data: {
        spaceId: space.id,
        title: 'Saved answer note',
        contentRich: { type: 'doc', content: [{ type: 'paragraph' }] },
        originType: 'saved_answer',
        citations: {
          create: [
            {
              sourceId: source.id,
              quotedText: 'Specific sentence that disappears during reprocess.',
              stale: false,
            },
          ],
        },
      },
    });

    // Reprocess source without the quoted text
    const mockEmbed = async (texts: string[]) => texts.map(() => new Array(768).fill(0.01));
    await persistReady(
      app.prisma,
      { embed: mockEmbed },
      {
        sourceId: source.id,
        userId,
        spaceId: space.id,
        content: 'Completely different content.',
        blocks: [{ text: 'Completely different content.' }],
        passages: [
          {
            text: 'Completely different content.',
            page: 1,
            paragraphRef: null,
            sectionHeading: null,
            startBlockOrd: 1,
            endBlockOrd: 1,
          },
        ],
      },
    );

    // Note's citation is now marked stale
    const updatedNote = await app.inject({
      method: 'GET',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(updatedNote.statusCode).toBe(200);
    const citations = updatedNote.json().note.citations;
    expect(citations.length).toBe(1);
    expect(citations[0].stale).toBe(true);
  });

  it('answers 409 — never 500 — when two concurrent save-as-note calls race the unique constraint (PRD §11)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);

    const conversation = await app.prisma.conversation.create({
      data: { spaceId: space.id, userId, title: 'Concurrent save', scopeType: 'space' },
    });
    const message = await app.prisma.message.create({
      data: { conversationId: conversation.id, role: 'assistant', content: 'A concurrent answer.' },
    });

    const save = () =>
      app.inject({
        method: 'POST',
        url: `/messages/${message.id}/save-as-note`,
        headers: { cookie },
      });

    const [a, b] = await Promise.all([save(), save()]);

    // Exactly one inserts; the loser answers 409 whether it trips the pre-check
    // or, under a genuine race, the P2002 constraint catch. A 500 would leak the
    // constraint and break the client's double-click handling.
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });

  it('answers 200/201 — never 500 — when two concurrent convert calls race the unique originNoteId', async () => {
    const { cookie } = shared;
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Concurrent convert note',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Race me.' }] }],
        },
      },
    });
    const note = noteRes.json().note;

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/notes/${note.id}/convert-to-source`, headers: { cookie } }),
      app.inject({ method: 'POST', url: `/notes/${note.id}/convert-to-source`, headers: { cookie } }),
    ]);

    // One creates the source (201). The loser must not 500: it either gets the
    // existing source back from the P2002 catch (200) or from the idempotent
    // branch once the winner has committed.
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(201);
  });

  it('rejects converting a note with no extractable text (400 empty_note_content)', async () => {
    const { cookie } = shared;
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: { title: 'Empty note', contentRich: { type: 'doc', content: [] } },
    });
    expect(noteRes.statusCode).toBe(201);
    const note = noteRes.json().note;

    const res = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('empty_note_content');
  });

  it('rejects converting a note over manual_max_chars (400 manual_too_long)', async () => {
    const { cookie } = shared;
    const space = await createSpace(cookie);

    const longText = 'word '.repeat(30_000); // ~150k chars, above the 100k default
    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Oversized note',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }],
        },
      },
    });
    expect(noteRes.statusCode).toBe(201);
    const note = noteRes.json().note;

    const res = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('manual_too_long');
    expect(res.json().error.fields.content).toMatch(/limited to/);
  });

  it('rejects converting at sources_per_space (409 sources_limit)', async () => {
    const { cookie } = shared;
    const space = await createSpace(cookie);

    // Fill the space to the default cap. Inserting rows directly skips the
    // queue, which is irrelevant to the per-space count the guard reads.
    await app.prisma.source.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        spaceId: space.id,
        type: 'manual',
        title: `Filler source ${i}`,
        content: `filler ${i}`,
        state: 'ready',
      })),
    });

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'One more would be one too many',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fits right in.' }] }],
        },
      },
    });
    const note = noteRes.json().note;

    const res = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('sources_limit');
  });

  it('marks the converted source failed when the ingest queue rejects enqueue', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Queue-down note',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Enqueue me.' }] }],
        },
      },
    });
    const note = noteRes.json().note;

    vi.spyOn(app.ingestQueue, 'add').mockRejectedValueOnce(new Error('redis is down'));

    const res = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    // The response is still 201 — the queue failure is written to the source,
    // not thrown at the client — and the row itself carries the failure.
    expect(res.statusCode).toBe(201);
    const sourceId = res.json().source.id;
    expect(res.json().source.state).toBe('failed');
    expect(res.json().source.errorMessage).toMatch(/Processing could not be started/);

    const row = await app.prisma.source.findUnique({ where: { id: sourceId } });
    expect(row?.state).toBe('failed');
    expect(row?.errorMessage).toContain('Processing could not be started');

    const activity = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id, kind: 'source.failed', refId: sourceId },
    });
    expect(activity).not.toBeNull();
  });

  it('refuses to save a user-role message as a note (REQ-206)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);

    const conversation = await app.prisma.conversation.create({
      data: { spaceId: space.id, userId, title: 'User turn', scopeType: 'space' },
    });
    const userMessage = await app.prisma.message.create({
      data: { conversationId: conversation.id, role: 'user', content: 'A question, not an answer.' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/messages/${userMessage.id}/save-as-note`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_assistant_message');
  });

  it('rejects converting a note nested too deeply to walk (400 note_too_deep)', async () => {
    const { cookie } = shared;
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: { title: 'Deeply nested note' },
    });
    const note = noteRes.json().note;

    // A chain >100 levels deep that still fits the body limit — the one shape
    // the depth-bound exists to absorb instead of a stack overflow.
    const deep: { type: string; content: unknown[] } = { type: 'doc', content: [] };
    let node = deep;
    for (let i = 0; i < 150; i++) {
      const next = { type: 'paragraph', content: [] };
      node.content.push(next);
      node = next;
    }

    const patched = await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: { cookie },
      payload: { contentRich: deep },
    });
    expect(patched.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('note_too_deep');
  });

  it('retries a failed conversion by reusing the source row — citations survive and it works at sources_per_space (REQ-219)', async () => {
    const { cookie } = shared;
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Retry me',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retry text.' }] }],
        },
      },
    });
    const note = noteRes.json().note;

    const converted = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    expect(converted.statusCode).toBe(201);
    const sourceId = converted.json().source.id;

    // The saved answer's citations reference the converted source, exactly as
    // §10 would if a later answer cited its passage. Deleting this source on a
    // retry would cascade them away (PRD §6/§10).
    await app.prisma.citation.create({
      data: {
        sourceId,
        noteId: note.id,
        quotedText: 'Retry text.',
        page: 1,
        paragraphRef: 'p1',
        stale: false,
      },
    });

    // The first processing run failed, leaving the source row failed.
    await app.prisma.source.update({
      where: { id: sourceId },
      data: { state: 'failed', errorMessage: 'Embedding service unavailable.' },
    });

    // Fill the space to sources_per_space, so only the net-neutral retry can go.
    await app.prisma.source.createMany({
      data: Array.from({ length: 49 }, (_, i) => ({
        spaceId: space.id,
        type: 'manual',
        title: `Filler ${i}`,
        content: `filler ${i}`,
        state: 'ready',
      })),
    });

    const retry = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    // Reuses the row: same id, 201, net-neutral at the cap.
    expect(retry.statusCode).toBe(201);
    expect(retry.json().source.id).toBe(sourceId);

    // The citation still points at the same source — nothing was cascaded away.
    const citation = await app.prisma.citation.findFirst({ where: { sourceId } });
    expect(citation).not.toBeNull();
    expect(citation?.quotedText).toBe('Retry text.');

    const noteDetail = await app.inject({
      method: 'GET',
      url: `/notes/${note.id}`,
      headers: { cookie },
    });
    expect(noteDetail.json().note.convertedSource?.id).toBe(sourceId);
  });

  it('enqueues once when two concurrent retries race a failed conversion (REQ-218)', async () => {
    const { cookie } = shared;
    const space = await createSpace(cookie);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/notes`,
      headers: { cookie },
      payload: {
        title: 'Concurrent retry note',
        contentRich: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retry me twice.' }] }],
        },
      },
    });
    const note = noteRes.json().note;

    const converted = await app.inject({
      method: 'POST',
      url: `/notes/${note.id}/convert-to-source`,
      headers: { cookie },
    });
    const sourceId = converted.json().source.id;

    await app.prisma.source.update({
      where: { id: sourceId },
      data: { state: 'failed', errorMessage: 'Embedding service unavailable.' },
    });

    // Both racers read `state: 'failed'` before either writes. Only the one that
    // claims the row may touch the queue: the loser's `remove()` would otherwise
    // delete the settled-job slot the winner just filled, leaving the source in
    // `processing` with no job coming (the trap `/sources/:id/retry` documents).
    const addSpy = vi.spyOn(app.ingestQueue, 'add');

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/notes/${note.id}/convert-to-source`, headers: { cookie } }),
      app.inject({ method: 'POST', url: `/notes/${note.id}/convert-to-source`, headers: { cookie } }),
    ]);

    // The claimer answers 201 reusing the row (REQ-219); the loser answers 200,
    // exactly as the idempotent branch and the P2002 loser do. Neither 500s.
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().source.id).toBe(sourceId);
    expect(b.json().source.id).toBe(sourceId);

    // One claim, one enqueue — the guard, not the queue, is what holds this.
    expect(addSpy).toHaveBeenCalledTimes(1);

    const row = await app.prisma.source.findUnique({ where: { id: sourceId } });
    expect(row?.state).toBe('processing');
    expect(row?.errorMessage).toBeNull();
  });
});
