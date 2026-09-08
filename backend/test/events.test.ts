import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';

type SseHandle = {
  nextEvent: (ms?: number) => Promise<unknown>;
  /** Every received SSE block (data lines and comments), for heartbeat checks. */
  blocks: () => string[];
  close: () => void;
  ended: Promise<void>;
};

/** Opens a real TCP SSE stream so hijacked responses are exercised for real.
 * A fresh non-keep-alive agent per connection: Node's global agent can route a
 * second request onto the first hijacked SSE socket, which never closes. */
function openSse(baseUrl: string, cookie: string, spaceId: string): Promise<SseHandle> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}/spaces/${spaceId}/events`,
      { headers: { Cookie: cookie }, agent: new http.Agent({ keepAlive: false }) },
      (res) => {
      const allBlocks: string[] = [];
      const queue: unknown[] = [];
      const waiters: Array<(payload: unknown) => void> = [];
      let buffer = '';
      let endedResolve: () => void = () => {};

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          allBlocks.push(block);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            const payload = JSON.parse(line.slice(6));
            const waiter = waiters.shift();
            if (waiter) waiter(payload);
            else queue.push(payload);
          }
        }
      });

      resolve({
        nextEvent(ms = 3_000) {
          if (queue.length > 0) return Promise.resolve(queue.shift());
          return new Promise((resolveNext, rejectNext) => {
            const timer = setTimeout(() => rejectNext(new Error('timed out waiting for SSE event')), ms);
            waiters.push((payload) => {
              clearTimeout(timer);
              resolveNext(payload);
            });
          });
        },
        blocks: () => [...allBlocks],
        close: () => req.destroy(),
        ended: new Promise((resolveEnd) => {
          endedResolve = resolveEnd;
          res.on('end', resolveEnd);
          res.on('close', resolveEnd);
        }),
      });
    });
    req.on('error', reject);
  });
}

describe('space events (SSE)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const emails: string[] = [];
  const openStreams: SseHandle[] = [];

  beforeAll(async () => {
    app = await startTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const stream of openStreams) stream.close();
    openStreams.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  const newUser = async () => {
    const email = uniqueEmail('events');
    emails.push(email);
    const { cookie } = await registerUser(app, email);
    return { cookie };
  };

  const stream = async (cookie: string, spaceId: string) => {
    const handle = await openSse(baseUrl, cookie, spaceId);
    openStreams.push(handle);
    return handle;
  };

  it('rejects a foreign or anonymous stream with 404/401 before any socket opens', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const spaceId = await createSpace(app, owner.cookie, 'Events ownership');

    const foreign = await app.inject({
      method: 'GET',
      url: `/spaces/${spaceId}/events`,
      headers: { cookie: stranger.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('not_found');

    const anonymous = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/events` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('delivers a state event published to the space channel to a subscribed client', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Relay');
    const handle = await stream(cookie, spaceId);

    await app.events.publish(`space:${spaceId}`, { sourceId: 's-1', state: 'ready' });

    await expect(handle.nextEvent()).resolves.toEqual({ sourceId: 's-1', state: 'ready' });
  });

  it('sends a keep-alive heartbeat comment while the stream idles', async () => {
    // Capture the real setInterval before spying, so the wrapper only intercepts
    // the route's 15s heartbeat and passes everything else straight through.
    const realSetInterval = globalThis.setInterval;
    const heartbeats: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number) => {
      if (ms === 15_000) heartbeats.push(callback);
      return realSetInterval(callback, ms);
    }) as typeof setInterval);

    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Heartbeat');
    const handle = await stream(cookie, spaceId);

    heartbeats.forEach((callback) => callback());

    await vi.waitFor(() => {
      expect(handle.blocks().some((block) => block.startsWith(': keep-alive'))).toBe(true);
    });
  });

  it('caps concurrent streams per user', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Cap');
    const cap = Number(process.env.SSE_MAX_CONNECTIONS_PER_USER ?? 3);
    console.error('CAPTEST: start');

    for (let i = 0; i < cap; i++) {
      console.error('CAPTEST: opening', i);
      await stream(cookie, spaceId);
    }

    const beyond = await app.inject({
      method: 'GET',
      url: `/spaces/${spaceId}/events`,
      headers: { cookie },
    });
    console.error('CAPTEST: beyond', beyond.statusCode);
    expect(beyond.statusCode).toBe(429);
    expect(beyond.json().error.code).toBe('too_many_requests');

    // Releasing one connection frees a slot again — and the freed stream opens
    // as a real connection (the 429 path is the only one that answers via inject).
    console.error('CAPTEST: closing one');
    openStreams.pop()?.close();
    console.error('CAPTEST: opening freed');
    const freed = await stream(cookie, spaceId);
    console.error('CAPTEST: freed opened');
    freed.close();
  });

  it('tears the stream down when the user signs out', async () => {
    const { cookie } = await newUser();
    const spaceId = await createSpace(app, cookie, 'Sign out');
    const handle = await stream(cookie, spaceId);

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);

    await expect(handle.ended).resolves.toBeUndefined();
  });

  /**
   * A reset invalidates every session, so it has to close every stream those
   * sessions hold — and it is the one teardown whose request is *not* the
   * stream's owner. `/auth/reset` is the unauthenticated link-click path, so a
   * teardown keyed on `request.user` closes nothing in exactly the case the
   * requirement exists for: someone else holding a live stream.
   */
  it('tears the stream down when the password is reset from an unauthenticated request', async () => {
    const email = uniqueEmail('events');
    emails.push(email);
    const { cookie, userId } = await registerUser(app, email);
    const spaceId = await createSpace(app, cookie, 'Reset');
    const handle = await stream(cookie, spaceId);

    // Planted the way the delivery step would read it: only the hash is stored.
    const plaintext = `events-reset-token-${userId}`;
    await app.prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // No cookie: the reset arrives from whatever browser opened the email link.
    const reset = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token: plaintext, password: 'a brand new password' },
    });
    expect(reset.statusCode).toBe(200);

    await expect(handle.ended).resolves.toBeUndefined();
  });
});