import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import { APP_CONFIG_DEFAULTS } from '../src/lib/app-config-defaults.js';
import { loadLimits } from '../src/config.js';

/**
 * The space's "Audience & style" note (wiki-docs/plan/space-audience-style).
 *
 * Owner writes, every role reads, and the cap is an `AppConfig` value rather than
 * a constant — it is the only control on this field that does not depend on the
 * model cooperating, so an operator has to be able to tighten it.
 *
 * What the answer *reads* like is a model property and is not asserted here; the
 * placement of the note in the request is, in `answer-audience.test.ts`.
 */
describe('space audience & style', () => {
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
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: Person,
    payload?: unknown,
  ): Promise<Injected> => {
    const options: Record<string, unknown> = { method, url, headers: { cookie: who.cookie } };
    if (payload !== undefined) options.payload = payload;
    return (await app.inject(options as never)) as unknown as Injected;
  };

  const join = async (who: Person, role: 'editor' | 'viewer') => {
    const created = await call('POST', `/spaces/${spaceId}/invites`, owner, { email: who.email, role });
    const token = created.json().url.split('/invite/')[1]!;
    await call('POST', `/invites/${token}/accept`, who);
  };

  const setLimit = async (value: number) => {
    await app.prisma.appConfig.upsert({
      where: { key: 'audience_instruction_max_chars' },
      create: { key: 'audience_instruction_max_chars', value: String(value) },
      update: { value: String(value) },
    });
    await loadLimits(app.prisma, true);
  };

  beforeAll(async () => {
    app = await startTestApp();
    owner = await person('audience-owner');
    editor = await person('audience-editor');
    viewer = await person('audience-viewer');
    stranger = await person('audience-stranger');
    spaceId = await createSpace(app, owner.cookie, 'Grade 8 climate unit');
    await join(editor, 'editor');
    await join(viewer, 'viewer');
  });

  afterAll(async () => {
    await setLimit(APP_CONFIG_DEFAULTS.audience_instruction_max_chars);
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('starts unset, and reports the configured cap alongside it', async () => {
    const space = (await call('GET', `/spaces/${spaceId}`, owner)).json().space;
    expect(space.audienceInstruction).toBeNull();
    expect(space.audienceInstructionMaxChars).toBe(
      APP_CONFIG_DEFAULTS.audience_instruction_max_chars,
    );
  });

  it('is the owner’s to set: an editor is 403 and a non-member is 404', async () => {
    const note = 'Vietnamese, secondary-school level.';
    expect((await call('PUT', `/spaces/${spaceId}/audience`, editor, { audience: note })).statusCode).toBe(403);
    expect((await call('PUT', `/spaces/${spaceId}/audience`, viewer, { audience: note })).statusCode).toBe(403);
    // A non-member is told nothing about whether the space exists (REQ-283).
    expect((await call('PUT', `/spaces/${spaceId}/audience`, stranger, { audience: note })).statusCode).toBe(404);
  });

  it('every role reads what the owner set', async () => {
    const note = 'Trả lời bằng tiếng Việt, ở mức học sinh cấp 2.';
    const saved = await call('PUT', `/spaces/${spaceId}/audience`, owner, { audience: note });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().space.audienceInstruction).toBe(note);

    for (const who of [owner, editor, viewer]) {
      const space = (await call('GET', `/spaces/${spaceId}`, who)).json().space;
      // A member should be able to read what is shaping the answers they get.
      expect(space.audienceInstruction, who.email).toBe(note);
    }
    expect((await call('GET', `/spaces/${spaceId}`, stranger)).statusCode).toBe(404);
  });

  it('records the change on the space feed, because it changes what everyone reads', async () => {
    const feed = await call('GET', `/spaces/${spaceId}/activity`, viewer);
    expect(feed.statusCode).toBe(200);
    const row = feed.json().items.find((item: { kind: string }) => item.kind === 'space.audience_changed');
    expect(row).toBeTruthy();
    expect(row.actor.id).toBe(owner.userId);
    expect(row.href).toBe(`/spaces/${spaceId}`);
  });

  it('writes no second feed row for a save that changed nothing', async () => {
    const kinds = async () => {
      const feed = await call('GET', `/spaces/${spaceId}/activity`, owner);
      return feed.json().items.filter((i: { kind: string }) => i.kind === 'space.audience_changed').length;
    };
    const before = await kinds();
    const same = (await call('GET', `/spaces/${spaceId}`, owner)).json().space.audienceInstruction;
    expect((await call('PUT', `/spaces/${spaceId}/audience`, owner, { audience: same })).statusCode).toBe(200);
    // A row saying the note changed, when it did not, is noise on a shared feed.
    expect(await kinds()).toBe(before);
  });

  it('does not record a change it did not make: a refused write leaves no row', async () => {
    const kinds = async () => {
      const feed = await call('GET', `/spaces/${spaceId}/activity`, owner);
      return feed.json().items.filter((i: { kind: string }) => i.kind === 'space.audience_changed').length;
    };
    const before = await kinds();
    const refused = await call('PUT', `/spaces/${spaceId}/audience`, owner, {
      audience: 'a'.repeat(APP_CONFIG_DEFAULTS.audience_instruction_max_chars + 1),
    });
    expect(refused.statusCode).toBe(400);
    // The note and its feed row land together or not at all.
    expect(await kinds()).toBe(before);
  });

  it('trims, and treats blank as unset rather than as a set-but-empty note', async () => {
    const padded = await call('PUT', `/spaces/${spaceId}/audience`, owner, { audience: '  Plain English.  ' });
    expect(padded.json().space.audienceInstruction).toBe('Plain English.');

    const cleared = await call('PUT', `/spaces/${spaceId}/audience`, owner, { audience: '   ' });
    expect(cleared.json().space.audienceInstruction).toBeNull();

    const nulled = await call('PUT', `/spaces/${spaceId}/audience`, owner, { audience: null });
    expect(nulled.json().space.audienceInstruction).toBeNull();
  });

  it('refuses a note over the cap, and the cap follows AppConfig (PRD §5)', async () => {
    const long = 'a'.repeat(APP_CONFIG_DEFAULTS.audience_instruction_max_chars + 1);
    const refused = await call('PUT', `/spaces/${spaceId}/audience`, owner, { audience: long });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain(
      String(APP_CONFIG_DEFAULTS.audience_instruction_max_chars),
    );
    expect(refused.json().error.fields.audience).toBeTruthy();

    // Tightening it is what makes this a control rather than a shape limit.
    await setLimit(20);
    const nowTooLong = await call('PUT', `/spaces/${spaceId}/audience`, owner, {
      audience: 'a'.repeat(21),
    });
    expect(nowTooLong.statusCode).toBe(400);
    expect(nowTooLong.json().error.message).toContain('20');
    expect((await call('PUT', `/spaces/${spaceId}/audience`, owner, { audience: 'a'.repeat(20) })).statusCode).toBe(200);
    expect(
      (await call('GET', `/spaces/${spaceId}`, viewer)).json().space.audienceInstructionMaxChars,
    ).toBe(20);
    await setLimit(APP_CONFIG_DEFAULTS.audience_instruction_max_chars);
  });

  it('is refused in an archived space, like every other write (REQ-065)', async () => {
    const archivedId = await createSpace(app, owner.cookie, 'Archived space');
    expect((await call('POST', `/spaces/${archivedId}/archive`, owner)).statusCode).toBe(200);

    const refused = await call('PUT', `/spaces/${archivedId}/audience`, owner, { audience: 'Plain English.' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('space_archived');
  });
});
