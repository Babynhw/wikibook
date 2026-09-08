import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import { keyFor, putObject, getObject, removeObject } from '../src/lib/storage.js';
import { AppError } from '../src/lib/errors.js';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('object storage', () => {
  let app: FastifyInstance;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('trips the byte cap mid-upload, leaves no partial object, and stays idempotent on remove', async () => {
    keyFor('space-x', 'source-cap');
    const key = `spaces/space-x/sources/source-cap/original.pdf`;

    let err: unknown = null;
    try {
      const input = new PassThrough();
      input.write(Buffer.alloc(1_024, 'a'));
      input.end(Buffer.alloc(1_024, 'b'));
      await putObject(input, { key, contentType: 'application/pdf', maxBytes: 1_500 });
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(413);
    expect((err as AppError).message).toMatch(/byte limit/);

    // No partial object survives the abort (PRD §17, design "Original files
    // live in an S3-compatible object store").
    await expect(getObject(key)).rejects.toThrow();

    // Deleting a missing or already-deleted object is a no-op, not an error.
    await removeObject(key);
    await removeObject(key);
  });

  it('proxies the preserved file through the API and forwards Range (design "Original files are proxied, not presigned")', async () => {
    const email = uniqueEmail('storage');
    emails.push(email);
    const { cookie } = await registerUser(app, email);
    const spaceId = await createSpace(app, cookie, 'Storage proxy');
    const source = await app.prisma.source.create({
      data: { spaceId, type: 'pdf', title: 'Proxied', state: 'processing' },
    });
    const key = keyFor(spaceId, source.id);
    const bytes = Buffer.from('0123456789abcdefghij');

    const input = new PassThrough();
    input.end(bytes);
    await putObject(input, { key, contentType: 'application/pdf', maxBytes: 100 });
    await app.prisma.source.update({ where: { id: source.id }, data: { fileKey: key } });

    // Full read.
    const full = await app.inject({
      method: 'GET',
      url: `/sources/${source.id}/file`,
      headers: { cookie },
    });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.toString()).toBe('0123456789abcdefghij');

    // A 206 with a Content-Range that survives the hop, for the Phase 3 reader.
    const ranged = await app.inject({
      method: 'GET',
      url: `/sources/${source.id}/file`,
      headers: { cookie, range: 'bytes=2-7' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.toString()).toBe('234567');
    expect(ranged.headers['content-range']).toBe('bytes 2-7/20');

    // No storage endpoint or credential reaches the client (PRD §17).
    expect(JSON.stringify(full.headers)).not.toMatch(/9000|s3|minio|wikibooklm-secret/);

    await removeObject(key);
  });

  it('answers 404 for a file with no object behind it', async () => {
    const email = uniqueEmail('storage');
    emails.push(email);
    const { cookie } = await registerUser(app, email);
    const spaceId = await createSpace(app, cookie, 'Missing file');
    const source = await app.prisma.source.create({
      data: { spaceId, type: 'pdf', title: 'No object', state: 'processing', fileKey: keyFor(spaceId, 'ghost') },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/sources/${source.id}/file`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });

  it('round-trips an object with its metadata intact', async () => {
    const key = `spaces/space-m/sources/source-m/original.pdf`;
    const input = new PassThrough();
    input.end(Buffer.from('metadata test body'));
    await putObject(input, {
      key,
      contentType: 'application/pdf',
      filename: 'my research paper.PDF',
      maxBytes: 1_000,
    });

    const object = await getObject(key);
    expect(await streamToBuffer(object.body)).toEqual(Buffer.from('metadata test body'));

    await removeObject(key);
  });
});