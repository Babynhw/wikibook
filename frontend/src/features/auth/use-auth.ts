import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, authApi, type User } from '@/lib/api';

export const authKeys = {
  me: ['auth', 'me'] as const,
};

/**
 * Hydrates the session from the server on load, so a refresh keeps the user
 * signed in (PRD §3). A 401 is a normal answer here, not an error to retry.
 */
export function useCurrentUser() {
  return useQuery<User | null>({
    queryKey: authKeys.me,
    queryFn: async () => {
      try {
        const { user } = await authApi.me();
        return user;
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ user }) => queryClient.setQueryData(authKeys.me, user),
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.register,
    onSuccess: ({ user }) => queryClient.setQueryData(authKeys.me, user),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      // Everything cached belongs to the user who just left. Clear first, then
      // plant the signed-out state — the other order has `clear()` erase it,
      // leaving the guard to refetch `/auth/me` against a dead session while
      // the authenticated shell is still mounted.
      queryClient.clear();
      queryClient.setQueryData(authKeys.me, null);
    },
  });
}

export function useForgotPassword() {
  return useMutation({ mutationFn: authApi.forgot });
}

export function useResetPassword() {
  return useMutation({ mutationFn: authApi.reset });
}
