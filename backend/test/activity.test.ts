import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, registerUser, startTestApp, uniqueEmail } from './helpers.js';

/**
 * Phase 7: Activity feed (PRD §15).
 *
 * Design: GET /activity?limit=&cursor= — user-scoped, cursor-paginated, newest
 * first. Each row resolves its target at read time; href per kind from design.md.
 */
describe('GET /activity', () => {
  let app: FastifyInstance;
  const emails: string[] = [];
  /** `/auth/register` allows ten per minute per app; tests that do not need an isolated user share this one. */
  let shared: { cookie: string; userId: string };

  const newUser = async () => {
    const email = uniqueEmail('activity');
    emails.push(email);
    return registerUser(app, email);
  };

  const createSpace = async (cookie: string, name = 'Activity Space') => {
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
    shared = await newUser();
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('returns the signed-in user activity newest first (REQ-263)', async () => {
    const { cookie, userId } = await newUser();
    const space = await createSpace(cookie);

    const a1 = await app.prisma.activity.create({
      data: { userId, spaceId: space.id, kind: 'test.event', refId: 'n1', createdAt: new Date('2026-08-01T10:00:00Z') },
    });
    const a2 = await app.prisma.activity.create({
      data: { userId, spaceId: space.id, kind: 'test.event', refId: 'n2', createdAt: new Date('2026-08-01T11:00:00Z') },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/activity',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Filter to just our test events (ignore space.created from createSpace)
    const testItems = body.items.filter((i: { kind: string }) => i.kind === 'test.event');
    expect(testItems).toHaveLength(2);
    expect(testItems[0].id).toBe(a2.id);
    expect(testItems[1].id).toBe(a1.id);
  });

  it('never returns another user activity (REQ-264)', async () => {
    const userA = await newUser();
    const userB = await newUser();
    const spaceA = await createSpace(userA.cookie);
    const spaceB = await createSpace(userB.cookie);

    await app.prisma.activity.create({
      data: { userId: userA.userId, spaceId: spaceA.id, kind: 'test.event', refId: 'ta' },
    });
    await app.prisma.activity.create({
      data: { userId: userB.userId, spaceId: spaceB.id, kind: 'test.event', refId: 'tb' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/activity',
      headers: { cookie: userA.cookie },
    });

    expect(res.statusCode).toBe(200);
    // Filter to our test events
    const testItems = res.json().items.filter((i: { kind: string }) => i.kind === 'test.event');
    expect(testItems).toHaveLength(1);
    // The target should be null since no actual refId target was created
    expect(testItems[0].target).toBeNull();
  });

  it('paginates with cursor without skip or repeat (REQ-265)', async () => {
    const { cookie, userId } = await newUser();
    // Create space to enable activity to be linked to a space
    const space = await createSpace(cookie);

    // Clean up any auto-created activities
    await app.prisma.activity.deleteMany({ where: { userId } });

    // Insert three rows at known timestamps
    for (let i = 0; i < 3; i++) {
      await app.prisma.activity.create({
        data: {
          userId,
          spaceId: space.id,
          kind: 'test.event',
          refId: `n${i}`,
          createdAt: new Date(`2026-08-01T${10 + i}:00:00Z`),
        },
      });
    }

    // First page: limit=2
    const page1 = await app.inject({
      method: 'GET',
      url: '/activity?limit=2',
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();

    // Second page using cursor
    const page2 = await app.inject({
      method: 'GET',
      url: `/activity?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`,
      headers: { cookie },
    });
    expect(page2.statusCode).toBe(200);
    const p2 = page2.json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();

    // No overlap: ids from page1 and page2 are distinct
    const ids1 = new Set(p1.items.map((i: { id: string }) => i.id));
    const ids2 = new Set(p2.items.map((i: { id: string }) => i.id));
    const intersection = [...ids1].filter((id) => ids2.has(id));
    expect(intersection).toHaveLength(0);
  });

  it('a row inserted between pages neither repeats nor skips an entry (REQ-265)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);
    await app.prisma.activity.deleteMany({ where: { userId } });

    const rows = [];
    for (let i = 0; i < 3; i++) {
      rows.push(
        await app.prisma.activity.create({
          data: { userId, spaceId: space.id, kind: 'test.event', refId: `n${i}`, createdAt: new Date(`2026-08-01T${10 + i}:00:00Z`) },
        }),
      );
    }
    const [oldest] = rows;

    const page1 = (await app.inject({ method: 'GET', url: '/activity?limit=2', headers: { cookie } })).json();
    expect(page1.items.map((i: { id: string }) => i.id)).toEqual([rows[2]!.id, rows[1]!.id]);

    // Something happens while the user is looking at page 1: an offset would
    // now hand `rows[1]` back a second time; the cursor must not.
    const late = await app.prisma.activity.create({
      data: { userId, spaceId: space.id, kind: 'test.event', refId: 'late', createdAt: new Date('2026-08-02T00:00:00Z') },
    });

    const page2 = (
      await app.inject({ method: 'GET', url: `/activity?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, headers: { cookie } })
    ).json();
    expect(page2.items.map((i: { id: string }) => i.id)).toEqual([oldest!.id]);
    expect(page2.nextCursor).toBeNull();

    // The late row is the newest thing on a fresh first page.
    const fresh = (await app.inject({ method: 'GET', url: '/activity?limit=1', headers: { cookie } })).json();
    expect(fresh.items[0].id).toBe(late.id);
  });

  it('clamps limit to 1–50 instead of rejecting it', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);
    await app.prisma.activity.deleteMany({ where: { userId } });
    await app.prisma.activity.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({ userId, spaceId: space.id, kind: 'test.event', refId: `c${i}` })),
    });

    const zero = await app.inject({ method: 'GET', url: '/activity?limit=0', headers: { cookie } });
    expect(zero.statusCode).toBe(200);
    expect(zero.json().items).toHaveLength(1);

    const huge = await app.inject({ method: 'GET', url: '/activity?limit=100', headers: { cookie } });
    expect(huge.statusCode).toBe(200);
    expect(huge.json().items).toHaveLength(3);
    expect(huge.json().nextCursor).toBeNull();
  });

  it('returns correct href per kind (REQ-266)', async () => {
    const { cookie, userId } = await newUser();
    const space = await createSpace(cookie);

    const source = await app.prisma.source.create({
      data: { spaceId: space.id, type: 'manual', title: 'Test Source', content: 'test', state: 'ready' },
    });
    const note = await app.prisma.note.create({
      data: { spaceId: space.id, title: 'Test Note', contentRich: {} },
    });

    await app.prisma.activity.createMany({
      data: [
        { userId, spaceId: space.id, kind: 'space.created', refId: null },
        { userId, spaceId: space.id, kind: 'source.added', refId: source.id },
        { userId, spaceId: space.id, kind: 'source.ready', refId: source.id },
        { userId, spaceId: space.id, kind: 'source.failed', refId: source.id },
        { userId, spaceId: space.id, kind: 'note.saved_answer', refId: note.id },
        { userId, spaceId: space.id, kind: 'note.converted', refId: note.id },
        { userId, spaceId: space.id, kind: 'note.created', refId: note.id },
        { userId, spaceId: space.id, kind: 'note.edited', refId: note.id },
        { userId, spaceId: space.id, kind: 'note.deleted', refId: note.id },
        { userId, spaceId: space.id, kind: 'notebook.exported', refId: space.id },
      ],
    });

    await app.prisma.notebook.upsert({
      where: { spaceId: space.id },
      create: { spaceId: space.id, contentRich: {} },
      update: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: '/activity',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.length).toBeGreaterThanOrEqual(10);

    const byKind = (kind: string) => items.find((i: { kind: string }) => i.kind === kind);

    expect(byKind('space.created').href).toBe(`/spaces/${space.id}`);
    expect(byKind('source.added').href).toBe(`/spaces/${space.id}/sources/${source.id}`);
    expect(byKind('source.ready').href).toBe(`/spaces/${space.id}/sources/${source.id}`);
    expect(byKind('source.failed').href).toBe(`/spaces/${space.id}/sources/${source.id}`);
    expect(byKind('note.saved_answer').href).toBe(`/spaces/${space.id}/notes?noteId=${note.id}`);
    expect(byKind('note.converted').href).toBe(`/spaces/${space.id}/notes?noteId=${note.id}`);
    expect(byKind('note.created').href).toBe(`/spaces/${space.id}/notes?noteId=${note.id}`);
    expect(byKind('note.edited').href).toBe(`/spaces/${space.id}/notes?noteId=${note.id}`);
    expect(byKind('note.deleted').href).toBe(`/spaces/${space.id}/notes`);
    expect(byKind('notebook.exported').href).toBe(`/spaces/${space.id}/notebook`);
  });

  it('returns space link when target is deleted (REQ-267)', async () => {
    const { cookie, userId } = await newUser();
    const space = await createSpace(cookie);

    const note = await app.prisma.note.create({
      data: { spaceId: space.id, title: 'Gone Note', contentRich: {} },
    });

    await app.prisma.activity.create({
      data: { userId, spaceId: space.id, kind: 'note.created', refId: note.id },
    });

    await app.prisma.note.delete({ where: { id: note.id } });

    const res = await app.inject({
      method: 'GET',
      url: '/activity',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    // Design: a target that is gone renders greyed with the space link only.
    expect(item.target).toBeNull();
    expect(item.space).not.toBeNull();
    expect(item.href).toBe(`/spaces/${space.id}`);
  });

  it('a permanently deleted source keeps its entries, linked to the space only (REQ-267)', async () => {
    const { cookie, userId } = shared;
    const space = await createSpace(cookie);
    const source = await app.prisma.source.create({
      data: { spaceId: space.id, type: 'manual', title: 'Gone Source', content: 'gone', state: 'ready' },
    });
    await app.prisma.activity.createMany({
      data: [
        { userId, spaceId: space.id, kind: 'source.added', refId: source.id },
        { userId, spaceId: space.id, kind: 'source.ready', refId: source.id },
      ],
    });
    await app.prisma.source.delete({ where: { id: source.id } });

    const res = await app.inject({ method: 'GET', url: '/activity', headers: { cookie } });
    const gone = res.json().items.filter((i: { kind: string }) => i.kind.startsWith('source.'));
    expect(gone).toHaveLength(2);
    for (const item of gone) {
      expect(item.target).toBeNull();
      expect(item.href).toBe(`/spaces/${space.id}`);
    }
  });

  it('archived space stays linkable (REQ-268)', async () => {
    const { cookie, userId } = await newUser();
    const space = await createSpace(cookie);

    await app.prisma.space.update({ where: { id: space.id }, data: { archivedAt: new Date() } });

    await app.prisma.activity.create({
      data: { userId, spaceId: space.id, kind: 'space.created' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/activity',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    expect(item.space.archivedAt).not.toBeNull();
    expect(item.href).toBe(`/spaces/${space.id}`);
  });

  it('rejects malformed cursor with 400 (REQ-269)', async () => {
    const { cookie } = shared;

    const res = await app.inject({
      method: 'GET',
      url: '/activity?cursor=not-a-valid-cursor',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_cursor');
  });

  it('requires authentication (REQ-270)', async () => {
    const res = await app.inject({ method: 'GET', url: '/activity' });
    expect(res.statusCode).toBe(401);
  });

});

