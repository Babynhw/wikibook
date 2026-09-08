import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { buildApp, REDACT_PATHS, scrubUrl } from '../src/app.js';

/**
 * PRD §17: "application logs must not contain full source, note, notebook, or
 * conversation content by default". The app is built with a capturing pino
 * stream, a test-only route logs its body and headers the careless way, and
 * the capture is searched for the secrets.
 */
const CONTENT = 'REDACTION-CANARY-notebook-paragraph-7f3a';
const PASSWORD = 'REDACTION-CANARY-password-91bc';
const COOKIE = 'sid=REDACTION-CANARY-session-55d0';
const EMAIL = 'redaction-canary-91bc@example.test';
const INVITE_TOKEN = 'REDACTION-CANARY-invite-token-4b2e';

describe('log redaction (PRD §17)', () => {
  let app: FastifyInstance;
  const lines: string[] = [];

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    app = await buildApp({ loggerStream: stream });
    app.post('/__test/echo', async (request, reply) => {
      request.log.info({ body: request.body, headers: request.headers }, 'careless handler log');
      request.log.info({ req: request }, 'request object log');
      return reply.send({ ok: true });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists every content field the API accepts', () => {
    for (const field of ['content', 'contentRich', 'text', 'title', 'question', 'password', 'token', 'email']) {
      expect(REDACT_PATHS).toContain(`body.${field}`);
      expect(REDACT_PATHS).toContain(`req.body.${field}`);
    }
    expect(REDACT_PATHS).toContain('req.headers.cookie');
  });

  it('a handler that logs its body and headers leaks neither content nor credentials (REQ-280)', async () => {
    lines.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: '/__test/echo',
      headers: { cookie: COOKIE },
      payload: {
        contentRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: CONTENT }] }] },
        title: CONTENT,
        password: PASSWORD,
        email: EMAIL,
      },
    });
    expect(response.statusCode).toBe(200);

    const log = lines.join('');
    expect(log).toContain('careless handler log');
    expect(log).toContain('[Redacted]');
    expect(log).not.toContain(CONTENT);
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(EMAIL);
    expect(log).not.toContain('REDACTION-CANARY-session');
  });

  /**
   * A space invite *is* its token (shared-spaces-v1), and it travels in the URL
   * — which Fastify logs on every request. `redact` cannot reach it: pino's
   * paths address object keys, and this secret is a substring of one value.
   */
  it('an invite token never reaches the log, though the path still does (REQ-280)', async () => {
    lines.length = 0;
    await app.inject({ method: 'GET', url: `/invites/${INVITE_TOKEN}` });
    const log = lines.join('');
    expect(log).toContain('/invites/[Redacted]');
    expect(log).not.toContain(INVITE_TOKEN);
  });

  it('scrubUrl drops the credential and keeps every identifier around it', () => {
    expect(scrubUrl(`/invites/${INVITE_TOKEN}`)).toBe('/invites/[Redacted]');
    expect(scrubUrl(`/invites/${INVITE_TOKEN}/accept`)).toBe('/invites/[Redacted]/accept');
    // Space and source ids are identifiers, not secrets: a log that cannot name
    // the resource cannot be used to investigate anything.
    expect(scrubUrl('/spaces/space-1/members')).toBe('/spaces/space-1/members');
    expect(scrubUrl('/spaces/space-1/sources?q=sleep')).toBe('/spaces/space-1/sources?q=sleep');
  });

  it('the default request log carries the url and method, never the body', async () => {
    lines.length = 0;
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.test', password: PASSWORD },
    });
    const log = lines.join('');
    expect(log).toContain('/auth/login');
    expect(log).not.toContain(PASSWORD);
  });
});
