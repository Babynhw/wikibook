import { describe, expect, it } from 'vitest';
import { ApiError, api, authApi, request } from '@/lib/api';
import { jsonResponse, stubFetch } from '@/test/utils';

describe('request', () => {
  it('sends the session cookie and returns the parsed body', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ user: { id: 'u1' } }));

    await expect(authApi.me()).resolves.toEqual({ user: { id: 'u1' } });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/me');
    expect(init?.credentials).toBe('include');
    // No body, so no content-type is invented for a GET.
    expect(init?.headers).toEqual({});
  });

  it('serializes a body as JSON and declares the content type', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));

    await api.post('/auth/logout', { a: 1 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.body).toBe('{"a":1}');
  });

  it('resolves 204 to undefined without parsing a body', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    await expect(request('/whatever', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  describe('failures', () => {
    it('normalizes the error envelope, including field messages (REQ-051)', async () => {
      stubFetch(() =>
        jsonResponse(
          {
            error: {
              code: 'validation_failed',
              message: 'Please check the highlighted fields and try again.',
              fields: { password: 'Must be at least 8 characters.' },
            },
          },
          400,
        ),
      );

      const error = await authApi.login({ email: 'a@example.com', password: 'x' }).catch((e) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(400);
      expect(error.code).toBe('validation_failed');
      expect(error.message).toBe('Please check the highlighted fields and try again.');
      expect(error.fields).toEqual({ password: 'Must be at least 8 characters.' });
      expect(error.isUnauthorized).toBe(false);
    });

    it('flags a 401 as unauthorized (REQ-015)', async () => {
      stubFetch(() =>
        jsonResponse({ error: { code: 'unauthorized', message: 'You need to sign in.' } }, 401),
      );

      const error = await authApi.me().catch((e) => e);

      expect(error.isUnauthorized).toBe(true);
      expect(error.code).toBe('unauthorized');
    });

    it('falls back to a readable message when an error body has no envelope', async () => {
      stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

      const error = await authApi.me().catch((e) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(502);
      expect(error.code).toBe('request_failed');
      expect(error.message).toBe('That request could not be completed.');
      expect(error.fields).toEqual({});
    });

    it('falls back when the error body claims JSON but does not parse', async () => {
      stubFetch(
        () =>
          new Response('{"error": ', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const error = await authApi.me().catch((e) => e);

      expect(error.code).toBe('request_failed');
    });

    it('rejects a 2xx that is not the JSON we expect, rather than returning null', async () => {
      // A proxy that answers HTML with a 200 must fail here — handing `null`
      // back as `T` only moves the failure into a caller's destructuring.
      stubFetch(() => new Response('<html>hello</html>', { status: 200 }));

      const error = await authApi.me().catch((e) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe('malformed_response');
      expect(error.status).toBe(200);
    });

    it('turns a transport failure into a readable message, not a TypeError', async () => {
      stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

      const error = await authApi.me().catch((e) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(0);
      expect(error.code).toBe('network_error');
      expect(error.message).toMatch(/could not reach the server/i);
    });
  });
});
