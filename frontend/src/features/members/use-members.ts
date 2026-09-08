import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { membersApi, type GrantableRole } from '@/lib/api';
import { spaceKeys } from '@/features/spaces/use-spaces';

export const memberKeys = {
  all: ['members'] as const,
  list: (spaceId: string) => ['members', 'list', spaceId] as const,
  invite: (token: string) => ['invites', token] as const,
};

/** The roster plus, for the owner, the pending invites (shared-spaces-v1). */
export function useMembers(spaceId: string) {
  return useQuery({
    queryKey: memberKeys.list(spaceId),
    queryFn: () => membersApi.list(spaceId),
    enabled: spaceId !== '',
  });
}

/**
 * Every membership mutation refetches the roster and the space: `memberCount`
 * and, after a transfer, `myRole` live on the space payload, and the rail and
 * every gated affordance read them from there.
 */
function useMemberMutation<TInput, TResult>(
  spaceId: string,
  mutationFn: (input: TInput) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: memberKeys.list(spaceId) }),
        queryClient.invalidateQueries({ queryKey: spaceKeys.detail(spaceId) }),
        queryClient.invalidateQueries({ queryKey: spaceKeys.lists }),
      ]),
  });
}

export function useInvite(spaceId: string) {
  return useMemberMutation(spaceId, (input: { email: string; role: GrantableRole }) =>
    membersApi.invite(spaceId, input),
  );
}

export function useRotateInvite(spaceId: string) {
  return useMemberMutation(spaceId, (inviteId: string) => membersApi.rotate(spaceId, inviteId));
}

export function useRevokeInvite(spaceId: string) {
  return useMemberMutation(spaceId, (inviteId: string) => membersApi.revoke(spaceId, inviteId));
}

export function useSetRole(spaceId: string) {
  return useMemberMutation(spaceId, (input: { userId: string; role: GrantableRole }) =>
    membersApi.setRole(spaceId, input.userId, input.role),
  );
}

export function useRemoveMember(spaceId: string) {
  return useMemberMutation(spaceId, (userId: string) => membersApi.remove(spaceId, userId));
}

export function useTransferOwnership(spaceId: string) {
  return useMemberMutation(spaceId, (userId: string) => membersApi.transfer(spaceId, userId));
}

/** Leaving drops every cached query for the space: the next request would 404. */
export function useLeaveSpace(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => membersApi.leave(spaceId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: spaceKeys.detail(spaceId) });
      queryClient.removeQueries({ queryKey: memberKeys.list(spaceId) });
      await queryClient.invalidateQueries({ queryKey: spaceKeys.lists });
    },
  });
}

export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: memberKeys.invite(token),
    queryFn: () => membersApi.preview(token).then(({ invite }) => invite),
    enabled: token !== '',
    // A 404 here is the answer, not a hiccup: expired, revoked, or not mine.
    retry: false,
  });
}

export function useAcceptInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => membersApi.accept(token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spaceKeys.lists }),
  });
}
