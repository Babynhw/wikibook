import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  notesApi,
  type ConvertNoteToSourceInput,
  type CreateNoteInput,
  type SaveAnswerAsNoteInput,
  type UpdateNoteInput,
} from '@/lib/api';

/**
 * Each distinct query is its own cache entry. `placeholderData` keeps the
 * previous results on screen while the next keystroke's query resolves — a list
 * that empties on every keystroke reads as "no results" (PRD §16), the same
 * reason `useSources` carries the same option.
 */
export function useNotes(spaceId: string, q?: string) {
  return useQuery({
    queryKey: ['notes', 'list', spaceId, q ?? ''],
    queryFn: async () => {
      const response = await notesApi.list(spaceId, q);
      return response.notes;
    },
    enabled: Boolean(spaceId),
    placeholderData: (previous) => previous,
  });
}

export function useNote(id: string | null) {
  return useQuery({
    queryKey: ['notes', 'detail', id],
    queryFn: async () => {
      if (!id) return null;
      const response = await notesApi.get(id);
      return response.note ?? null;
    },
    enabled: Boolean(id),
  });
}

export function useCreateNote(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNoteInput) => notesApi.create(spaceId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes', 'list', spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', 'detail', spaceId] });
    },
  });
}

export function useUpdateNote(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateNoteInput }) =>
      notesApi.update(id, input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['notes', 'list', spaceId] });
      queryClient.setQueryData(['notes', 'detail', data.note.id], data.note);
    },
  });
}

export function useDeleteNote(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notesApi.remove(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['notes', 'list', spaceId] });
      queryClient.removeQueries({ queryKey: ['notes', 'detail', id] });
      queryClient.invalidateQueries({ queryKey: ['spaces', 'detail', spaceId] });
    },
  });
}

export function useSaveAnswerAsNote(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, input }: { messageId: string; input?: SaveAnswerAsNoteInput }) =>
      notesApi.saveAsNote(messageId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes', 'list', spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', 'detail', spaceId] });
    },
  });
}

export function useConvertNoteToSource(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: ConvertNoteToSourceInput }) =>
      notesApi.convertToSource(id, input),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['notes', 'list', spaceId] });
      queryClient.invalidateQueries({ queryKey: ['notes', 'detail', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['sources', 'list', spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', 'detail', spaceId] });
    },
  });
}
