import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * Builds the real app. `register` runs before `ready()` so a test can add its
 * own routes — Fastify refuses new routes once the instance is listening.
 */
export async function startTestApp(
  register?: (app: FastifyInstance) => void | Promise<void>,
): Promise<FastifyInstance> {
  const app = await buildApp();
  if (register) await register(app);
  await app.ready();
  return app;
}

let counter = 0;

/** Unique per call so a re-run never collides with rows a previous run left. */
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}+${process.pid}-${counter}-${Date.now()}@example.test`;
}

/** Extracts the session cookie value from a set-cookie header list. */
export function sessionCookie(app: FastifyInstance, headers: unknown): string | null {
  const raw = (headers as Record<string, string | string[] | undefined>)['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const cookie of cookies) {
    const match = /^sid=([^;]*)/.exec(cookie);
    if (match && match[1]) return `sid=${match[1]}`;
  }
  return null;
}

/**
 * Registers a user and returns its session cookie.
 *
 * `/auth/register` is rate-limited to 10 per minute per client, and every suite
 * shares one budget because the limiter is in-memory per app instance. A suite
 * that registers an eleventh user gets no cookie back, and without the throw
 * below that surfaces as an unrelated 401 several requests later — reuse a user
 * across tests that do not need isolation rather than raising the count.
 */
export async function registerUser(app: FastifyInstance, email = uniqueEmail()) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { name: 'Test Person', email, password: 'correct horse battery' },
  });

  const cookie = sessionCookie(app, response.headers);
  if (!cookie) {
    throw new Error(
      `registerUser got no session cookie (status ${response.statusCode}): ${response.body}`,
    );
  }

  return {
    response,
    email,
    cookie,
    userId: (response.json() as { user?: { id: string } }).user?.id ?? '',
  };
}

/** Removes every row this suite could have created, by email prefix. */
export async function cleanupUsers(app: FastifyInstance, emails: string[]) {
  if (emails.length === 0) return;
  await app.prisma.user.deleteMany({ where: { email: { in: emails } } });
}

/** Creates a space for an already-registered user and returns its id. */
export async function createSpace(
  app: FastifyInstance,
  cookie: string,
  name = 'Sleep and memory',
  payload: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/spaces',
    headers: { cookie },
    payload: { name, ...payload },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createSpace failed (${response.statusCode}): ${response.body}`);
  }
  return (response.json() as { space: { id: string } }).space.id;
}

/**
 * Builds a multipart body for a single `file` field and posts it. The manual
 * boundary keeps the fixture bytes intact through `app.inject`.
 */
export async function uploadPdf(
  app: FastifyInstance,
  cookie: string,
  spaceId: string,
  body: Buffer,
  filename = 'fixture.pdf',
  contentType = 'application/pdf',
) {
  const boundary = `----wikibooklm-test-${Date.now()}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const multipart = Buffer.concat([Buffer.from(head), body, Buffer.from(tail)]);

  return app.inject({
    method: 'POST',
    url: `/spaces/${spaceId}/sources/upload`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipart,
  });
}
