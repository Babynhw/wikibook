import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, registerUser, startTestApp, uniqueEmail } from './helpers.js';

/** REQ-055 … REQ-069 (PRD §4 acceptance criteria), through the HTTP layer. */
describe('spaces', () => {
  let app: FastifyInstance;
  const emails: string[] = [];

  /** Registers a throwaway user whose rows the suite cleans up afterwards. */
  const newUser = async () => {
    const email = uniqueEmail('space');
    emails.push(email);
    const { cookie, userId } = await registerUser(app, email);
    return { cookie, userId };
  };

  const createSpace = async (cookie: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/spaces',
      headers: { cookie },
      payload: { name: 'Sleep and memory', ...payload },
    });

  const listSpaces = async (cookie: string, filter?: 'active' | 'archived') =>
    app.inject({
      method: 'GET',
      url: filter ? `/spaces?filter=${filter}` : '/spaces',
      headers: { cookie },
    });

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('creates a space, adds it to the list, and records the activity', async () => {
    const { cookie, userId } = await newUser();

    const empty = await listSpaces(cookie);
    expect(empty.statusCode).toBe(200);
    expect(empty.json().spaces).toEqual([]);

    const created = await createSpace(cookie, { objective: 'How does sleep consolidate memory?' });
    expect(created.statusCode).toBe(201);
    const space = created.json().space;
    expect(space.name).toBe('Sleep and memory');
    expect(space.objective).toBe('How does sleep consolidate memory?');
    expect(space.archivedAt).toBeNull();
    expect(space.lastOpenedAt).toBeNull();
    expect(space.sourceCount).toBe(0);
    expect(space.noteCount).toBe(0);

    const list = await listSpaces(cookie);
    expect(list.json().spaces.map((s: { id: string }) => s.id)).toEqual([space.id]);

    const activity = await app.prisma.activity.findFirst({
      where: { userId, spaceId: space.id },
    });
    expect(activity?.kind).toBe('space.created');
  });

  it('requires a name and treats the objective as optional', async () => {
    const { cookie } = await newUser();

    const noName = await createSpace(cookie, { name: '   ' });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe('validation_failed');

    const noObjective = await createSpace(cookie, { name: '  Trimmed name  ' });
    expect(noObjective.statusCode).toBe(201);
    expect(noObjective.json().space.name).toBe('Trimmed name');
    expect(noObjective.json().space.objective).toBeNull();

    // A blank objective is "not set", not a set-but-empty string.
    const blankObjective = await createSpace(cookie, { name: 'Another', objective: '  ' });
    expect(blankObjective.json().space.objective).toBeNull();

    // Upper bounds, and the field message that has to reach the form (PRD §16).
    const longName = await createSpace(cookie, { name: 'x'.repeat(121) });
    expect(longName.statusCode).toBe(400);
    expect(longName.json().error.fields.name).toBe('Use at most 120 characters.');
    expect((await createSpace(cookie, { name: 'x'.repeat(120) })).statusCode).toBe(201);

    const longObjective = await createSpace(cookie, {
      name: 'Bounded',
      objective: 'y'.repeat(2001),
    });
    expect(longObjective.statusCode).toBe(400);
    expect(longObjective.json().error.fields.objective).toBe('Use at most 2000 characters.');

    const badFilter = await listSpaces(cookie, 'everything' as 'active');
    expect(badFilter.statusCode).toBe(400);
  });

  it('persists name and objective edits, together or one at a time', async () => {
    const { cookie } = await newUser();
    const { id } = (await createSpace(cookie)).json().space;
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/spaces/${id}`, headers: { cookie }, payload });

    const patched = await patch({ name: 'Renamed', objective: 'A sharper question' });
    expect(patched.statusCode).toBe(200);

    // Persisted, not just echoed back.
    const reread = await app.inject({ method: 'GET', url: `/spaces/${id}`, headers: { cookie } });
    expect(reread.json().space.name).toBe('Renamed');
    expect(reread.json().space.objective).toBe('A sharper question');

    // One field at a time leaves the other alone — the update is built from the
    // keys that were sent, so a missing key must not read as "clear it".
    const nameOnly = await patch({ name: 'Renamed again' });
    expect(nameOnly.json().space.objective).toBe('A sharper question');
    const objectiveOnly = await patch({ objective: 'Sharper still' });
    expect(objectiveOnly.json().space.name).toBe('Renamed again');

    // Sending a blank objective is how the form clears it: "not set", not "".
    expect((await patch({ objective: '   ' })).json().space.objective).toBeNull();

    const empty = await app.inject({
      method: 'PATCH',
      url: `/spaces/${id}`,
      headers: { cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    // A 400 that names nothing to fix is not actionable: the "change something"
    // rule has to arrive as a field message like any other validation failure.
    expect(empty.json().error.fields).toEqual({
      name: 'Change the name or the research objective.',
    });
  });


  it('sorts active spaces by most recently opened and only `open` moves a space', async () => {
    const { cookie } = await newUser();
    const first = (await createSpace(cookie, { name: 'First' })).json().space;
    const second = (await createSpace(cookie, { name: 'Second' })).json().space;

    // Never opened: newest first.
    expect((await listSpaces(cookie)).json().spaces.map((s: { id: string }) => s.id)).toEqual([
      second.id,
      first.id,
    ]);

    const opened = await app.inject({
      method: 'POST',
      url: `/spaces/${first.id}/open`,
      headers: { cookie },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().space.lastOpenedAt).not.toBeNull();

    expect((await listSpaces(cookie)).json().spaces.map((s: { id: string }) => s.id)).toEqual([
      first.id,
      second.id,
    ]);

    // Reading a space must not reorder the list — the SPA refetches on focus.
    await app.inject({ method: 'GET', url: `/spaces/${second.id}`, headers: { cookie } });
    expect((await listSpaces(cookie)).json().spaces.map((s: { id: string }) => s.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('archives without deleting content and restores it unchanged', async () => {
    const { cookie } = await newUser();
    const { id } = (await createSpace(cookie)).json().space;

    // Phase 1 has no UI that creates sources or notes, so the attached rows are
    // seeded directly — the criterion is that archiving leaves them alone.
    const source = await app.prisma.source.create({
      data: { spaceId: id, type: 'manual', title: 'A pasted excerpt', content: 'text', state: 'ready' },
    });
    const note = await app.prisma.note.create({
      data: { spaceId: id, title: 'A note', contentRich: { type: 'doc', content: [] } },
    });

    const archived = await app.inject({
      method: 'POST',
      url: `/spaces/${id}/archive`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().space.archivedAt).not.toBeNull();

    expect((await listSpaces(cookie)).json().spaces).toEqual([]);
    expect(
      (await listSpaces(cookie, 'archived')).json().spaces.map((s: { id: string }) => s.id),
    ).toEqual([id]);

    // Nothing was deleted while archived.
    expect(await app.prisma.source.findUnique({ where: { id: source.id } })).not.toBeNull();
    expect(await app.prisma.note.findUnique({ where: { id: note.id } })).not.toBeNull();

    const restored = await app.inject({
      method: 'POST',
      url: `/spaces/${id}/restore`,
      headers: { cookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().space.archivedAt).toBeNull();
    expect(restored.json().space.sourceCount).toBe(1);
    expect(restored.json().space.noteCount).toBe(1);

    expect((await listSpaces(cookie)).json().spaces.map((s: { id: string }) => s.id)).toEqual([id]);
  });

  it('freezes an archived space and keeps archive/restore idempotent', async () => {
    const { cookie, userId } = await newUser();
    const { id } = (await createSpace(cookie)).json().space;

    await app.inject({ method: 'POST', url: `/spaces/${id}/archive`, headers: { cookie } });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/spaces/${id}`,
      headers: { cookie },
      payload: { name: 'Nope' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('space_archived');

    const open = await app.inject({
      method: 'POST',
      url: `/spaces/${id}/open`,
      headers: { cookie },
    });
    expect(open.statusCode).toBe(409);

    // Reads stay available so the state is never a trap.
    const read = await app.inject({ method: 'GET', url: `/spaces/${id}`, headers: { cookie } });
    expect(read.statusCode).toBe(200);

    // Double-clicking archive (or restore) is a no-op, not an error.
    const again = await app.inject({
      method: 'POST',
      url: `/spaces/${id}/archive`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: `/spaces/${id}/restore`, headers: { cookie } });
    const restoreAgain = await app.inject({
      method: 'POST',
      url: `/spaces/${id}/restore`,
      headers: { cookie },
    });
    expect(restoreAgain.statusCode).toBe(200);
    expect(restoreAgain.json().space.archivedAt).toBeNull();

    // Neither archive nor restore is on §15's list, so nothing beyond the create
    // was recorded — an extra kind is one Phase 7's feed has to render.
    const activities = await app.prisma.activity.findMany({
      where: { userId, spaceId: id },
      select: { kind: true },
    });
    expect(activities.map((row) => row.kind)).toEqual(['space.created']);
  });

  it("answers 404 for another user's space and 401 without a session", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const { id } = (await createSpace(owner.cookie)).json().space;

    const routes: Array<[string, string]> = [
      ['GET', `/spaces/${id}`],
      ['PATCH', `/spaces/${id}`],
      ['POST', `/spaces/${id}/open`],
      ['POST', `/spaces/${id}/archive`],
      ['POST', `/spaces/${id}/restore`],
    ];

    for (const [method, url] of routes) {
      const foreign = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie: stranger.cookie },
        payload: method === 'PATCH' ? { name: 'Taken over' } : undefined,
      });
      // 404, never 403: a 403 would confirm the id exists (PRD §17).
      expect(foreign.statusCode, `${method} ${url}`).toBe(404);
      expect(foreign.json().error.code).toBe('not_found');

      const anonymous = await app.inject({ method: method as 'GET', url });
      expect(anonymous.statusCode, `${method} ${url} anonymous`).toBe(401);
    }

    // The stranger's own list never shows the owner's space.
    expect((await listSpaces(stranger.cookie)).json().spaces).toEqual([]);

    const listAnonymous = await app.inject({ method: 'GET', url: '/spaces' });
    expect(listAnonymous.statusCode).toBe(401);
    const createAnonymous = await app.inject({
      method: 'POST',
      url: '/spaces',
      payload: { name: 'No session' },
    });
    expect(createAnonymous.statusCode).toBe(401);
  });

  it('does not create a notebook row up front — it is lazy (plan/phase-1-spaces/design.md)', async () => {
    const { cookie } = await newUser();
    const { id } = (await createSpace(cookie)).json().space;

    expect(await app.prisma.notebook.findUnique({ where: { spaceId: id } })).toBeNull();
  });
});
