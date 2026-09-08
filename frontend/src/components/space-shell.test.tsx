import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Space } from '@/lib/api';
import { SpaceRail } from '@/components/space-shell';
import { SidebarProvider } from '@/components/ui/sidebar';
import { sourceKeys } from '@/features/sources/use-sources';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const space = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
  name: 'Sleep and memory',
  objective: 'How sleep consolidates declarative memory',
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 1,
  noteCount: 0,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
  ...overrides,
});

function renderRail(path: string, row?: Space) {
  return renderWithProviders(
    <SidebarProvider>
      <SpaceRail spaceId="space-1" space={row} />
    </SidebarProvider>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe('SpaceRail', () => {
  // The provider persists `open` to a `sidebar_state` cookie on every toggle, and
  // each test here mounts its own `SidebarProvider` (which restores from that
  // cookie). Clear it between tests so one test's collapse/expand never leaks
  // into the next — otherwise adding a test after the collapse one that expects
  // an expanded rail would fail depending on file order.
  afterEach(() => {
    document.cookie = 'sidebar_state=; path=/; max-age=0';
  });

  it('names the space and links its areas', () => {
    renderRail('/spaces/space-1', space());

    expect(screen.getByText('Sleep and memory')).toBeInTheDocument();
    expect(screen.getByText('How sleep consolidates declarative memory')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/spaces/space-1');
    expect(screen.getByRole('link', { name: 'Assistant' })).toHaveAttribute(
      'href',
      '/spaces/space-1/assistant',
    );
    expect(screen.getByRole('link', { name: 'All spaces' })).toHaveAttribute('href', '/');
  });

  // PRD §18: the current location is announced, not just coloured.
  it('marks the open area with aria-current', () => {
    renderRail('/spaces/space-1', space());

    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Assistant' })).not.toHaveAttribute('aria-current');
  });

  it('counts the reader as part of the library, not as having left the space', () => {
    renderRail('/spaces/space-1/sources/src-1?passage=psg-1', space());

    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('aria-current', 'page');
  });

  it('moves the current marker to the assistant on its route', () => {
    renderRail('/spaces/space-1/assistant/conv-1', space());

    expect(screen.getByRole('link', { name: 'Assistant' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Sources' })).not.toHaveAttribute('aria-current');
  });

  // The rail renders from the URL so that `AppShell` never swaps between two
  // trees — swapping remounts the page under it, which on the reader throws away
  // loaded blocks and the reading position.
  it('links the areas before the space has loaded', () => {
    renderRail('/spaces/space-1');

    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/spaces/space-1');
    expect(screen.queryByText('Sleep and memory')).not.toBeInTheDocument();
  });

  it('reaches every item by keyboard', async () => {
    const user = userEvent.setup();
    renderRail('/spaces/space-1', space());

    // The header expand/collapse control is focusable and precedes the nav.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Add source' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Sources' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Assistant' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Notes' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Notebook' })).toHaveFocus();
    // Shared spaces v1 added two areas every role can reach.
    await user.tab();
    expect(screen.getByRole('link', { name: 'Members' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Activity' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'All spaces' })).toHaveFocus();
  });
  // The header owns the expand/collapse control (right-aligned in the rail
  // header). Collapsing must drop the rail to an icon strip — `collapsible="icon"`
  // — not vanish it: the trigger stays on screen so it can expand back.
  it('collapses to the icon rail and re-expands it from its header trigger', async () => {
    const user = userEvent.setup();
    renderRail('/spaces/space-1', space());

    const rail = document.querySelector('[data-slot="sidebar"]');
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    await user.click(collapse);
    expect(rail).toHaveAttribute('data-state', 'collapsed');
    // A labelled button has no room in the 3rem strip; jsdom has no layout, so
    // the hiding utility is what can be asserted.
    expect(screen.getByRole('button', { name: 'Add source' })).toHaveClass(
      'group-data-[collapsible=icon]:hidden',
    );
    // The icon rail (not off-canvas): the wrapper should still be on screen with
    // its trigger, since in icon mode the rail never unmounts.
    expect(rail).toHaveAttribute('data-collapsible', 'icon');
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).not.toHaveAttribute('aria-hidden');

    await user.click(expand);
    expect(rail).toHaveAttribute('data-state', 'expanded');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  // REQ-076 / REQ-237: adding answers 409 on an archived space, so the rail —
  // like the library page — does not offer it.
  it('withholds Add source for an archived space', () => {
    renderRail('/spaces/space-1', space({ archivedAt: '2026-08-11T10:00:00.000Z' }));
    expect(screen.queryByRole('button', { name: 'Add source' })).not.toBeInTheDocument();
  });

  // Before the space has loaded the rail cannot know whether it is writable, so
  // it holds the row with a placeholder rather than offer an action that may 409.
  it('withholds Add source before the space is known', () => {
    renderRail('/spaces/space-1');
    expect(screen.queryByRole('button', { name: 'Add source' })).not.toBeInTheDocument();
  });

  // The design leans on this: a source added from the assistant route is in the
  // library when the user gets there. Prove the invalidation from the rail's
  // opener, not just from `use-sources.ts` in isolation. The list query has no
  // observer here (no library on screen), so what can be asserted is that it is
  // marked stale — which is exactly what makes the library refetch on mount.
  it('invalidates the source list after a source is added from the rail', async () => {
    const user = userEvent.setup();
    stubFetch((path, init) =>
      init?.method === 'POST' && path.endsWith('/sources')
        ? jsonResponse({ source: { id: 'src-1', spaceId: 'space-1', type: 'web' } }, 201)
        : jsonResponse({ sources: [] }),
    );
    const { client } = renderRail('/spaces/space-1/assistant', space());
    const key = sourceKeys.list('space-1');
    client.setQueryData(key, { sources: [] });
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('tab', { name: 'Web link' }));
    await user.type(within(dialog).getByLabelText('Web address'), 'https://example.org/paper');
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  // The source_library wireframe puts Add Source in the rail, under the space's
  // identity, so a source can be added from the assistant or the notes without
  // first returning to the library. The library page keeps its own button.
  it('opens the add-source dialog from the rail on any space route', async () => {
    const user = userEvent.setup();
    renderRail('/spaces/space-1/assistant', space());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'PDF' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
