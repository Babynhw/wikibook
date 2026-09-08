import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import { env } from '../src/config.js';

/**
 * Shared spaces v1 (wiki-docs/plan/shared-spaces-v1): invites, roles, actors,
 * private conversations, per-member resume, the space feed, and advisory
 * notebook presence. One space, four people, in the order a team would meet it.
 */
describe('shared spaces', () => {
  let app: FastifyInstance;
  const emails: string[] = [];

  type Person = { cookie: string; userId: string; email: string };
  let owner: Person;
  let editor: Person;
  let viewer: Person;
  let stranger: Person;
  let spaceId = '';

  const person = async (prefix: string): Promise<Person> => {
    const email = uniqueEmail(prefix);
    emails.push(email);
    const { cookie, userId } = await registerUser(app, email);
    return { cookie, userId, email };
  };

  type Injected = { statusCode: number; body: string; json: () => any };
  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    who: Person,
    payload?: unknown,
  ): Promise<Injected> => {
    const options: Record<string, unknown> = { method, url, headers: { cookie: who.cookie } };
    if (payload !== undefined) options.payload = payload;
    return (await app.inject(options as never)) as unknown as Injected;
  };

  const invite = async (email: string, role: 'editor' | 'viewer') => {
    const response = await call('POST', `/spaces/${spaceId}/invites`, owner, { email, role });
    return response;
  };

  const tokenOf = (url: string) => url.split('/invite/')[1]!;

  beforeAll(async () => {
    app = await startTestApp();
    owner = await person('owner');
    editor = await person('editor');
    viewer = await person('viewer');
    stranger = await person('stranger');
    spaceId = await createSpace(app, owner.cookie, 'Team space');
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  // --- Ownership row -----------------------------------------------------------

  it('creates the owner as a member, so the roster and myRole are one lookup', async () => {
    const space = await call('GET', `/spaces/${spaceId}`, owner);
    expect(space.json().space).toMatchObject({ myRole: 'owner', memberCount: 1, ownerName: 'Test Person' });

    const roster = await call('GET', `/spaces/${spaceId}/members`, owner);
    expect(roster.statusCode).toBe(200);
    expect(roster.json().members).toEqual([
      expect.objectContaining({ userId: owner.userId, role: 'owner', email: owner.email }),
    ]);
  });

  // --- Invites --------------------------------------------------------------------

  it('only the owner can invite; a non-member gets 404, and the link is shown once', async () => {
    expect((await call('POST', `/spaces/${spaceId}/invites`, stranger, { email: 'x@example.test', role: 'viewer' })).statusCode).toBe(404);

    const created = await invite(editor.email, 'editor');
    expect(created.statusCode).toBe(201);
    const { invite: row, url } = created.json() as { invite: { id: string; email: string; role: string }; url: string };
    expect(row).toMatchObject({ email: editor.email.toLowerCase(), role: 'editor' });
    expect(url).toContain('/invite/');
    // Only a hash is stored: the token itself is not in the database.
    const stored = await app.prisma.spaceInvite.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.tokenHash).not.toBe(tokenOf(url));
    expect(stored.tokenHash).toHaveLength(64);

    // The pending list is the owner's; it names the email but never the token.
    const roster = await call('GET', `/spaces/${spaceId}/members`, owner);
    expect(roster.json().invites).toEqual([expect.objectContaining({ id: row.id, email: editor.email.toLowerCase() })]);
    expect(JSON.stringify(roster.json())).not.toContain(tokenOf(url));

    const activity = await app.prisma.activity.findFirst({ where: { spaceId, kind: 'member.invited', refId: row.id } });
    expect(activity?.userId).toBe(owner.userId);
  });

  it('refuses a second pending invite for the same email, and an invite for a member', async () => {
    const again = await invite(editor.email, 'viewer');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invite_pending');

    const self = await invite(owner.email, 'viewer');
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('already_member');
  });

  it('accepting with the wrong account is the same 404 as an unknown link', async () => {
    const pending = await app.prisma.spaceInvite.findFirstOrThrow({ where: { spaceId, email: editor.email.toLowerCase() } });
    // Rotate so we hold a live token for this row.
    const rotated = await call('POST', `/spaces/${spaceId}/invites/${pending.id}/rotate`, owner);
    expect(rotated.statusCode).toBe(200);
    const token = tokenOf(rotated.json().url);

    const wrongAccount = await call('GET', `/invites/${token}`, stranger);
    const unknown = await call('GET', '/invites/not-a-real-token', stranger);
    expect(wrongAccount.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(wrongAccount.json()).toEqual(unknown.json());
    expect(JSON.stringify(wrongAccount.json())).not.toContain(spaceId);

    const wrongAccept = await call('POST', `/invites/${token}/accept`, stranger);
    expect(wrongAccept.statusCode).toBe(404);
    expect((await call('GET', `/spaces/${spaceId}`, stranger)).statusCode).toBe(404);
  });

  it('rotating a link kills the previous token', async () => {
    const pending = await app.prisma.spaceInvite.findFirstOrThrow({ where: { spaceId, email: editor.email.toLowerCase() } });
    const first = tokenOf((await call('POST', `/spaces/${spaceId}/invites/${pending.id}/rotate`, owner)).json().url);
    const second = tokenOf((await call('POST', `/spaces/${spaceId}/invites/${pending.id}/rotate`, owner)).json().url);
    expect(first).not.toBe(second);
    expect((await call('GET', `/invites/${first}`, editor)).statusCode).toBe(404);
    expect((await call('GET', `/invites/${second}`, editor)).statusCode).toBe(200);
  });

  it('the invited account previews and accepts once; the second accept is a 404', async () => {
    const pending = await app.prisma.spaceInvite.findFirstOrThrow({ where: { spaceId, email: editor.email.toLowerCase() } });
    const token = tokenOf((await call('POST', `/spaces/${spaceId}/invites/${pending.id}/rotate`, owner)).json().url);

    const preview = await call('GET', `/invites/${token}`, editor);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().invite).toMatchObject({ spaceId, spaceName: 'Team space', role: 'editor', alreadyMember: false });

    const accepted = await call('POST', `/invites/${token}/accept`, editor);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ spaceId, role: 'editor' });

    expect((await call('POST', `/invites/${token}/accept`, editor)).statusCode).toBe(404);

    const space = await call('GET', `/spaces/${spaceId}`, editor);
    expect(space.statusCode).toBe(200);
    expect(space.json().space).toMatchObject({ myRole: 'editor', memberCount: 2 });

    // Joining is in the feed, attributed to the joiner; the pending list is now empty.
    expect(await app.prisma.activity.count({ where: { spaceId, kind: 'member.joined', userId: editor.userId, refId: editor.userId } })).toBe(1);
    expect((await call('GET', `/spaces/${spaceId}/members`, owner)).json().invites).toEqual([]);
  });

  it('an expired invite is a 404 and its seat can be re-issued', async () => {
    const created = await invite(viewer.email, 'viewer');
    expect(created.statusCode).toBe(201);
    const token = tokenOf(created.json().url);
    await app.prisma.spaceInvite.update({
      where: { id: created.json().invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call('GET', `/invites/${token}`, viewer)).statusCode).toBe(404);

    // Same email again: the unique (spaceId, email) row is reused, not a 409.
    const reissued = await invite(viewer.email, 'viewer');
    expect(reissued.statusCode).toBe(201);
    const accepted = await call('POST', `/invites/${tokenOf(reissued.json().url)}/accept`, viewer);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().role).toBe('viewer');
  });

  it('reads the member cap from AppConfig at request time', async () => {
    // Three members now; a cap of 3 refuses the next seat, and lifting it allows it.
    await app.prisma.appConfig.upsert({
      where: { key: 'members_per_space' },
      create: { key: 'members_per_space', value: '3' },
      update: { value: '3' },
    });
    const { loadLimits } = await import('../src/config.js');
    await loadLimits(app.prisma, true);
    const refused = await invite('fourth@example.test', 'viewer');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('members_limit');
    expect(refused.json().error.message).toContain('3');

    await app.prisma.appConfig.delete({ where: { key: 'members_per_space' } });
    await loadLimits(app.prisma, true);
    const allowed = await invite('fourth@example.test', 'viewer');
    expect(allowed.statusCode).toBe(201);
    expect((await call('DELETE', `/spaces/${spaceId}/invites/${allowed.json().invite.id}`, owner)).statusCode).toBe(204);
    expect((await call('GET', `/invites/${tokenOf(allowed.json().url)}`, stranger)).statusCode).toBe(404);
  });

  // --- Roles ---------------------------------------------------------------------

  let editorSourceId = '';
  let ownerSourceId = '';

  it('viewer reads and is 403 on every write; editor writes shared material', async () => {
    const list = await call('GET', `/spaces/${spaceId}/sources`, viewer);
    expect(list.statusCode).toBe(200);

    const viewerAdd = await call('POST', `/spaces/${spaceId}/sources`, viewer, { type: 'manual', title: 'Nope', content: 'text' });
    expect(viewerAdd.statusCode).toBe(403);
    expect(viewerAdd.json().error.code).toBe('insufficient_role');

    const viewerNote = await call('POST', `/spaces/${spaceId}/notes`, viewer, { title: 'Nope' });
    expect(viewerNote.statusCode).toBe(403);

    const viewerNotebook = await call('PUT', `/spaces/${spaceId}/notebook`, viewer, {
      contentRich: { type: 'doc', content: [] },
      baseUpdatedAt: new Date().toISOString(),
    });
    expect(viewerNotebook.statusCode).toBe(403);

    const viewerRename = await call('PATCH', `/spaces/${spaceId}`, viewer, { name: 'Hijacked' });
    expect(viewerRename.statusCode).toBe(403);

    const editorAdd = await call('POST', `/spaces/${spaceId}/sources`, editor, {
      type: 'manual',
      title: 'Editor evidence',
      content: 'Participants described withdrawal as socially costly.',
    });
    expect(editorAdd.statusCode).toBe(201);
    expect(editorAdd.json().source.addedBy).toEqual({ id: editor.userId, name: 'Test Person' });
    editorSourceId = editorAdd.json().source.id;

    const ownerAdd = await call('POST', `/spaces/${spaceId}/sources`, owner, {
      type: 'manual',
      title: 'Owner evidence',
      content: 'Sleep improved recall in the treatment group.',
    });
    ownerSourceId = ownerAdd.json().source.id;

    const editorRename = await call('PATCH', `/spaces/${spaceId}`, editor, { name: 'Team space (renamed)' });
    expect(editorRename.statusCode).toBe(200);

    const editorNote = await call('POST', `/spaces/${spaceId}/notes`, editor, { title: 'Editor note' });
    expect(editorNote.statusCode).toBe(201);
    expect(editorNote.json().note.author).toEqual({ id: editor.userId, name: 'Test Person' });
    // Notes are fully shared: the owner may edit the editor's note.
    expect((await call('PATCH', `/notes/${editorNote.json().note.id}`, owner, { title: 'Edited by owner' })).statusCode).toBe(200);
  });

  it('archive/restore are owner-only; an editor is 403', async () => {
    expect((await call('POST', `/spaces/${spaceId}/archive`, editor)).statusCode).toBe(403);
    expect((await call('POST', `/spaces/${spaceId}/archive`, owner)).statusCode).toBe(200);
    expect((await call('POST', `/spaces/${spaceId}/restore`, owner)).statusCode).toBe(200);
  });

  it('an editor deletes only their own source; the owner deletes any', async () => {
    const other = await call('DELETE', `/sources/${ownerSourceId}`, editor);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe('insufficient_role');

    expect((await call('DELETE', `/sources/${editorSourceId}`, editor)).statusCode).toBe(204);
    expect((await call('DELETE', `/sources/${ownerSourceId}`, owner)).statusCode).toBe(204);
  });

  it('the pipeline attributes source activity to the adder, not the owner', async () => {
    const added = await call('POST', `/spaces/${spaceId}/sources`, editor, {
      type: 'manual',
      title: 'Attributed',
      content: 'A manual source the editor added.',
    });
    editorSourceId = added.json().source.id;
    const source = await app.prisma.source.findUniqueOrThrow({ where: { id: editorSourceId }, select: { addedById: true } });
    expect(source.addedById).toBe(editor.userId);
    const activity = await app.prisma.activity.findFirst({ where: { spaceId, kind: 'source.added', refId: editorSourceId } });
    expect(activity?.userId).toBe(editor.userId);
  });

  // --- Conversations are private ---------------------------------------------------

  let editorConversationId = '';

  it("a member's conversation is 404 to another member, and the list is mine only", async () => {
    const created = await call('POST', `/spaces/${spaceId}/conversations`, editor, { scopeType: 'space' });
    expect(created.statusCode).toBe(201);
    editorConversationId = created.json().conversation.id;

    const asOwner = await call('GET', `/conversations/${editorConversationId}`, owner);
    expect(asOwner.statusCode).toBe(404);

    const viewerCreated = await call('POST', `/spaces/${spaceId}/conversations`, viewer, { scopeType: 'space' });
    expect(viewerCreated.statusCode).toBe(201);

    const editorList = await call('GET', `/spaces/${spaceId}/conversations`, editor);
    const ids = (editorList.json().conversations as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(editorConversationId);
    expect(ids).not.toContain(viewerCreated.json().conversation.id);
  });

  // --- Resume is per member ---------------------------------------------------------

  it('opening stamps only my membership row', async () => {
    const before = (await call('GET', `/spaces/${spaceId}`, viewer)).json().space.lastOpenedAt;
    const opened = await call('POST', `/spaces/${spaceId}/open`, editor);
    expect(opened.statusCode).toBe(200);
    expect(opened.json().space.lastOpenedAt).not.toBeNull();
    expect((await call('GET', `/spaces/${spaceId}`, viewer)).json().space.lastOpenedAt).toBe(before);

    const list = await call('GET', '/spaces', editor);
    expect((list.json().spaces as { id: string; myRole: string }[]).find((s) => s.id === spaceId)).toMatchObject({ myRole: 'editor' });
    expect((await call('GET', '/spaces', stranger)).json().spaces.map((s: { id: string }) => s.id)).not.toContain(spaceId);
  });

  // --- Activity ---------------------------------------------------------------------------

  it('the space feed shows every member with the actor; Home shows only me plus membership about me', async () => {
    const feed = await call('GET', `/spaces/${spaceId}/activity?limit=50`, viewer);
    expect(feed.statusCode).toBe(200);
    const items = feed.json().items as { kind: string; actor: { id: string } | null; href: string | null; target: { type: string; title: string } | null }[];
    const bySource = items.find((i) => i.kind === 'source.added' && i.actor?.id === editor.userId);
    expect(bySource).toBeDefined();
    const joined = items.find((i) => i.kind === 'member.joined' && i.actor?.id === editor.userId);
    expect(joined).toMatchObject({ href: `/spaces/${spaceId}/members`, target: { type: 'user', title: 'Test Person' } });
    const invited = items.find((i) => i.kind === 'member.invited');
    expect(invited?.target).toMatchObject({ type: 'user' });

    const home = await call('GET', '/activity?limit=50', viewer);
    const kinds = (home.json().items as { kind: string; actor: { id: string } | null }[]);
    // My own join is about me; the editor's source add is not mine and not about me.
    expect(kinds.some((i) => i.kind === 'member.joined' && i.actor?.id === viewer.userId)).toBe(true);
    expect(kinds.some((i) => i.kind === 'source.added')).toBe(false);

    expect((await call('GET', `/spaces/${spaceId}/activity`, stranger)).statusCode).toBe(404);
  });

  // --- Notebook: actor and presence ---------------------------------------------------------

  it('a save records who saved, and the 409 names them', async () => {
    const loaded = (await call('GET', `/spaces/${spaceId}/notebook`, editor)).json().notebook;
    const saved = await call('PUT', `/spaces/${spaceId}/notebook`, editor, {
      contentRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Editor draft' }] }] },
      baseUpdatedAt: loaded.updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().notebook.updatedBy).toEqual({ id: editor.userId, name: 'Test Person' });

    const stale = await call('PUT', `/spaces/${spaceId}/notebook`, owner, {
      contentRich: { type: 'doc', content: [] },
      baseUpdatedAt: loaded.updatedAt,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().notebook.updatedBy.id).toBe(editor.userId);
  });

  it('presence: editors heartbeat, viewers cannot, the set is published and cleared', async () => {
    const received: unknown[] = [];
    const unsubscribe = app.events.subscribe(`space:${spaceId}`, (payload) => received.push(payload));
    try {
      expect((await call('POST', `/spaces/${spaceId}/notebook/presence`, viewer)).statusCode).toBe(403);

      const beat = await call('POST', `/spaces/${spaceId}/notebook/presence`, editor);
      expect(beat.statusCode).toBe(200);
      expect(beat.json().users).toEqual([{ id: editor.userId, name: 'Test Person' }]);

      await call('POST', `/spaces/${spaceId}/notebook/presence`, owner);
      const read = await call('GET', `/spaces/${spaceId}/notebook/presence`, viewer);
      expect((read.json().users as { id: string }[]).map((u) => u.id).sort()).toEqual([editor.userId, owner.userId].sort());

      // Wait for the Redis relay to deliver at least one presence event.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.some((p) => (p as { type?: string }).type === 'notebook.presence')).toBe(true);

      expect((await call('DELETE', `/spaces/${spaceId}/notebook/presence`, editor)).statusCode).toBe(204);
      expect((await call('GET', `/spaces/${spaceId}/notebook/presence`, viewer)).json().users).toEqual([{ id: owner.userId, name: 'Test Person' }]);
      await call('DELETE', `/spaces/${spaceId}/notebook/presence`, owner);
    } finally {
      unsubscribe();
    }
  });

  // --- Managing members ---------------------------------------------------------------------

  it('role changes are owner-only, never on self or the owner', async () => {
    expect((await call('PATCH', `/spaces/${spaceId}/members/${viewer.userId}`, editor, { role: 'editor' })).statusCode).toBe(403);
    const self = await call('PATCH', `/spaces/${spaceId}/members/${owner.userId}`, owner, { role: 'viewer' });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('owner_self_change');

    const promoted = await call('PATCH', `/spaces/${spaceId}/members/${viewer.userId}`, owner, { role: 'editor' });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().member.role).toBe('editor');
    expect(await app.prisma.activity.count({ where: { spaceId, kind: 'member.role_changed', refId: viewer.userId } })).toBe(1);
    const demoted = await call('PATCH', `/spaces/${spaceId}/members/${viewer.userId}`, owner, { role: 'viewer' });
    expect(demoted.json().member.role).toBe('viewer');
  });

  it('the owner cannot leave; a member can, and their conversations go with them', async () => {
    const ownerLeave = await call('POST', `/spaces/${spaceId}/leave`, owner);
    expect(ownerLeave.statusCode).toBe(409);
    expect(ownerLeave.json().error.code).toBe('owner_cannot_leave');

    const viewerConversations = await app.prisma.conversation.count({ where: { spaceId, userId: viewer.userId } });
    expect(viewerConversations).toBeGreaterThan(0);
    expect((await call('POST', `/spaces/${spaceId}/leave`, viewer)).statusCode).toBe(204);
    expect((await call('GET', `/spaces/${spaceId}`, viewer)).statusCode).toBe(404);
    expect(await app.prisma.conversation.count({ where: { spaceId, userId: viewer.userId } })).toBe(0);
    expect(await app.prisma.activity.count({ where: { spaceId, kind: 'member.left', userId: viewer.userId } })).toBe(1);
  });

  it('removal makes the next request 404, deletes their conversations, keeps their sources and notes with their name', async () => {
    const noteBefore = await app.prisma.note.count({ where: { spaceId, authorId: editor.userId } });
    expect(noteBefore).toBeGreaterThan(0);

    expect((await call('DELETE', `/spaces/${spaceId}/members/${owner.userId}`, owner)).statusCode).toBe(400);
    expect((await call('DELETE', `/spaces/${spaceId}/members/${editor.userId}`, stranger)).statusCode).toBe(404);

    expect((await call('DELETE', `/spaces/${spaceId}/members/${editor.userId}`, owner)).statusCode).toBe(204);
    expect((await call('GET', `/spaces/${spaceId}`, editor)).statusCode).toBe(404);
    expect((await call('GET', `/sources/${editorSourceId}`, editor)).statusCode).toBe(404);

    expect(await app.prisma.conversation.count({ where: { id: editorConversationId } })).toBe(0);
    const source = await app.prisma.source.findUniqueOrThrow({ where: { id: editorSourceId }, select: { addedById: true } });
    expect(source.addedById).toBe(editor.userId);
    expect(await app.prisma.note.count({ where: { spaceId, authorId: editor.userId } })).toBe(noteBefore);

    const asOwner = await call('GET', `/sources/${editorSourceId}`, owner);
    expect(asOwner.json().source.addedBy).toEqual({ id: editor.userId, name: 'Test Person' });
    // Removing twice is a 404: the row is gone.
    expect((await call('DELETE', `/spaces/${spaceId}/members/${editor.userId}`, owner)).statusCode).toBe(404);
  });

  it('transfer moves ownership to an editor atomically, leaving exactly one owner', async () => {
    // Re-add the editor by invite so there is someone to transfer to.
    const created = await invite(editor.email, 'editor');
    await call('POST', `/invites/${tokenOf(created.json().url)}/accept`, editor);

    const toSelf = await call('POST', `/spaces/${spaceId}/transfer`, owner, { userId: owner.userId });
    expect(toSelf.statusCode).toBe(400);
    const toStranger = await call('POST', `/spaces/${spaceId}/transfer`, owner, { userId: stranger.userId });
    expect(toStranger.statusCode).toBe(400);
    expect(toStranger.json().error.code).toBe('transfer_target_not_editor');

    const transferred = await call('POST', `/spaces/${spaceId}/transfer`, owner, { userId: editor.userId });
    expect(transferred.statusCode).toBe(200);

    const space = await app.prisma.space.findUniqueOrThrow({ where: { id: spaceId }, select: { ownerId: true } });
    expect(space.ownerId).toBe(editor.userId);
    const owners = await app.prisma.spaceMember.findMany({ where: { spaceId, role: 'owner' }, select: { userId: true } });
    expect(owners).toEqual([{ userId: editor.userId }]);
    expect((await call('GET', `/spaces/${spaceId}`, owner)).json().space.myRole).toBe('editor');
    expect((await call('GET', `/spaces/${spaceId}`, editor)).json().space).toMatchObject({ myRole: 'owner', ownerName: 'Test Person' });

    // The old owner is now an editor: archiving is refused.
    expect((await call('POST', `/spaces/${spaceId}/archive`, owner)).statusCode).toBe(403);
    expect(await app.prisma.activity.count({ where: { spaceId, kind: 'space.ownership_transferred', refId: editor.userId } })).toBe(1);
  });

  // --- Review fixes (2026-08-28) ------------------------------------------------

  it('a burst of invites never puts the space over the member cap', async () => {
    const capSpace = await createSpace(app, owner.cookie, 'Cap space');
    // One member (the owner) against a cap of three leaves exactly two seats.
    await app.prisma.appConfig.upsert({
      where: { key: 'members_per_space' },
      create: { key: 'members_per_space', value: '3' },
      update: { value: '3' },
    });
    const { loadLimits } = await import('../src/config.js');
    await loadLimits(app.prisma, true);

    try {
      // Concurrent, not sequential: the point is that the cap is not a
      // read-then-write. Without the space-row lock every one of these reads
      // "1 member, 0 pending" and all five are granted.
      const results = await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((slug) =>
          app.inject({
            method: 'POST',
            url: `/spaces/${capSpace}/invites`,
            headers: { cookie: owner.cookie },
            payload: { email: `burst-${slug}-${Date.now()}@example.test`, role: 'viewer' },
          }),
        ),
      );

      const created = results.filter((r) => r.statusCode === 201);
      const refused = results.filter((r) => r.statusCode === 409);
      expect(created).toHaveLength(2);
      expect(refused).toHaveLength(3);
      for (const r of refused) expect(r.json().error.code).toBe('members_limit');

      const members = await app.prisma.spaceMember.count({ where: { spaceId: capSpace } });
      const pending = await app.prisma.spaceInvite.count({
        where: { spaceId: capSpace, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      expect(members + pending).toBe(3);
    } finally {
      await app.prisma.appConfig.delete({ where: { key: 'members_per_space' } });
      await loadLimits(app.prisma, true);
    }
  });

  it('a heartbeat that stops without a DELETE clears for a watcher, and the channel is told', async () => {
    const presenceSpace = await createSpace(app, owner.cookie, 'Presence space');
    const received: unknown[] = [];
    const unsubscribe = app.events.subscribe(`space:${presenceSpace}`, (payload) => received.push(payload));
    try {
      await call('POST', `/spaces/${presenceSpace}/notebook/presence`, owner);
      // Age the entry past the TTL the way a crashed tab would: no DELETE, just
      // a heartbeat that never comes again.
      await app.redis.zadd(
        `notebook:editing:${presenceSpace}`,
        Date.now() - (env.NOTEBOOK_PRESENCE_TTL_SECONDS + 5) * 1000,
        owner.userId,
      );
      received.length = 0;

      // A read is the only thing that notices the expiry, so it is the only
      // thing that can tell a member who is watching rather than typing.
      const read = await call('GET', `/spaces/${presenceSpace}/notebook/presence`, owner);
      expect(read.statusCode).toBe(200);
      expect(read.json().users).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received).toContainEqual({ type: 'notebook.presence', users: [] });
    } finally {
      unsubscribe();
    }
  });

  it('a Redis failure answers "nobody is editing" instead of failing the request', async () => {
    const blipSpace = await createSpace(app, owner.cookie, 'Blip space');
    const boom = new Error('READONLY You cannot write against a read only replica');

    const read = vi.spyOn(app.redis, 'zremrangebyscore').mockRejectedValueOnce(boom as never);
    const got = await call('GET', `/spaces/${blipSpace}/notebook/presence`, owner);
    expect(got.statusCode).toBe(200);
    expect(got.json().users).toEqual([]);
    read.mockRestore();

    const write = vi.spyOn(app.redis, 'multi').mockImplementationOnce(() => {
      throw boom;
    });
    const beat = await call('POST', `/spaces/${blipSpace}/notebook/presence`, owner);
    expect(beat.statusCode).toBe(200);
    write.mockRestore();

    // And once Redis is back, presence works again — the fallback is not sticky.
    const recovered = await call('POST', `/spaces/${blipSpace}/notebook/presence`, owner);
    expect(recovered.json().users).toEqual([{ id: owner.userId, name: 'Test Person' }]);
    await call('DELETE', `/spaces/${blipSpace}/notebook/presence`, owner);
  });
});
