import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  sourcesApi,
  type Source,
  type SourceInput,
  type SourceListParams,
  type SourceMetadataInput,
} from '@/lib/api';
import { spaceKeys } from '@/features/spaces/use-spaces';

export const sourceKeys = {
  all: ['sources'] as const,
  /** Every list of one space, whatever query and filters it was asked with. */
  lists: (spaceId: string) => ['sources', 'list', spaceId] as const,
  list: (spaceId: string, params: SourceListParams = {}) =>
    ['sources', 'list', spaceId, params.q ?? '', params.type ?? '', params.archived ?? 'exclude'] as const,
  details: () => ['sources', 'detail'] as const,
  detail: (sourceId: string) => ['sources', 'detail', sourceId] as const,
};

/**
 * Each distinct query is its own cache entry, so re-running a search the user
 * has already typed is free and the §19 500 ms target is measured against a
 * cold one. `placeholderData` keeps the previous results on screen while the
 * next query resolves — a list that empties on every keystroke reads as "no
 * results" (PRD §16).
 */
export function useSources(spaceId: string, params: SourceListParams = {}) {
  return useQuery({
    queryKey: sourceKeys.list(spaceId, params),
    queryFn: () => sourcesApi.list(spaceId, params).then(({ sources }) => sources),
    enabled: spaceId !== '',
    placeholderData: (previous) => previous,
  });
}

/** The reader's source, with the block and page counts the list does not carry. */
export function useSource(sourceId: string) {
  return useQuery({
    queryKey: sourceKeys.detail(sourceId),
    queryFn: () => sourcesApi.get(sourceId).then(({ source }) => source),
    enabled: sourceId !== '',
  });
}

/**
 * Writes one source into every cached list of its space, without a refetch. Used
 * by both the mutations (which get the row back) and the event stream (which
 * gets a state patch) — see `use-source-events.ts` for why the stream never
 * invalidates.
 *
 * Every list, not one: the library keeps a separate entry per query and filter,
 * so patching only the unfiltered list would leave a stale row on screen the
 * moment a search is active.
 */
export function patchCachedSource(
  queryClient: QueryClient,
  spaceId: string,
  patch: Pick<Source, 'id'> & Partial<Source>,
): boolean {
  let found = false;
  queryClient.setQueriesData<Source[]>(
    { queryKey: sourceKeys.lists(spaceId) },
    (current) => {
      if (!current) return current;
      return current.map((source) => {
        if (source.id !== patch.id) return source;
        found = true;
        return { ...source, ...patch };
      });
    },
  );
  queryClient.setQueryData<Source>(sourceKeys.detail(patch.id), (current) =>
    current ? { ...current, ...patch } : current,
  );
  return found;
}

/**
 * A new source changes `sourceCount` on the space, so the space caches are
 * invalidated alongside the list. The list itself is refetched rather than
 * patched: it is ordered newest-first and enforces a server-side limit, so the
 * server's answer is the one that decides what the library contains.
 */
function useSourceWrite<TInput>(
  spaceId: string,
  mutationFn: (input: TInput) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    retry: 0,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sourceKeys.lists(spaceId) });
      // The reader reads the detail query, and archiving changes what its banner
      // says — so a write invalidates details as well as lists.
      await queryClient.invalidateQueries({ queryKey: sourceKeys.details() });
      await queryClient.invalidateQueries({ queryKey: spaceKeys.all });
    },
  });
}

export function useCreateSource(spaceId: string) {
  return useSourceWrite(spaceId, (input: SourceInput) => sourcesApi.create(spaceId, input));
}

export function useUploadSource(spaceId: string) {
  return useSourceWrite(spaceId, (file: File) => sourcesApi.upload(spaceId, file));
}

/**
 * Retry answers with the source already back in `processing`, so the card flips
 * immediately and the stream carries it the rest of the way. No count changed,
 * so the space caches are left alone.
 */
export function useRetrySource(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sourcesApi.retry(id),
    retry: 0,
    onSuccess: ({ source }) => {
      patchCachedSource(queryClient, spaceId, source);
    },
  });
}

export function useDeleteSource(spaceId: string) {
  return useSourceWrite(spaceId, (id: string) => sourcesApi.remove(id));
}

/**
 * Title and author only (PRD §7/§8). The row comes back, so it is patched into
 * every cached list rather than refetched — an edit changes no ordering the
 * server owns.
 */
export function useUpdateSource(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: SourceMetadataInput & { id: string }) =>
      sourcesApi.update(id, input),
    retry: 0,
    onSuccess: ({ source }) => {
      patchCachedSource(queryClient, spaceId, source);
    },
  });
}

/**
 * Archive and restore *do* change what a list contains — the default view hides
 * archived sources — so both invalidate rather than patch, and the space caches
 * go with them because an archived source leaves the retrievable set (REQ-101).
 */
export function useArchiveSource(spaceId: string) {
  return useSourceWrite(spaceId, (id: string) => sourcesApi.archive(id));
}

export function useRestoreSource(spaceId: string) {
  return useSourceWrite(spaceId, (id: string) => sourcesApi.restore(id));
}
