import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { assertAccess } from '../src/middleware/assert-access.js';
import { cleanupUsers, registerUser, startTestApp, uniqueEmail } from './helpers.js';

/**
 * PRD §17 kept under shared spaces: a request from outside the space is answered
 * 404, not 403 — a 403 would confirm the id exists. A *member* below the role a
 * route needs is 403 (plan/shared-spaces-v1/design.md "Access").
 */
describe('assertAccess', () => {
  let app: FastifyInstance;
  const emails: string[] = [];

  let ownerCookie = '';
  let editorCookie = '';
  let viewerCookie = '';
  let intruderCookie = '';
  let ownerId = '';
  let viewerId = '';
  let spaceId = '';
  let noteId = '';
  let ownerConversationId = '';

  beforeAll(async () => {
    // Throwaway routes so the middleware is exercised exactly as real routes will.
    app = await startTestApp((instance) => {
      instance.get(
        '/test/spaces/:id',
        { preHandler: [instance.requireUser, assertAccess('space', 'id')] },
        async (request, reply) => reply.send({ ok: true, access: request.access }),
      );
      instance.post(
        '/test/spaces/:id/write',
        { preHandler: [instance.requireUser, assertAccess('space', 'id', 'editor')] },
        async (_request, reply) => reply.send({ ok: true }),
      );
      instance.post(
        '/test/spaces/:id/own',
        { preHandler: [instance.requireUser, assertAccess('space', 'id', 'owner')] },
        async (_request, reply) => reply.send({ ok: true }),
      );
      instance.get(
        '/test/notes/:noteId',
        { preHandler: [instance.requireUser, assertAccess('note', 'noteId')] },
        async (_request, reply) => reply.send({ ok: true }),
      );
      instance.get(
        '/test/conversations/:id',
        { preHandler: [instance.requireUser, assertAccess('conversation', 'id')] },
        async (_request, reply) => reply.send({ ok: true }),
      );
    });

    const users = await Promise.all(
      ['owner', 'editor', 'viewer', 'intruder'].map(async (prefix) => {
        const email = uniqueEmail(prefix);
        emails.push(email);
        return registerUser(app, email);
      }),
    );
    const [owner, editor, viewer, intruder] = users as [
      (typeof users)[number],
      (typeof users)[number],
      (typeof users)[number],
      (typeof users)[number],
    ];
    ownerCookie = owner.cookie;
    editorCookie = editor.cookie;
    viewerCookie = viewer.cookie;
    intruderCookie = intruder.cookie;
    ownerId = owner.userId;
    viewerId = viewer.userId;

    const space = await app.prisma.space.create({
      data: {
        ownerId: owner.userId,
        name: 'Shared space',
        members: {
          create: [
            { userId: owner.userId, role: 'owner' },
            { userId: editor.userId, role: 'editor' },
            { userId: viewer.userId, role: 'viewer' },
          ],
        },
      },
    });
    spaceId = space.id;

    const note = await app.prisma.note.create({
      data: { spaceId: space.id, title: 'A note', contentRich: {}, authorId: owner.userId },
    });
    noteId = note.id;

    const conversation = await app.prisma.conversation.create({
      data: { spaceId: space.id, userId: owner.userId, title: 'Owner thread', scopeType: 'space' },
    });
    ownerConversationId = conversation.id;
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, cookie: string) => app.inject({ method: 'POST', url, headers: { cookie } });

  it('lets every member read, and records the role on the request', async () => {
    for (const [cookie, role] of [
      [ownerCookie, 'owner'],
      [editorCookie, 'editor'],
      [viewerCookie, 'viewer'],
    ] as const) {
      const response = await get(`/test/spaces/${spaceId}`, cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json().access).toEqual({ spaceId, role });
    }
  });

  it('answers 404 for a non-member — the same body as a space that does not exist', async () => {
    const foreign = await get(`/test/spaces/${spaceId}`, intruderCookie);
    const missing = await get('/test/spaces/clzzzzzzzzzzzzzzzzzzzzzzz', ownerCookie);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('not_found');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());
  });

  it('answers 403 insufficient_role for a member below the route role', async () => {
    const viewerWrite = await post(`/test/spaces/${spaceId}/write`, viewerCookie);
    expect(viewerWrite.statusCode).toBe(403);
    expect(viewerWrite.json().error.code).toBe('insufficient_role');
    expect(JSON.stringify(viewerWrite.json())).not.toContain(spaceId);

    const editorWrite = await post(`/test/spaces/${spaceId}/write`, editorCookie);
    expect(editorWrite.statusCode).toBe(200);

    const editorOwn = await post(`/test/spaces/${spaceId}/own`, editorCookie);
    expect(editorOwn.statusCode).toBe(403);
    const ownerOwn = await post(`/test/spaces/${spaceId}/own`, ownerCookie);
    expect(ownerOwn.statusCode).toBe(200);
  });

  it('never answers 403 to a non-member, even on a write route', async () => {
    const response = await post(`/test/spaces/${spaceId}/write`, intruderCookie);
    expect(response.statusCode).toBe(404);
  });

  it('resolves membership through the space for nested resources', async () => {
    expect((await get(`/test/notes/${noteId}`, viewerCookie)).statusCode).toBe(200);
    expect((await get(`/test/notes/${noteId}`, intruderCookie)).statusCode).toBe(404);
  });

  it("answers 404 for another member's conversation — private, not merely forbidden", async () => {
    expect((await get(`/test/conversations/${ownerConversationId}`, ownerCookie)).statusCode).toBe(200);
    const asEditor = await get(`/test/conversations/${ownerConversationId}`, editorCookie);
    expect(asEditor.statusCode).toBe(404);
    expect(asEditor.json().error.code).toBe('not_found');
  });

  it('answers 404 once a membership row is gone', async () => {
    await app.prisma.spaceMember.delete({ where: { spaceId_userId: { spaceId, userId: viewerId } } });
    expect((await get(`/test/spaces/${spaceId}`, viewerCookie)).statusCode).toBe(404);
    await app.prisma.spaceMember.create({ data: { spaceId, userId: viewerId, role: 'viewer' } });
    expect(ownerId).toBeTruthy();
  });

  it('answers 401 without a session, before any lookup', async () => {
    const response = await app.inject({ method: 'GET', url: `/test/spaces/${spaceId}` });
    expect(response.statusCode).toBe(401);
  });
});
