import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { probe } from '../src/routes/health.js';
import { startTestApp } from './helpers.js';

/**
 * `/health` is unauthenticated, so a failing probe's message is world-readable.
 * PRD §16 / REQ-050: the detail belongs in the log, not the response body.
 */
describe('health probe', () => {
  const stubLog = () => ({ warn: vi.fn() }) as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> };

  it('reports a healthy dependency with its latency', async () => {
    const log = stubLog();
    const result = await probe('db', log, true, async () => {});

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeTypeOf('number');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('passes a probe detail through on success', async () => {
    const result = await probe('embeddings', stubLog(), true, async () => 'model available');
    expect(result).toMatchObject({ ok: true, detail: 'model available' });
  });

  /**
   * A success detail is as world-readable as a failure one — `/health` is
   * unauthenticated and the queue probe reports its depth — so it is gated on
   * the same flag rather than always sent.
   */
  it('withholds the success detail when exposeDetail is false (production)', async () => {
    const result = await probe('queue', stubLog(), false, async () => 'ingest waiting=7 active=2');

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('detail');
    expect(JSON.stringify(result)).not.toContain('waiting');
  });

  it('exposes the failure detail when exposeDetail is set (development)', async () => {
    const log = stubLog();
    const result = await probe('db', log, true, async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('withholds the failure detail when exposeDetail is false (production)', async () => {
    const log = stubLog();
    const result = await probe('db', log, false, async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    });

    expect(result.ok).toBe(false);
    // The client learns that db is down and nothing about where it lives.
    expect(result).not.toHaveProperty('detail');
    expect(JSON.stringify(result)).not.toContain('5432');

    // ...but the operator still gets the whole error.
    expect(log.warn).toHaveBeenCalledOnce();
    const [payload] = log.warn.mock.calls[0] as [{ err: Error; dependency: string }];
    expect(payload.err.message).toContain('ECONNREFUSED');
    expect(payload.dependency).toBe('db');
  });

  it('reports a probe that exceeds the timeout as failed', async () => {
    const result = await probe(
      'redis',
      stubLog(),
      true,
      () => new Promise<void>(() => {}), // never settles
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timed out');
  }, 10_000);
});

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 while Postgres is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.db.ok).toBe(true);
    expect(['ok', 'degraded']).toContain(body.status);
  });

  it('sets the helmet security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
