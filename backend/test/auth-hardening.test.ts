import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, registerUser, startTestApp, uniqueEmail } from './helpers.js';

/**
 * Failure paths where the *shape* of the answer is the requirement: a response
 * that differs from the standard rejection is an account-existence oracle, even
 * when it discloses nothing directly.
 *
 * Deliberately a separate app instance from `auth.test.ts`. `@fastify/rate-limit`
 * keeps an in-memory bucket per route per instance, and `/auth/register` allows
 * 10/minute — these suites together would exceed it and start answering 429.
 */
describe('auth hardening', () => {
  let app: FastifyInstance;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('answers two concurrent registrations for one address the same as a duplicate', async () => {
    const email = uniqueEmail('race');
    emails.push(email);

    // Both requests clear the existence pre-check before either insert lands, so
    // the unique constraint is what rejects the loser. Before the fix that
    // surfaced as 500 / internal_error — distinguishable from every other
    // rejected registration, which is exactly what REQ-004 forbids.
    const payload = { name: 'Racer', email, password: 'correct horse battery' };
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/register', payload }),
      app.inject({ method: 'POST', url: '/auth/register', payload }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 400]);

    const loser = first.statusCode === 400 ? first : second;
    expect(loser.json().error.code).toBe('registration_failed');
    expect(JSON.stringify(loser.json())).not.toMatch(/exists|taken|registered/i);

    // Byte-identical to a plain sequential duplicate.
    const sequential = await app.inject({ method: 'POST', url: '/auth/register', payload });
    expect(sequential.statusCode).toBe(400);
    expect(loser.json()).toEqual(sequential.json());
  });

  it('rejects a login against a corrupt stored hash as invalid credentials, not a 500', async () => {
    const email = uniqueEmail('corrupt');
    emails.push(email);
    const { userId } = await registerUser(app, email);

    // A hash argon2 cannot parse — a bad migration, or a hand-edited row.
    await app.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: 'not-an-argon2-hash' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct horse battery' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_credentials');

    // Indistinguishable from any other failed sign-in (REQ-021).
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: uniqueEmail('nobody'), password: 'whatever' },
    });
    expect(response.json()).toEqual(unknown.json());
  });
});
