import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import { runSourceIngestion, type SourceStateEvent } from '../src/ingest/pipeline.js';
import { getObject } from '../src/lib/storage.js';
import { retrievableSources } from '../src/lib/retrieval-scope.js';

const DIM = 768;

/**
 * PRD §7 (source library): search, filters, metadata editing, archive/restore.
 * REQ range in specs/library-reader/spec.md.
 *
 * Sources are created through the HTTP routes and then driven to `ready` by the
 * real pipeline with a stubbed embedder, because the content tier of search
 * reads `Passage.tsv` — a hand-inserted row could not exercise it.
 */
describe('source library', () => {
  let app: FastifyInstance;
  let cookie: string;
  let strangerCookie: string;
  let spaceId: string;
  const emails: string[] = [];

  const ingest = (sourceId: string) =>
    runSourceIngestion(
      {
        prisma: app.prisma,
        storage: { getObject },
        embed: async (texts: string[]) =>
          texts.map(() => Array.from({ length: DIM }, () => 0)),
        publish: async (_spaceId: string, _event: SourceStateEvent) => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      sourceId,
    );

  /** Creates a manual source and processes it, so its text is searchable. */
  const addReadySource = async (
    payload: { title: string; content: string; author?: string },
    intoSpace = spaceId,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: `/spaces/${intoSpace}/sources`,
      headers: { cookie },
      payload: { type: 'manual', ...payload },
    });
    if (response.statusCode !== 201) {
      throw new Error(`addReadySource failed (${response.statusCode}): ${response.body}`);
    }
    const id = response.json().source.id as string;
    await ingest(id);
    return id;
  };

  const search = async (query: string, intoSpace = spaceId, as = cookie) => {
    const response = await app.inject({
      method: 'GET',
      url: `/spaces/${intoSpace}/sources${query}`,
      headers: { cookie: as },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().sources as { id: string; title: string }[]);
  };

  let consentTitleId: string;
  let consentContentId: string;
  let sleepId: string;

  beforeAll(async () => {
    app = await startTestApp();
    const email = uniqueEmail('lib');
    emails.push(email);
    cookie = (await registerUser(app, email)).cookie;
    const strangerEmail = uniqueEmail('lib-stranger');
    emails.push(strangerEmail);
    strangerCookie = (await registerUser(app, strangerEmail)).cookie;

    spaceId = await createSpace(app, cookie, 'Library');

    consentTitleId = await addReadySource({
      title: 'Informed Consent Practices',
      author: 'Ochoa',
      content: 'This paper is about paperwork and nothing else.',
    });
    consentContentId = await addReadySource({
      title: 'Field Notes',
      content: 'Consent was obtained from every participant before the session began.',
    });
    sleepId = await addReadySource({
      title: 'Sleep and Memory',
      author: 'Diekelmann',
      content: 'Slow-wave sleep consolidates declarative memory.',
    });
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('finds a source by its title and by content only, title first', async () => {
    const results = await search('?q=consent');
    // Both match; the title match leads, which is the §7 guarantee the tiered
    // ORDER BY exists for — a blended weight could only make it usually true.
    expect(results.map((s) => s.id)).toEqual([consentTitleId, consentContentId]);
  });

  it('matches a substring in a title and a stemmed word in content', async () => {
    // `ILIKE` on the metadata tier is what makes a mid-word match possible.
    expect((await search('?q=onsen')).map((s) => s.id)).toEqual([consentTitleId]);
    // FTS on the content tier is what makes `participants` find `participant`.
    expect((await search('?q=participants')).map((s) => s.id)).toEqual([consentContentId]);
    // Author is searched alongside the title (§7).
    expect((await search('?q=diekelmann')).map((s) => s.id)).toEqual([sleepId]);
  });

  it('keeps search inside the current space', async () => {
    const otherSpace = await createSpace(app, cookie, 'Other library');
    const otherId = await addReadySource(
      { title: 'Consent elsewhere', content: 'Another space entirely.' },
      otherSpace,
    );

    expect((await search('?q=consent')).map((s) => s.id)).not.toContain(otherId);
    expect((await search('?q=consent', otherSpace)).map((s) => s.id)).toEqual([otherId]);
  });

  it('combines a type filter with a query', async () => {
    const web = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceId}/sources`,
      headers: { cookie },
      payload: { type: 'web', url: 'https://example.com/consent-policy' },
    });
    expect(web.statusCode).toBe(201);
    const webId = web.json().source.id as string;
    // The URL is the placeholder title until extraction replaces it, so this
    // web source matches `consent` on its metadata.
    expect((await search('?q=consent')).map((s) => s.id)).toContain(webId);
    // Membership, not order: ranking has its own test, so a ranking change does
    // not also fail this one.
    expect(new Set((await search('?q=consent&type=manual')).map((s) => s.id))).toEqual(
      new Set([consentTitleId, consentContentId]),
    );
    expect((await search('?type=web')).map((s) => s.id)).toEqual([webId]);

    await app.prisma.source.delete({ where: { id: webId } });
  });

  it('survives search punctuation, and honours websearch operators', async () => {
    // `websearch_to_tsquery` is chosen precisely because this is a 200, not a 500.
    // It parses the operators rather than rejecting them: this one becomes the
    // negation `!'unclos'`, so it matches every source that lacks that word.
    const punctuation = await search('?q=%26%26%20%7C%20-%20%22unclosed');
    expect(punctuation.map((s) => s.id)).toContain(sleepId);

    // A `%` is a literal here, not an ILIKE wildcard matching the whole library.
    expect(await search('?q=%25')).toEqual([]);

    // A quoted phrase matches only where the words are adjacent.
    expect((await search('?q=%22declarative%20memory%22')).map((s) => s.id)).toEqual([sleepId]);
    expect(await search('?q=%22memory%20declarative%22')).toEqual([]);

    // A leading `-` excludes, which is what a user typing it into a search box means.
    const withoutConsent = (await search('?q=-consent')).map((s) => s.id);
    expect(withoutConsent).toContain(sleepId);
    expect(withoutConsent).not.toContain(consentContentId);
  });

  it('does not throttle searching at the write routes’ limit', async () => {
    // Searching is one request per settled query, so a user typing for a couple of
    // minutes passes sixty requests easily. This used to answer 429 from the
    // *write* route's bucket: `@fastify/rate-limit` pushes its hook into
    // `routeOptions.onRequest`, and this file shared one array across every route,
    // so each route ran every other route's limiter.
    for (let index = 1; index <= 70; index++) {
      const response = await app.inject({
        method: 'GET',
        url: `/spaces/${spaceId}/sources?q=consent${index % 3}`,
        headers: { cookie },
      });
      expect(response.statusCode, `search #${index}`).toBe(200);
    }
  });

  it('excludes archived sources unless they are asked for, and archiving is idempotent', async () => {
    const archived = await addReadySource({
      title: 'Withdrawn Evidence',
      content: 'Consent revoked by the author.',
    });

    const before = Date.now();
    const first = await app.inject({
      method: 'POST',
      url: `/sources/${archived}/archive`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const stamp = first.json().source.archivedAt as string;
    expect(stamp).not.toBeNull();
    // Stamped when the request ran, not when the process booted: `new Date()` in
    // the route table would be evaluated once at registration, and every archive
    // for the life of the server would record the same, ever-staler timestamp —
    // one that can even precede the source's own `createdAt`.
    expect(new Date(stamp).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(stamp).getTime()).toBeGreaterThanOrEqual(
      new Date(first.json().source.createdAt as string).getTime(),
    );

    const again = await app.inject({
      method: 'POST',
      url: `/sources/${archived}/archive`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);
    // Idempotent, and the timestamp is not re-stamped by a second call.
    expect(again.json().source.archivedAt).toBe(stamp);

    expect((await search('')).map((s) => s.id)).not.toContain(archived);
    expect((await search('?q=consent')).map((s) => s.id)).not.toContain(archived);
    expect((await search('?archived=only')).map((s) => s.id)).toEqual([archived]);
    expect((await search('?q=consent&archived=only')).map((s) => s.id)).toEqual([archived]);
    // All three at once: §7 requires the filters to combine, and a query plus a
    // type plus the archived view is the combination that exercises every clause.
    expect((await search('?q=consent&type=manual&archived=only')).map((s) => s.id)).toEqual([
      archived,
    ]);
    expect(await search('?q=consent&type=pdf&archived=only')).toEqual([]);

    // REQ-101 through the exported filter, never a re-derived where clause.
    const retrievable = await app.prisma.source.findMany({
      where: retrievableSources(spaceId),
      select: { id: true },
    });
    expect(retrievable.map((s) => s.id)).not.toContain(archived);

    // Non-destructive: the evidence is still there, ready to be restored.
    expect(await app.prisma.passage.count({ where: { sourceId: archived } })).toBeGreaterThan(0);
    expect(await app.prisma.sourceBlock.count({ where: { sourceId: archived } })).toBeGreaterThan(0);

    const restored = await app.inject({
      method: 'POST',
      url: `/sources/${archived}/restore`,
      headers: { cookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().source.archivedAt).toBeNull();
    expect((await search('?q=consent')).map((s) => s.id)).toContain(archived);

    const restoredAgain = await app.inject({
      method: 'POST',
      url: `/sources/${archived}/restore`,
      headers: { cookie },
    });
    expect(restoredAgain.statusCode).toBe(200);

    await app.prisma.source.delete({ where: { id: archived } });
  });

  it('edits title and author, and refuses everything else', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/sources/${sleepId}`,
      headers: { cookie },
      payload: { title: 'Sleep and Memory (revised)', author: 'Diekelmann & Born' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().source).toMatchObject({
      title: 'Sleep and Memory (revised)',
      author: 'Diekelmann & Born',
    });

    // Persisted, not just echoed.
    const reread = await app.inject({
      method: 'GET',
      url: `/sources/${sleepId}`,
      headers: { cookie },
    });
    expect(reread.json().source.title).toBe('Sleep and Memory (revised)');

    // An omitted author is "leave it alone", not "clear it". `.nullish()` plus a
    // `?? null` transform would make the two indistinguishable — Zod keeps the
    // resulting null in the body — and a title-only edit would erase the byline.
    const titleOnly = await app.inject({
      method: 'PATCH',
      url: `/sources/${sleepId}`,
      headers: { cookie },
      payload: { title: 'Sleep and Memory (again)' },
    });
    expect(titleOnly.statusCode).toBe(200);
    expect(titleOnly.json().source.author).toBe('Diekelmann & Born');

    // An explicit null does clear it, and is distinct from omission.
    const nulled = await app.inject({
      method: 'PATCH',
      url: `/sources/${sleepId}`,
      headers: { cookie },
      payload: { title: 'Sleep and Memory', author: null },
    });
    expect(nulled.json().source.author).toBeNull();

    await app.inject({
      method: 'PATCH',
      url: `/sources/${sleepId}`,
      headers: { cookie },
      payload: { title: 'Sleep and Memory', author: 'Diekelmann & Born' },
    });

    // An empty author clears the field rather than storing a blank string.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/sources/${sleepId}`,
      headers: { cookie },
      payload: { title: 'Sleep and Memory', author: '' },
    });
    expect(cleared.json().source.author).toBeNull();

    const blankTitle = await app.inject({
      method: 'PATCH',
      url: `/sources/${sleepId}`,
      headers: { cookie },
      payload: { title: '   ' },
    });
    expect(blankTitle.statusCode).toBe(400);

    // Extracted content is derived: editing it would leave every passage,
    // embedding, and citation describing the old text. The schema refuses it
    // rather than ignoring it.
    for (const forbidden of [
      { title: 'Sleep and Memory', content: 'rewritten' },
      { title: 'Sleep and Memory', state: 'ready' },
      { title: 'Sleep and Memory', type: 'pdf' },
      { title: 'Sleep and Memory', url: 'https://example.com' },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sources/${sleepId}`,
        headers: { cookie },
        payload: forbidden,
      });
      expect(response.statusCode, JSON.stringify(forbidden)).toBe(400);
    }

    const untouched = await app.prisma.source.findUnique({ where: { id: sleepId } });
    expect(untouched?.content).toBe('Slow-wave sleep consolidates declarative memory.');
  });

  it('answers 404 for another user’s source and 401 anonymously', async () => {
    const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['PATCH', `/sources/${sleepId}`, { title: 'Stolen' }],
      ['POST', `/sources/${sleepId}/archive`, undefined],
      ['POST', `/sources/${sleepId}/restore`, undefined],
      ['GET', `/sources/${sleepId}/blocks`, undefined],
      ['GET', `/sources/${sleepId}/outline`, undefined],
    ];

    for (const [method, url, payload] of routes) {
      const foreign = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie: strangerCookie },
        ...(payload ? { payload } : {}),
      });
      // 404, never 403: a 403 would confirm the id exists (PRD §17).
      expect(foreign.statusCode, `${method} ${url} foreign`).toBe(404);

      const anonymous = await app.inject({
        method: method as 'GET',
        url,
        ...(payload ? { payload } : {}),
      });
      expect(anonymous.statusCode, `${method} ${url} anonymous`).toBe(401);
    }
  });

  it('freezes metadata edits and archiving in an archived space, and still reads', async () => {
    const frozenSpace = await createSpace(app, cookie, 'To be archived');
    const sourceId = await addReadySource(
      { title: 'Frozen evidence', content: 'Written before the freeze.' },
      frozenSpace,
    );
    const archiveSpace = await app.inject({
      method: 'POST',
      url: `/spaces/${frozenSpace}/archive`,
      headers: { cookie },
    });
    expect(archiveSpace.statusCode).toBe(200);

    for (const [method, url, payload] of [
      ['PATCH', `/sources/${sourceId}`, { title: 'Renamed' }],
      ['POST', `/sources/${sourceId}/archive`, undefined],
      ['POST', `/sources/${sourceId}/restore`, undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(409);
      expect(response.json().error.code).toBe('space_archived');
    }

    // Reads stay allowed: an archived space is frozen, not hidden.
    const read = await app.inject({
      method: 'GET',
      url: `/sources/${sourceId}/blocks`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().blocks.length).toBeGreaterThan(0);
    const searched = await search('?q=frozen', frozenSpace);
    expect(searched.map((s) => s.id)).toEqual([sourceId]);
  });
});
