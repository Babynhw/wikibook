import { useInfiniteQuery } from '@tanstack/react-query';
import { activityApi } from '@/lib/api';

export const activityKeys = {
  all: ['activity'] as const,
  list: () => ['activity', 'list'] as const,
  space: (spaceId: string) => ['activity', 'space', spaceId] as const,
};

// Eight is a glance, not a log: the panel shares the home page with the space
// list, and "Load more" is one click away for anyone who wants the rest.
const PAGE_SIZE = 8;

/**
 * The signed-in user's activity, newest first, one page per cursor.
 * Always refetched when the home page mounts: every mutation that writes a row
 * happens on another route, so "come back to `/`" is the moment to be current.
 */
export function useActivity(spaceId?: string) {
  return useInfiniteQuery({
    queryKey: spaceId ? activityKeys.space(spaceId) : activityKeys.list(),
    queryFn: ({ pageParam }) =>
      spaceId
        ? activityApi.listForSpace(spaceId, { limit: PAGE_SIZE * 2, cursor: pageParam })
        : activityApi.list({ limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
    refetchOnMount: 'always',
    // An infinite query refetches *every* loaded page on remount, one request
    // each in sequence. Dropping the cache the moment the panel unmounts means
    // a return to `/` costs one request for the first page, however far the
    // user had paged before leaving.
    gcTime: 0,
  });
}
