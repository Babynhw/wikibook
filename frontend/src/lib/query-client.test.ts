import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { authKeys } from '@/features/auth/use-auth';

/** REQ-018 — a 401 from *any* request means the session ended. */
describe('createQueryClient', () => {
  it('marks the session lost when a background query answers 401', async () => {
    const client = createQueryClient();
    client.setQueryData(authKeys.me, { id: 'u1', name: 'A', email: 'a@example.com' });

    // Any endpoint, not just /auth/me — here the health poll on the home screen.
    await client
      .fetchQuery({
        queryKey: ['health'],
        queryFn: () => {
          throw new ApiError(401, 'unauthorized', 'You need to sign in to continue.');
        },
      })
      .catch(() => undefined);

    // null, not undefined: the guard reads this as "signed out" and redirects,
    // rather than as "not loaded yet".
    expect(client.getQueryData(authKeys.me)).toBeNull();
  });

  it('marks the session lost when a mutation answers 401', async () => {
    const client = createQueryClient();
    client.setQueryData(authKeys.me, { id: 'u1', name: 'A', email: 'a@example.com' });

    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => {
        throw new ApiError(401, 'unauthorized', 'You need to sign in to continue.');
      },
      retry: false,
    });
    await mutation.execute(undefined).catch(() => undefined);

    expect(client.getQueryData(authKeys.me)).toBeNull();
  });

  it('leaves the session alone for failures that are not a 401', async () => {
    const client = createQueryClient();
    const user = { id: 'u1', name: 'A', email: 'a@example.com' };
    client.setQueryData(authKeys.me, user);

    await client
      .fetchQuery({
        queryKey: ['health'],
        queryFn: () => {
          throw new ApiError(0, 'network_error', 'We could not reach the server.');
        },
        retry: false,
      })
      .catch(() => undefined);

    // A server we cannot reach says nothing about whether the session is valid.
    expect(client.getQueryData(authKeys.me)).toEqual(user);
  });

  describe('retry policy', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    const decide = (failureCount: number, error: Error) =>
      typeof retry === 'function' ? retry(failureCount, error) : retry;

    it('does not retry a 4xx — it would only delay the error the user needs', () => {
      expect(decide(0, new ApiError(400, 'validation_failed', 'Check the fields.'))).toBe(false);
      expect(decide(0, new ApiError(401, 'unauthorized', 'Sign in.'))).toBe(false);
    });

    it('retries a 5xx and a transport failure, up to twice', () => {
      const serverError = new ApiError(500, 'internal_error', 'Something went wrong.');
      expect(decide(0, serverError)).toBe(true);
      expect(decide(1, serverError)).toBe(true);
      expect(decide(2, serverError)).toBe(false);
      expect(decide(0, new ApiError(0, 'network_error', 'Unreachable.'))).toBe(true);
    });
  });
});
