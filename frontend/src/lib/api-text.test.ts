import { describe, expect, it } from 'vitest';
import { ApiError, requestText } from '@/lib/api';
import { jsonResponse, stubFetch } from '@/test/utils';

describe('requestText — the Markdown export path through api.ts', () => {
  it('returns the body as text', async () => {
    stubFetch(() => new Response('# hi\n', { status: 200, headers: { 'content-type': 'text/markdown' } }));
    await expect(requestText('/spaces/s/notebook/export.md')).resolves.toBe('# hi\n');
  });

  it('turns the JSON envelope into an ApiError with status and code', async () => {
    stubFetch(() => jsonResponse({ error: { code: 'unauthorized', message: 'Sign in.' } }, 401));
    const error = await requestText('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).code).toBe('unauthorized');
    expect((error as ApiError).isUnauthorized).toBe(true);
  });

  it('a non-JSON failure and a network failure are still ApiErrors', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const bad = await requestText('/x').catch((e: unknown) => e);
    expect((bad as ApiError).code).toBe('request_failed');
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const down = await requestText('/x').catch((e: unknown) => e);
    expect((down as ApiError).code).toBe('network_error');
  });
});
