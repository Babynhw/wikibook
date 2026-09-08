import { useQuery } from '@tanstack/react-query';
import { notebookApi } from '@/lib/api';

export const notebookKeys = {
  detail: (spaceId: string) => ['notebook', 'detail', spaceId] as const,
};

/**
 * The space's notebook. `staleTime` is long on purpose: the editor owns the
 * document once it has loaded, and a background refetch replacing `data`
 * would not — must not — re-seed the editor (see `NotebookEditor`).
 */
export function useNotebook(spaceId: string) {
  return useQuery({
    queryKey: notebookKeys.detail(spaceId),
    queryFn: () => notebookApi.get(spaceId).then(({ notebook }) => notebook),
    enabled: spaceId !== '',
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
