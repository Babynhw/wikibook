import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { ownershipGuards } from '../src/middleware/assert-access.js';

/**
 * PRD §17: "every space, source, conversation, note, and notebook request must
 * enforce ownership". Rather than trusting each suite to cover its own routes,
 * this walks the route table as it registers and proves the rule structurally:
 * a route with a path parameter carries an `assertAccess` guard; a route
 * without one carries `requireUser`; the only exceptions are the ones listed.
 * Adding a route without its guard fails here before it fails in production.
 *
 * Shared spaces add the role dimension: every write under a space must declare
 * `editor` or `owner`, except the writes any member may make, listed below
 * (plan/shared-spaces-v1/tasks.md "Route roles").
 */
// Logout clears whatever cookie is present; it has nothing to protect.
const PUBLIC = new Set(['/health', '/auth/register', '/auth/login', '/auth/forgot', '/auth/reset', '/auth/logout']);

/** Collections scoped by `request.user.id` in their query rather than by a URL id. */
const USER_SCOPED = new Set(['/spaces', '/activity', '/auth/me']);

/**
 * Writes a viewer may make: they touch only the caller's own state (resume,
 * their private conversations, their membership), never shared material.
 */
const VIEWER_WRITES = new Set([
  'POST /spaces/:id/open',
  'POST /spaces/:id/conversations',
  'PATCH /conversations/:id',
  'POST /conversations/:id/messages',
  'POST /messages/:id/feedback',
  'POST /spaces/:id/leave',
]);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Invite acceptance is addressed by a secret token, not a space id: the caller
 * is not a member yet, so there is no membership to assert. `requireUser` plus
 * the email match inside the handler is the check, and every failure is 404.
 */
const TOKEN_SCOPED = new Set(['/invites/:token', '/invites/:token/accept']);

const hooks = (route: RouteOptions, name: 'onRequest' | 'preHandler'): unknown[] => {
  const value = route[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
};

describe('ownership route table (PRD §17)', () => {
  let app: FastifyInstance;
  const routes: RouteOptions[] = [];

  beforeAll(async () => {
    app = await buildApp({ onRoute: (route) => routes.push(route) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const table = () =>
    routes
      // `OPTIONS *` is @fastify/cors's preflight catch-all; `/__test/*` routes are test-only.
      .filter((r) => !r.url.startsWith('/__') && r.method !== 'OPTIONS')
      .map((r) => ({
        method: Array.isArray(r.method) ? r.method.join(',') : r.method,
        url: r.url,
        requireUser: hooks(r, 'onRequest').concat(hooks(r, 'preHandler')).includes(app.requireUser),
        ownership: hooks(r, 'preHandler').some((h) => ownershipGuards.has(h as object)),
        role: hooks(r, 'preHandler')
          .map((h) => ownershipGuards.get(h as object))
          .find((role) => role !== undefined),
      }));

  it('registers the routes the API is known to have', () => {
    const urls = new Set(table().map((r) => r.url));
    for (const url of ['/spaces/:id', '/sources/:id', '/notes/:id', '/conversations/:id', '/spaces/:id/notebook', '/activity']) {
      expect(urls.has(url), url).toBe(true);
    }
    expect(urls.size).toBeGreaterThan(25);
  });

  it('every parameterised route carries an assertAccess guard (REQ-279)', () => {
    const missing = table()
      .filter((r) => r.url.includes(':') && !r.ownership && !TOKEN_SCOPED.has(r.url))
      .map((r) => `${r.method} ${r.url}`);
    expect(missing).toEqual([]);
    for (const url of TOKEN_SCOPED) {
      const rows = table().filter((r) => r.url === url);
      expect(rows.length, url).toBeGreaterThan(0);
      for (const row of rows) expect(row.requireUser, `${row.method} ${url}`).toBe(true);
    }
  });

  it('every write route under a space declares editor or owner, unless it is a viewer write', () => {
    const rows = table().filter((r) => r.url.includes(':') && WRITE_METHODS.has(r.method));
    expect(rows.length).toBeGreaterThan(10);
    const tooOpen = rows
      .filter((r) => r.role === 'viewer' && !VIEWER_WRITES.has(`${r.method} ${r.url}`))
      .map((r) => `${r.method} ${r.url}`);
    expect(tooOpen).toEqual([]);
    // And the listed viewer writes really are registered as viewer — a stale
    // allowance is as wrong as a missing role.
    for (const entry of VIEWER_WRITES) {
      const row = rows.find((r) => `${r.method} ${r.url}` === entry);
      if (row) expect(row.role, entry).toBe('viewer');
    }
  });

  it('every read route under a space is open to viewers', () => {
    const strict = table()
      .filter((r) => r.url.includes(':') && r.method === 'GET' && r.role !== 'viewer')
      // Invite and member management listings are owner-only by design.
      .filter((r) => !r.url.includes('/invites'))
      .map((r) => `${r.method} ${r.url}`);
    expect(strict).toEqual([]);
  });

  it('every non-public route without a parameter requires a user (REQ-279)', () => {
    const missing = table()
      .filter((r) => !r.url.includes(':') && !PUBLIC.has(r.url) && !r.requireUser)
      .map((r) => `${r.method} ${r.url}`);
    expect(missing).toEqual([]);
    for (const url of USER_SCOPED) expect(table().some((r) => r.url === url)).toBe(true);
  });

  it('no route outside the public set is reachable without a session', () => {
    const anonymous = table().filter((r) => !PUBLIC.has(r.url) && !r.requireUser && !r.ownership);
    expect(anonymous.map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });
});
