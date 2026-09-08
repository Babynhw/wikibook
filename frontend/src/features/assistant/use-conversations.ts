import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { conversationsApi, type ScopeInput } from '@/lib/api';

export const conversationKeys = {
  all: ['conversations'] as const,
  lists: (spaceId: string) => ['conversations', 'list', spaceId] as const,
  details: () => ['conversations', 'detail'] as const,
  detail: (conversationId: string) => ['conversations', 'detail', conversationId] as const,
};

/** Previous conversations, most recently updated first (PRD §9). */
export function useConversations(spaceId: string) {
  return useQuery({
    queryKey: conversationKeys.lists(spaceId),
    queryFn: () => conversationsApi.list(spaceId).then(({ conversations }) => conversations),
    enabled: spaceId !== '',
  });
}

/** One thread: messages with their citations, oldest first. */
export function useConversation(conversationId: string) {
  return useQuery({
    queryKey: conversationKeys.detail(conversationId),
    queryFn: () => conversationsApi.get(conversationId),
    enabled: conversationId !== '',
  });
}

/**
 * Starting a new conversation deletes nothing (§9) — the list is invalidated, not
 * replaced, so previous conversations stay listed and readable.
 */
export function useCreateConversation(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScopeInput) =>
      conversationsApi.create(spaceId, input).then(({ conversation }) => conversation),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationKeys.lists(spaceId) });
    },
  });
}

export function useSetScope(conversationId: string, spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScopeInput) =>
      conversationsApi.setScope(conversationId, input).then(({ conversation }) => conversation),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(conversationId) });
      void queryClient.invalidateQueries({ queryKey: conversationKeys.lists(spaceId) });
    },
  });
}

export function useFeedback(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      feedback,
    }: {
      messageId: string;
      feedback: 'useful' | 'not_useful' | null;
    }) => conversationsApi.feedback(messageId, feedback),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(conversationId) });
    },
  });
}
