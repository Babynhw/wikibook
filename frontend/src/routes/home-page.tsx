import { useState } from 'react';
import { ApiError, type Space, type SpaceFilter } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AppShell } from '@/components/app-shell';
import { useUi } from '@/lib/locale';
import { useCurrentUser } from '@/features/auth/use-auth';
import { SpaceDialog } from '@/features/spaces/space-dialog';
import { SpaceList } from '@/features/spaces/space-list';
import { useCreateSpace, useSpaces } from '@/features/spaces/use-spaces';
import { ContinueCard } from '@/features/activity/continue-card';
import { ActivityPanel } from '@/features/activity/activity-panel';

const FILTERS: SpaceFilter[] = ['active', 'archived'];
const PANEL_ID = 'space-list-panel';

function FilterTab({ value, current, onSelect, children }: {
  value: SpaceFilter;
  current: SpaceFilter;
  onSelect: (filter: SpaceFilter) => void;
  children: string;
}) {
  const selected = value === current;
  return (
    <button
      type="button"
      role="tab"
      id={`space-filter-${value}`}
      aria-selected={selected}
      aria-controls={PANEL_ID}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(value)}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        const next = FILTERS[(FILTERS.indexOf(value) + step + FILTERS.length) % FILTERS.length]!;
        onSelect(next);
        document.getElementById(`space-filter-${next}`)?.focus();
      }}
      className={`h-8 rounded px-3 text-sm ${selected ? 'bg-surface-container-high font-medium text-on-surface' : 'text-on-surface-variant hover:bg-surface-container-low'}`}
    >
      {children}
    </button>
  );
}

function SpaceSections({ spaces }: { spaces: Space[] }) {
  const { text } = useUi();
  const mine = spaces.filter((space) => space.myRole === 'owner');
  const shared = spaces.filter((space) => space.myRole !== 'owner');
  if (shared.length === 0) return <SpaceList spaces={spaces} />;
  return (
    <div className="space-y-8">
      <section aria-labelledby="my-spaces-heading">
        <h2 id="my-spaces-heading" className="mb-3 font-mono text-xs tracking-widest text-on-surface-variant uppercase">{text.home.mySpaces}</h2>
        {mine.length === 0 ? <p className="text-sm text-on-surface-variant">{text.home.noOwnSpace}</p> : <SpaceList spaces={mine} />}
      </section>
      <section aria-labelledby="shared-spaces-heading">
        <h2 id="shared-spaces-heading" className="mb-3 font-mono text-xs tracking-widest text-on-surface-variant uppercase">{text.home.sharedWithMe}</h2>
        <SpaceList spaces={shared} />
      </section>
    </div>
  );
}

/** The user's research spaces (PRD §4), most recently opened first. */
export function HomePage() {
  const { text } = useUi();
  const { data: user } = useCurrentUser();
  const [filter, setFilter] = useState<SpaceFilter>('active');
  const [creating, setCreating] = useState(false);
  const spaces = useSpaces(filter);
  const create = useCreateSpace();
  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
            {user ? text.home.welcome.replace('{name}', user.name) : text.home.researchSpaces}
          </h1>
          <p className="mt-2 max-w-prose text-on-surface-variant">
            {text.home.description}
          </p>
        </div>
        <Button
          onClick={() => {
            create.reset();
            setCreating(true);
          }}
        >
          {text.home.newSpace}
        </Button>
      </div>

      {/* Below `lg` the feed stacks under the list: never hidden, only reordered. */}
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0">
          {/* Ordered by `lastOpenedAt` with never-opened spaces last: the first row is the one to continue, if any was opened. */}
          {filter === 'active' && spaces.data?.[0]?.lastOpenedAt ? <ContinueCard space={spaces.data[0]} /> : null}

          <div role="tablist" aria-label={text.page.spaceFilter} className="mt-6 flex gap-1">
            <FilterTab value="active" current={filter} onSelect={setFilter}>
              {text.home.active}
            </FilterTab>
            <FilterTab value="archived" current={filter} onSelect={setFilter}>
              {text.home.archived}
            </FilterTab>
          </div>

          <div id={PANEL_ID} role="tabpanel" aria-labelledby={`space-filter-${filter}`} className="mt-4">
            {spaces.isPending ? (
              <p className="text-sm text-on-surface-variant">{text.home.loading}</p>
            ) : spaces.isError ? (
              <Alert>
                {spaces.error instanceof ApiError ? spaces.error.message : 'We could not load your spaces.'}{' '}
                <button type="button" onClick={() => spaces.refetch()} className="underline">
                  {text.home.tryAgain}
                </button>
              </Alert>
            ) : spaces.data.length === 0 ? (
              <Card>
                <h2 className="text-lg font-semibold text-on-surface">
                  {filter === 'active' ? text.home.noSpaces : text.home.nothingArchived}
                </h2>
                <p className="mt-2 max-w-prose text-sm text-on-surface-variant">
                  {filter === 'active'
                    ? 'Create a space for the question you are investigating. Everything you add — sources, answers, notes — stays inside it.'
                    : 'Spaces you archive appear here. Archiving keeps all of their content and can be undone.'}
                </p>
                {filter === 'active' ? (
                  <Button
                    className="mt-4"
                    onClick={() => {
                      create.reset();
                      setCreating(true);
                    }}
                  >
                    {text.home.createFirst}
                  </Button>
                ) : null}
              </Card>
            ) : (
              <SpaceSections spaces={spaces.data} />
            )}
          </div>
        </div>

        <ActivityPanel />
      </div>

      {creating ? (
        <SpaceDialog
          title={text.home.newSpaceTitle}
          description={text.home.newSpaceDescription}
          submitLabel={text.home.createSpace}
          pending={create.isPending}
          error={create.error}
          onClose={() => setCreating(false)}
          onSubmit={({ name, objective }) =>
            create.mutate(
              { name, objective },
              {
                onSuccess: () => {
                  setFilter('active');
                  setCreating(false);
                },
              },
            )
          }
        />
      ) : null}
    </AppShell>
  );
}
