import { useState } from 'react';
import { Activity, FolderOpen, LayoutGrid, LibraryBig, NotebookPen, Plus, Sparkles, StickyNote, Users } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { AddSourceDialog } from '@/features/sources/add-source-dialog';
import { canEditSpace } from '@/features/spaces/use-space-role';
import type { Space } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The space rail (PRD §4) — the 280px panel `DESIGN.md` § Layout & Spacing has
 * specified since the design system was written. It names the open space and
 * links its areas, so moving between the library and the assistant is one click
 * from anywhere in the space, including the reader a citation deep-links into.
 * It also carries **Add Source**, as the `source_library` wireframe draws it, so
 * a source can be added from the assistant or the notes without going back to
 * the library first.
 *
 * Three things about the generated `sidebar.tsx` this has to work around, none
 * by editing it:
 *
 *  - Its desktop container is `fixed inset-y-0 h-svh`, which would paint over
 *    the app header. `AppShell` gives it a `top`/`h` override through
 *    `className`, matching the header's 4rem — the same offset the source_library
 *    wireframe uses.
 *  - `SidebarMenuButton` spends the single `--sidebar-accent` token on *both*
 *    hover and active. The wireframe wants the current area filled in blue, so
 *    that comes from `data-active:` classes here rather than from re-pointing the
 *    token, which would have painted every hover blue.
 *  - It defaults to `collapsible="offcanvas"`, which vanishes the whole rail when
 *    collapsed. The explore-anything-from-anywhere rail wants a *minimal* form
 *    instead — an icon strip whose labels return on expand — so `Sidebar` opts
 *    into `collapsible="icon"` and the header hides its identity while collapsed.
 *
 * The rail config avoids editing `sidebar.tsx`, but the file is still hand-touched
 * elsewhere: `SidebarTrigger` (located there, not in the rail) carries the
 * expand/collapse affordance, and the provider restores its persisted `open` from
 * the cookie across remounts. See the header comment in `sidebar.tsx`.
 *
 * Nav is Sources, Assistant, Notes, and Notebook — every PRD §2 area a space
 * has; the wireframe's Citations, Drafts, Trash, and Help are §20 exclusions or
 * have no PRD §2 counterpart.
 */

/**
 * The wireframe's nav row (`source_library/code.html`): `px-4 py-3 gap-3
 * rounded-lg`, a JetBrains Mono `label-md`, a 24px icon, the current area
 * filled in `primary-container`. The generated button's `default` size is a
 * 32px `p-2 gap-2 text-sm` row in Inter, so every menu button takes `size="lg"`
 * (48px, the wireframe's height) plus these classes.
 *
 * The last line is for the collapsed strip: the generated variant forces
 * `size-8` there, which leaves a 20px icon with 6px of breathing room. `size-10`
 * centres it in the 3rem rail with the same margin the expanded row has.
 */
const ITEM = cn(
  'gap-3 rounded-lg px-4 font-mono text-sm text-on-surface-variant',
  '[&_svg]:size-5',
  'data-active:bg-primary-container data-active:text-on-primary-container',
  'group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!',
);

/**
 * `space` is optional on purpose, and `spaceId` is not. The rail renders from
 * the URL, filling the name in when the query answers — because the alternative
 * (mounting the rail only once the space has loaded) makes `AppShell` swap
 * between two different trees, which remounts the entire page under it. On the
 * reader that means throwing away loaded blocks and the reading position the
 * moment the space arrives.
 */
