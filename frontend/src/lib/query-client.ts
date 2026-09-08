import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { authKeys } from '@/features/auth/use-auth';
import { ApiError } from '@/lib/api';

/**
 * The app's single QueryClient. A factory rather than a module-level instance so
 * a test can build a fresh one — and so the session-lost rule below is something
 * that can actually be asserted.
 */
export function createQueryClient(): QueryClient {
  /**
   * A session can die while the user sits on a page. Whatever request notices
   * first, the answer is the same: the session is gone, so record it once here
   * and let the route guard do the redirecting. Without this, an expired session
   * surfaces as whatever generic failure the individual screen happens to render.
   */
  const onSessionLost = (error: unknown) => {
    if (error instanceof ApiError && error.isUnauthorized) {
      queryClient.setQueryData(authKeys.me, null);
    }
  };

  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: onSessionLost }),
    mutationCache: new MutationCache({ onError: onSessionLost }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // Retrying a 4xx just delays the error the user needs to see.
        retry: (failureCount, error) =>
          error instanceof ApiError && error.status >= 400 && error.status < 500
            ? false
            : failureCount < 2,
      },
    },
  });

  return queryClient;
}
