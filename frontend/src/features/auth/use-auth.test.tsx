import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { authKeys, useCurrentUser, useLogin, useLogout } from '@/features/auth/use-auth';
import { jsonResponse, stubFetch, testQueryClient } from '@/test/utils';

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com' };

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useCurrentUser', () => {
  it('resolves a 401 to null rather than an error, so "signed out" is not a failure', async () => {
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthorized', message: 'You need to sign in.' } }, 401),
    );
    const client = testQueryClient();

    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('surfaces any other failure as an error (REQ-017)', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const client = testQueryClient();

    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useLogin', () => {
  it('seeds the session cache from the response, so no extra /auth/me round-trip', async () => {
    stubFetch(() => jsonResponse({ user: USER }));
    const client = testQueryClient();

    const { result } = renderHook(() => useLogin(), { wrapper: wrapperFor(client) });
    result.current.mutate({ email: USER.email, password: 'password123' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(authKeys.me)).toEqual(USER);
  });
});

describe('useLogout', () => {
  /**
   * REQ-016 — the order of `clear()` and `setQueryData` is load-bearing, not
   * stylistic: clearing *after* planting the signed-out state erases it, and the
   * guard then refetches `/auth/me` against the session just destroyed while the
   * authenticated shell is still mounted. Do not "simplify" this to one call.
   */
  it('empties the cache and leaves the session marked signed-out, not unknown', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const client = testQueryClient();
    client.setQueryData(authKeys.me, USER);
    client.setQueryData(['health'], { status: 'ok' });
    client.setQueryData(['spaces'], [{ id: 's1' }]);

    const { result } = renderHook(() => useLogout(), { wrapper: wrapperFor(client) });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // null — "signed out" — and not undefined, which the guard reads as "not
    // loaded yet" and would answer with a refetch.
    expect(client.getQueryData(authKeys.me)).toBeNull();
    // Everything else belonged to the user who just left.
    expect(client.getQueryData(['health'])).toBeUndefined();
    expect(client.getQueryData(['spaces'])).toBeUndefined();
  });
});
