import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { spacesApi, type Space, type SpaceFilter, type SpaceInput } from '@/lib/api';

export const spaceKeys = {
  all: ['spaces'] as const,
  lists: ['spaces', 'list'] as const,
  list: (filter: SpaceFilter) => ['spaces', 'list', filter] as const,
  detail: (id: string) => ['spaces', 'detail', id] as const,
};

export function useSpaces(filter: SpaceFilter) {
  return useQuery({
    queryKey: spaceKeys.list(filter),
    queryFn: () => spacesApi.list(filter).then(({ spaces }) => spaces),
  });
}

export function useSpace(id: string) {
  return useQuery({
    queryKey: spaceKeys.detail(id),
    queryFn: () => spacesApi.get(id).then(({ space }) => space),
  });
}

/**
 * Every mutation returns the updated space, so the detail cache is written
 * directly and only the lists are refetched — an archive changes which list a
 * space belongs to, which no local patch can work out reliably.
 */
function useSpaceMutation<TInput>(
  mutationFn: (input: TInput) => Promise<{ space: Space }>,
  { retry = 0 }: { retry?: number } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    retry,
    onSuccess: ({ space }) => {
      queryClient.setQueryData(spaceKeys.detail(space.id), space);
      // Only the lists: the detail cache was just written from the response, and
      // both lists have to be refetched anyway — archiving moves a space between
      // them, which no local patch can work out reliably.
      return queryClient.invalidateQueries({ queryKey: spaceKeys.lists });
    },
  });
}

export function useCreateSpace() {
  return useSpaceMutation((input: SpaceInput) => spacesApi.create(input));
}

export function useUpdateSpace(id: string) {
  return useSpaceMutation((input: SpaceInput) => spacesApi.update(id, input));
}

/**
 * Retried once, and alone among these mutations in having no error UI: the
 * stamp only decides list order, so a banner would be noise — but it fires
 * unattended on entering a space, where nobody is watching for it to fail.
 */
export function useOpenSpace() {
  return useSpaceMutation((id: string) => spacesApi.open(id), { retry: 1 });
}

/**
 * The owner's "Audience & style" note. Its own hook because it is its own route:
 * `update` is open to editors, this is not.
 */
export function useSetSpaceAudience(id: string) {
  return useSpaceMutation((audience: string | null) => spacesApi.setAudience(id, audience));
}

export function useArchiveSpace() {
  return useSpaceMutation((id: string) => spacesApi.archive(id));
}

export function useRestoreSpace() {
  return useSpaceMutation((id: string) => spacesApi.restore(id));
}