export function SpaceRail({ spaceId, space }: { spaceId: string; space?: Space }) {
  const { pathname } = useLocation();
  const base = `/spaces/${spaceId}`;
  // The rail owns its own dialog instance. The library page keeps its own
  // button and instance too — the dialog's mutations invalidate the source
  // list, so whichever opened it, the library is current when it closes.
  const [adding, setAdding] = useState(false);

  // The reader belongs to the library: a source opened from a citation is still
  // "Sources", and highlighting nothing there would read as having left the space.
  const onAssistant = pathname.startsWith(`${base}/assistant`);
  const onNotes = pathname.startsWith(`${base}/notes`);
  const onNotebook = pathname.startsWith(`${base}/notebook`);
  const onMembers = pathname.startsWith(`${base}/members`);
  const onActivity = pathname.startsWith(`${base}/activity`);
  const onSources = !onAssistant && !onNotes && !onNotebook && !onMembers && !onActivity;

  return (
    <Sidebar
      // Sit below the 4rem header rather than over it (see the comment above).
      // `collapsible="icon"`: collapsing drops the rail to a ~3rem strip of icons
      // (labels hidden) instead of sliding the whole thing out of view.
      collapsible="icon"
      className="top-16 h-[calc(100svh-4rem)]"
    >
      {/* One landmark for the whole rail (PRD §18): the identity, Add source, the
          areas, and All spaces are otherwise page content outside any landmark,
          which axe's `region` rule flags and a screen reader's landmark list
          skips. `flex-col` keeps the generated wrapper's column layout. */}
      <nav aria-label="Space" className="flex h-full min-h-0 w-full flex-col">
      {/* Wireframe: `px-6 pb-6 pt-2`, identity then Add Source, `mb-6` between. */}
      <SidebarHeader className="gap-6 px-6 pt-4 pb-6 group-data-[collapsible=icon]:p-2">
        <div className="flex items-center justify-between gap-3 group-data-[collapsible=icon]:justify-center">
          {/* The identity is dropped when collapsed — a 3rem rail has room for the
              nav icons and the expand control, not for the space's name. */}
          <div className="group-data-[collapsible=icon]:hidden flex min-w-0 items-center gap-3">
            <div
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary"
            >
              <FolderOpen className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              {space ? (
                <>
                  <p className="truncate font-mono text-sm font-black text-on-surface">
                    {space.name}
                  </p>
                  {space.objective ? (
                    <p className="truncate text-sm text-on-surface-variant">{space.objective}</p>
                  ) : null}
                </>
              ) : (
                <Skeleton className="h-4 w-32" />
              )}
            </div>
          </div>
          <SidebarTrigger className="shrink-0" />
        </div>

        {/* Offered only once the space is known to be writable: adding answers 409
            on an archived space (REQ-076), so the rail does not offer it there —
            nor before the space has loaded, when it cannot know. While loading,
            a skeleton holds the row so the nav does not jump when the space
            arrives (the identity above does the same). Hidden while collapsed:
            a labelled button has no room in a 3rem strip, and the wireframe has
            no collapsed state to copy. `secondary` is already the wireframe's
            outlined button — border, lowest surface. */}
        {!space ? (
          <Skeleton className="h-10 w-full group-data-[collapsible=icon]:hidden" />
        ) : canEditSpace(space) ? (
          <Button
            variant="secondary"
            className="w-full justify-center gap-2 font-mono group-data-[collapsible=icon]:hidden"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-4" aria-hidden="true" />
            Add source
          </Button>
        ) : null}
      </SidebarHeader>

      <SidebarContent>
        {/* Wireframe: `nav px-2 space-y-1`; the group's own `p-2` would double it. */}
        <SidebarGroup className="p-0 py-2">
          <SidebarGroupContent>
            {/* Labelled so the list reads as "Space areas", not "list, 4 items" — PRD §18. */}
            <SidebarMenu aria-label="Space areas" className="gap-1 px-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  isActive={onSources}
                  className={ITEM}
                  tooltip="Sources"
                  render={
                    <Link to={base} aria-current={onSources ? 'page' : undefined}>
                      <LibraryBig />
                      <span>Sources</span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  isActive={onAssistant}
                  className={ITEM}
                  tooltip="Assistant"
                  render={
                    <Link
                      to={`${base}/assistant`}
                      aria-current={onAssistant ? 'page' : undefined}
                    >
                      <Sparkles />
                      <span>Assistant</span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  isActive={onNotes}
                  className={ITEM}
                  tooltip="Notes"
                  render={
                    <Link
                      to={`${base}/notes`}
                      aria-current={onNotes ? 'page' : undefined}
                    >
                      <StickyNote />
                      <span>Notes</span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  isActive={onNotebook}
                  className={ITEM}
                  tooltip="Notebook"
                  render={
                    <Link
                      to={`${base}/notebook`}
                      aria-current={onNotebook ? 'page' : undefined}
                    >
                      <NotebookPen />
                      <span>Notebook</span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
              {/* Shared spaces v1: who is here, and what they did. Every role sees
                  both; the members page withholds its controls from non-owners. */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  isActive={onMembers}
                  className={ITEM}
                  tooltip="Members"
                  render={
                    <Link to={`${base}/members`} aria-current={onMembers ? 'page' : undefined}>
                      <Users />
                      <span>Members</span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  isActive={onActivity}
                  className={ITEM}
                  tooltip="Activity"
                  render={
                    <Link to={`${base}/activity`} aria-current={onActivity ? 'page' : undefined}>
                      <Activity />
                      <span>Activity</span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Wireframe footer: `px-2 pt-4` over a rule, rows one step shorter (`py-2`)
          than the nav's. `default` size is 32px; `h-10` splits the difference the
          wireframe draws. */}
      <SidebarFooter className="border-t border-sidebar-border px-2 py-4">
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              className={cn(ITEM, 'h-10')}
              tooltip="All spaces"
              render={
                <Link to="/">
                  <LayoutGrid />
                  <span>All spaces</span>
                </Link>
              }
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      </nav>

      {adding ? <AddSourceDialog spaceId={spaceId} onClose={() => setAdding(false)} /> : null}
    </Sidebar>
  );
}
