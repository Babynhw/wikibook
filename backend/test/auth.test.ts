import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, registerUser, sessionCookie, startTestApp, uniqueEmail } from './helpers.js';

/** PRD §3 acceptance criteria, exercised through the HTTP layer. */
describe('auth', () => {
  let app: FastifyInstance;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('registers a user and starts a session', async () => {
    const email = uniqueEmail();
    emails.push(email);
    const { response, cookie } = await registerUser(app, email);

    expect(response.statusCode).toBe(201);
    expect(response.json().user.email).toBe(email);
    expect(response.json().user).not.toHaveProperty('passwordHash');
    expect(cookie).toMatch(/^sid=.+/);

    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
  });

  it('keeps the session across requests and drops it on logout', async () => {
    const email = uniqueEmail();
    emails.push(email);
    const { cookie } = await registerUser(app, email);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);

    // Server-side session deletion: the same cookie must not work a second time.
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('rejects private routes without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('logs in with valid credentials and rejects a wrong password identically to an unknown email', async () => {
    const email = uniqueEmail();
    emails.push(email);
    await registerUser(app, email);

    const good = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct horse battery' },
    });
    expect(good.statusCode).toBe(200);
    expect(sessionCookie(app, good.headers)).toMatch(/^sid=.+/);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'not the password' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: uniqueEmail('nobody'), password: 'not the password' },
    });

    expect(wrongPassword.statusCode).toBe(unknownEmail.statusCode);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('does not reveal whether an email exists on register or forgot', async () => {
    const email = uniqueEmail();
    emails.push(email);
    await registerUser(app, email);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { name: 'Someone Else', email, password: 'another good password' },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(JSON.stringify(duplicate.json())).not.toMatch(/exists|taken|registered/i);

    const known = await app.inject({ method: 'POST', url: '/auth/forgot', payload: { email } });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/forgot',
      payload: { email: uniqueEmail('nobody') },
    });

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual(unknown.json());
  });

  it('resets a password with a single-use token and invalidates existing sessions', async () => {
    const email = uniqueEmail();
    emails.push(email);
    const { cookie, userId } = await registerUser(app, email);

    const forgot = await app.inject({ method: 'POST', url: '/auth/forgot', payload: { email } });
    expect(forgot.statusCode).toBe(200);

    // The token itself is only logged (no email provider yet), so the test reads
    // the row the way the delivery step would.
    const tokenRow = await app.prisma.passwordResetToken.findFirst({
      where: { userId, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(tokenRow).not.toBeNull();

    const badReset = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token: 'clearly-not-a-real-token', password: 'brand new password' },
    });
    expect(badReset.statusCode).toBe(400);
    expect(badReset.json().error.code).toBe('invalid_reset_token');

    // A failed reset changes nothing: the original session still works.
    const stillMe = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(stillMe.statusCode).toBe(200);

    // Tokens are only ever stored hashed and the plaintext is logged, not
    // returned, so the test plants a token the same way delivery would read it.
    const plaintext = 'test-reset-token-' + userId;
    await app.prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const reset = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token: plaintext, password: 'a brand new password' },
    });
    expect(reset.statusCode).toBe(200);

    // Reset invalidates every existing session.
    const afterReset = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(afterReset.statusCode).toBe(401);

    // Single use: the same token cannot be replayed.
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token: plaintext, password: 'yet another password' },
    });
    expect(replay.statusCode).toBe(400);

    // The new password works, the old one does not.
    const withNew = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'a brand new password' },
    });
    expect(withNew.statusCode).toBe(200);

    const withOld = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct horse battery' },
    });
    expect(withOld.statusCode).toBe(400);
  });

  it('validates input without leaking internals', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { name: '', email: 'not-an-email', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body)).not.toMatch(/at Object|node_modules|\.ts:/);
  });
});
