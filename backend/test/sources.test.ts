import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { Worker } from 'bullmq';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail, uploadPdf } from './helpers.js';
import { buildMinimalPdf } from '../scripts/pdf-fixture-builder.js';
import { keyFor, putObject, getObject, removeObject } from '../src/lib/storage.js';
import { invalidateLimitsCache, type AppLimits } from '../src/config.js';
import { APP_CONFIG_DEFAULTS } from '../src/lib/app-config-defaults.js';
import { createBullConnection, PURGE_QUEUE_NAME } from '../src/lib/queue.js';

/** REQ range in specs/ingestion/spec.md (PRD §5/§6/§17), through the HTTP layer. */
describe('sources', () => {
  let app: FastifyInstance;
  const emails: string[] = [];
  const keysToClean: string[] = [];
  const originalLimits: Partial<AppLimits> = {};
  let purgeWorker: Worker;

  /**
   * `/auth/register` allows 10 per minute per client and the whole suite shares
   * one in-memory budget (see `registerUser`), so the eleventh test in this file
   * used to fail with a 429 that looked like a source bug. Every test here is
   * isolated by its own *space*, not by its account, so they share one user and
   * only the ownership test asks for a second one.
   */
  let sharedUser: Promise<{ cookie: string }> | null = null;

  const freshUser = async () => {
    const email = uniqueEmail('src');
    emails.push(email);
    const { cookie } = await registerUser(app, email);
    return { cookie };
  };

  const newUser = () => {
    sharedUser ??= freshUser();
    return sharedUser;
  };

  const setLimit = async (key: keyof typeof APP_CONFIG_DEFAULTS, value: number) => {
    const before = await app.prisma.appConfig.findUnique({ where: { key } });
    if (!(key in originalLimits)) {
      originalLimits[key] = Number(before?.value ?? APP_CONFIG_DEFAULTS[key]);
    }
    await app.prisma.appConfig.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value) },
    });
    invalidateLimitsCache();
  };

  const createSource = (cookie: string, spaceId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/spaces/${spaceId}/sources`,
      headers: { cookie },
      payload,
    });

  const listSources = (cookie: string, spaceId: string) =>
    app.inject({ method: 'GET', url: `/spaces/${spaceId}/sources`, headers: { cookie } });

  beforeAll(async () => {
    app = await startTestApp();
    // Restore the seeded limits so this suite's AppConfig edits never depend on,
    // or leak into, a previous run.
    for (const [key, value] of Object.entries(APP_CONFIG_DEFAULTS)) {
      await app.prisma.appConfig.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      });
    }
    invalidateLimitsCache();
    // A real purge worker so `DELETE /sources/:id` end-to-end removes the
    // stored original — the route enqueues, this consumes.
    purgeWorker = new Worker(
      PURGE_QUEUE_NAME,
      (job) => removeObject(job.data.key),
      { connection: createBullConnection() },
    );
  });

  afterAll(async () => {
    // Restore any AppConfig rows this suite rewrote so other suites see seeds.
    for (const [key, value] of Object.entries(originalLimits)) {
      await app.prisma.appConfig.update({ where: { key }, data: { value: String(value) } });
    }
    invalidateLimitsCache();
    await purgeWorker.close();
    await cleanupUsers(app, emails);
    for (const key of keysToClean) await removeObject(key).catch(() => {});
    await app.close();
  });

  const waitForGone = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('condition never became true');
  };

  it('creates a manual source in processing, records source.added, and lists it', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Sources home');

    const response = await createSource(cookie, spaceId, {
      type: 'manual',
      title: 'A pasted excerpt',
      content: 'Memory is consolidated during sleep.',
      author: 'Self',
    });
    expect(response.statusCode).toBe(201);
    const source = response.json().source;
    expect(source).toMatchObject({
      type: 'manual',
      title: 'A pasted excerpt',
      author: 'Self',
      state: 'processing',
      errorMessage: null,
    });

    const activity = await app.prisma.activity.findFirst({
      where: { refId: source.id },
    });
    expect(activity?.kind).toBe('source.added');

    const list = await listSources(cookie, spaceId);
    expect(list.json().sources.map((s: { id: string }) => s.id)).toEqual([source.id]);
  });

  it('rejects malformed web and manual input with field messages', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Validation');

    const badUrl = await createSource(cookie, spaceId, { type: 'web', url: 'not a url' });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json().error.fields.url).toBe('Enter a valid web address.');

    const ftp = await createSource(cookie, spaceId, { type: 'web', url: 'ftp://example.com/x' });
    expect(ftp.statusCode).toBe(400);

    const noTitle = await createSource(cookie, spaceId, { type: 'manual', content: 'x' });
    expect(noTitle.statusCode).toBe(400);
    // zod v4 reports a missing required string with its base type message; the
    // field is still anchored so the form can point at it (PRD §16).
    expect(noTitle.json().error.fields.title).toMatch(/expected string/);

    const blankTitle = await createSource(cookie, spaceId, { type: 'manual', title: '   ', content: 'x' });
    expect(blankTitle.statusCode).toBe(400);
    expect(blankTitle.json().error.fields.title).toBe('Give this text a title.');

    const noContent = await createSource(cookie, spaceId, { type: 'manual', title: 'T' });
    expect(noContent.statusCode).toBe(400);
    expect(noContent.json().error.fields.content).toMatch(/expected string/);

    const blankContent = await createSource(cookie, spaceId, { type: 'manual', title: 'T', content: '   ' });
    expect(blankContent.statusCode).toBe(400);
    expect(blankContent.json().error.fields.content).toBe('Add some text to make into a source.');
  });

  it('enforces manual_max_chars from AppConfig without a restart', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Char cap');

    await setLimit('manual_max_chars', 20);
    const over = await createSource(cookie, spaceId, {
      type: 'manual',
      title: 'Too long',
      content: 'x'.repeat(21),
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.fields.content).toBe('Text is limited to 20 characters.');

    const under = await createSource(cookie, spaceId, {
      type: 'manual',
      title: 'Fine',
      content: 'x'.repeat(20),
    });
    expect(under.statusCode).toBe(201);
  });

  it('enforces sources_per_space from AppConfig, live', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Source cap');

    await setLimit('sources_per_space', 2);
    const first = await createSource(cookie, spaceId, { type: 'manual', title: 'One', content: 'a' });
    const second = await createSource(cookie, spaceId, { type: 'manual', title: 'Two', content: 'b' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const third = await createSource(cookie, spaceId, { type: 'manual', title: 'Three', content: 'c' });
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe('sources_limit');

    // The limit raised without touching the code (a new AppConfig write) is
    // picked up within the cache TTL — the reload here simulates that boundary.
    await setLimit('sources_per_space', 50);
    const fourth = await createSource(cookie, spaceId, { type: 'manual', title: 'Four', content: 'd' });
    expect(fourth.statusCode).toBe(201);
  });

  it('uploads a PDF, and rejects a non-PDF, an empty file, and an oversize one', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'PDF upload');
    const tinyPdf = buildMinimalPdf(['BT /F1 24 Tf 72 720 Td (small) Tj ET']);

    const ok = await uploadPdf(app, cookie, spaceId, tinyPdf, 'tiny.pdf');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().source).toMatchObject({ type: 'pdf', title: 'tiny', state: 'processing' });

    const notPdf = await uploadPdf(
      app,
      cookie,
      spaceId,
      Buffer.from('just text'),
      'notes.txt',
      'text/plain',
    );
    expect(notPdf.statusCode).toBe(400);
    expect(notPdf.json().error.fields.file).toBe('Only PDF files can be uploaded.');

    const empty = await uploadPdf(app, cookie, spaceId, Buffer.alloc(0), 'empty.pdf');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.fields.file).toBe('This PDF file is empty.');

    // A tiny limit makes every fixture oversize: 413, never trusting the
    // client's Content-Length (design "Limits are enforced where they are
    // knowable").
    await setLimit('pdf_max_bytes', 200);
    const oversized = await uploadPdf(app, cookie, spaceId, tinyPdf, 'big.pdf');
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe('payload_too_large');
  });

  it('answers 401 anonymously and 404 for another user’s source', async () => {
    const owner = await newUser();
    const stranger = await freshUser();
    const spaceId = await createSpace(app, owner.cookie, 'Ownership');
    const source = (await createSource(owner.cookie, spaceId, { type: 'manual', title: 'Mine', content: 'x' })).json().source;

    const routes: Array<[string, string]> = [
      ['GET', `/spaces/${spaceId}/sources`],
      ['GET', `/sources/${source.id}`],
      ['POST', `/sources/${source.id}/retry`],
      ['DELETE', `/sources/${source.id}`],
    ];

    for (const [method, url] of routes) {
      const foreign = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie: stranger.cookie },
      });
      // 404, never 403: a 403 would confirm the id exists (PRD §17).
      expect(foreign.statusCode, `${method} ${url} foreign`).toBe(404);
      expect(foreign.json().error.code).toBe('not_found');

      const anonymous = await app.inject({ method: method as 'GET', url });
      expect(anonymous.statusCode, `${method} ${url} anonymous`).toBe(401);
    }
  });

  it('rejects retry unless the source is failed, and retries a failed source', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Retry');
    const processing = (await createSource(cookie, spaceId, { type: 'manual', title: 'Running', content: 'x' })).json().source;

    const inProgress = await app.inject({
      method: 'POST',
      url: `/sources/${processing.id}/retry`,
      headers: { cookie },
    });
    expect(inProgress.statusCode).toBe(409);
    expect(inProgress.json().error.code).toBe('source_not_failed');

    const failed = await app.prisma.source.update({
      where: { id: processing.id },
      data: { state: 'failed', errorMessage: 'Try once more.' },
    });

    const retried = await app.inject({
      method: 'POST',
      url: `/sources/${failed.id}/retry`,
      headers: { cookie },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().source.state).toBe('processing');
    expect(retried.json().source.errorMessage).toBeNull();
  });

  it('freezes archived spaces for source writes, retry included, while delete stays allowed', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Frozen');
    const source = (await createSource(cookie, spaceId, { type: 'manual', title: 'Will not process', content: 'x' })).json().source;
    await app.inject({ method: 'POST', url: `/spaces/${spaceId}/archive`, headers: { cookie } });
    await app.prisma.source.update({ where: { id: source.id }, data: { state: 'failed' } });

    const inArchived = await createSource(cookie, spaceId, { type: 'manual', title: 'No', content: 'x' });
    expect(inArchived.statusCode).toBe(409);
    expect(inArchived.json().error.code).toBe('space_archived');

    // REQ-100 names upload alongside create. The route refuses it before the
    // body reaches the object store, so the refusal must still read the same.
    const uploadArchived = await uploadPdf(
      app,
      cookie,
      spaceId,
      buildMinimalPdf(['BT /F1 24 Tf 72 720 Td (frozen) Tj ET']),
      'frozen.pdf',
    );
    expect(uploadArchived.statusCode).toBe(409);
    expect(uploadArchived.json().error.code).toBe('space_archived');
    expect(await app.prisma.source.count({ where: { spaceId, type: 'pdf' } })).toBe(0);

    const retryArchived = await app.inject({
      method: 'POST',
      url: `/sources/${source.id}/retry`,
      headers: { cookie },
    });
    expect(retryArchived.statusCode).toBe(409);
    expect(retryArchived.json().error.code).toBe('space_archived');

    // Delete is how the user cleans up: archiving must not be a trap.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/sources/${source.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);
  });

  /**
   * REQ-087. The failure mode this guards is silent: the row is created, the
   * enqueue throws, and without the compensating write the source sits in
   * `processing` with no job behind it — a spinner that never resolves and no
   * Retry offered, because Retry is gated on `failed`.
   */
  it('marks a source failed when its ingest job cannot be queued', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Queue down');
    const add = vi
      .spyOn(app.ingestQueue, 'add')
      .mockRejectedValue(new Error('redis unreachable'));

    try {
      const created = await createSource(cookie, spaceId, {
        type: 'manual',
        title: 'Nothing will process this',
        content: 'x',
      });
      expect(created.statusCode).toBe(201);

      const source = created.json().source;
      expect(source.state).toBe('failed');
      expect(source.errorMessage).toMatch(/could not be started/i);
      // §16: a message a user can act on, with no internals in it.
      expect(source.errorMessage).not.toMatch(/redis|queue|bullmq|error/i);

      const activity = await app.prisma.activity.findFirst({
        where: { spaceId, refId: source.id, kind: 'source.failed' },
      });
      expect(activity).not.toBeNull();

      // The recovery path is the ordinary one: Retry is reachable because the
      // state guard sees `failed`.
      add.mockRestore();
      const retried = await app.inject({
        method: 'POST',
        url: `/sources/${source.id}/retry`,
        headers: { cookie },
      });
      expect(retried.statusCode).toBe(200);
      expect(retried.json().source.state).toBe('processing');
    } finally {
      add.mockRestore();
    }
  });

  it('permanently deletes a source: row, passages, citations, and the stored original', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Permanent delete');
    const source = await app.prisma.source.create({
      data: { spaceId, type: 'pdf', title: 'Doomed', state: 'processing' },
    });
    const key = keyFor(spaceId, source.id);
    const input = new PassThrough();
    input.end(Buffer.from('doomed pdf bytes'));
    await putObject(input, { key, contentType: 'application/pdf', maxBytes: 10_000 });
    await app.prisma.source.update({ where: { id: source.id }, data: { fileKey: key } });
    keysToClean.push(key);

    // Hand-seed the attached rows the worker would have written.
    const passage = await app.prisma.passage.create({
      data: { sourceId: source.id, ord: 1, text: 'doomed', page: 1 },
    });
    const citation = await app.prisma.citation.create({
      data: { sourceId: source.id, passageId: passage.id, quotedText: 'doomed' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/sources/${source.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);

    expect(await app.prisma.source.findUnique({ where: { id: source.id } })).toBeNull();
    expect(await app.prisma.passage.findUnique({ where: { id: passage.id } })).toBeNull();
    expect(await app.prisma.citation.findUnique({ where: { id: citation.id } })).toBeNull();

    // The queued purge job removes the object from the bucket (PRD §17).
    await waitForGone(async () => {
      try {
        await getObject(key);
        return false;
      } catch {
        return true;
      }
    });
  });
});