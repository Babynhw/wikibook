import { useParams } from 'react-router-dom';
import { AppShell } from '@/components/app-shell';
import { SpaceRail } from '@/components/space-shell';
import { ActivityPanel } from '@/features/activity/activity-panel';
import { useSpace } from '@/features/spaces/use-spaces';

/**
 * `/spaces/:spaceId/activity` — what every member did here, newest first, with
 * the actor named (shared-spaces-v1 "Activity"). The Home feed stays personal;
 * this is the space's.
 */
export function SpaceActivityPage() {
  const { spaceId = '' } = useParams<{ spaceId: string }>();
  const space = useSpace(spaceId);

  return (
    <AppShell rail={<SpaceRail spaceId={spaceId} space={space.data} />}>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-on-surface">Activity</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Everything that happened in this space, by everyone in it.
          </p>
        </div>
        <ActivityPanel spaceId={spaceId} heading="Space activity" />
      </div>
    </AppShell>
  );
}
