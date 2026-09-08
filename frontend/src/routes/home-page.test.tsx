import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActivityItem, ActivityPage, Space } from '@/lib/api';
import { HomePage } from '@/routes/home-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const space = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
  name: 'Sleep and memory',
  objective: null,
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 0,
  noteCount: 0,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
  ...overrides,
});

const user = { id: 'u1', name: 'Test Person', email: 'test@example.test' };

describe('HomePage', () => {
  /** REQ-070 — the no-spaces state explains what a space is and offers the action. */
  it('explains the empty state and creates a space from it', async () => {
    const person = userEvent.setup();
    const requests: string[] = [];
    let spaces: Space[] = [];

    stubFetch((path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      if (path.includes('/spaces?filter=')) return jsonResponse({ spaces });
      if (path.endsWith('/spaces') && init?.method === 'POST') {
        const created = space({ name: JSON.parse(String(init.body)).name });
        spaces = [created];
        return jsonResponse({ space: created }, 201);
      }
      throw new Error(`unexpected request: ${path}`);
    });

    renderWithProviders(<HomePage />);

    expect(await screen.findByText('Chưa có không gian nghiên cứu')).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Tạo không gian đầu tiên' }));
    await person.type(screen.getByLabelText('Name'), 'Sleep and memory');
    await person.click(screen.getByRole('button', { name: 'Tạo không gian' }));

    // Created, then the list refetched — the new space appears without a reload.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Sleep and memory' })).toBeInTheDocument();
    expect(requests).toContain('POST /api/spaces');
  });

  /** REQ-073 — a failed create keeps the typed name and shows the field error. */
  it('keeps input and shows the field error when create fails', async () => {
    const person = userEvent.setup();
    stubFetch((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      if (path.includes('/spaces?filter=')) return jsonResponse({ spaces: [] });
      if (init?.method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 'validation_failed',
              message: 'Please check the highlighted fields and try again.',
              fields: { name: 'Give the space a name.' },
            },
          },
          400,
        );
      }
      throw new Error(`unexpected request: ${path}`);
    });

    renderWithProviders(<HomePage />);

    await person.click(await screen.findByRole('button', { name: 'Không gian mới' }));
    await person.type(screen.getByLabelText('Name'), '   ');
    await person.click(screen.getByRole('button', { name: 'Tạo không gian' }));

    const name = await screen.findByLabelText('Name');
    await waitFor(() => expect(name).toHaveAccessibleDescription(/Give the space a name/));
    expect(name).toHaveValue('   ');
    expect(name).toHaveAttribute('aria-invalid', 'true');
  });

  /** REQ-060 — archived spaces are out of the active list but still reachable. */
  it('switches between the active and archived lists', async () => {
    const person = userEvent.setup();
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      if (path.includes('filter=archived')) {
        return jsonResponse({
          spaces: [space({ id: 'old', name: 'Finished study', archivedAt: '2026-08-01T00:00:00.000Z' })],
        });
      }
      return jsonResponse({ spaces: [space({ name: 'Current study' })] });
    });

    renderWithProviders(<HomePage />);

    expect(await screen.findByRole('heading', { name: 'Current study' })).toBeInTheDocument();

    await person.click(screen.getByRole('tab', { name: 'Đã lưu trữ' }));

    expect(await screen.findByText('Finished study')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Current study' })).toBeNull();
  });

  /** REQ-060 — the filter is a real tab widget: arrows move between the tabs. */
  it('moves between filters with the arrow keys', async () => {
    const person = userEvent.setup();
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      if (path.includes('filter=archived')) return jsonResponse({ spaces: [] });
      return jsonResponse({ spaces: [space({ name: 'Current study' })] });
    });

    renderWithProviders(<HomePage />);

    const active = await screen.findByRole('tab', { name: 'Đang hoạt động' });
    const archived = screen.getByRole('tab', { name: 'Đã lưu trữ' });
    // Only the selected tab is a tab stop; the arrows do the rest.
    expect(active).toHaveAttribute('tabindex', '0');
    expect(archived).toHaveAttribute('tabindex', '-1');

    active.focus();
    await person.keyboard('{ArrowRight}');

    expect(archived).toHaveFocus();
    expect(archived).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Không có gì được lưu trữ')).toBeInTheDocument();

    // Wraps, so the widget is never a dead end.
    await person.keyboard('{ArrowRight}');
    expect(active).toHaveFocus();
  });

  /** REQ-070 — a failed list explains itself and offers a retry. */
  it('reports a failed list and retries on demand', async () => {
    const person = userEvent.setup();
    let failing = true;
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      if (failing) {
        failing = false;
        // A 4xx, which the client's retry rule declines to repeat — the user is
        // shown the failure rather than left watching a spinner.
        return jsonResponse(
          {
            error: {
              code: 'too_many_requests',
              message: 'Too many attempts. Please try again shortly.',
            },
          },
          429,
        );
      }
      return jsonResponse({ spaces: [space({ name: 'Current study' })] });
    });

    renderWithProviders(<HomePage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Please try again shortly.',
    );

    await person.click(screen.getByRole('button', { name: 'Thử lại' }));

    expect(await screen.findByRole('heading', { name: 'Current study' })).toBeInTheDocument();
  });

  /** REQ-074 — Escape closes the dialog and focus returns to the trigger. */
  it('closes the create dialog on Escape and restores focus', async () => {
    const person = userEvent.setup();
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      return jsonResponse({ spaces: [space()] });
    });

    renderWithProviders(<HomePage />);

    const trigger = await screen.findByRole('button', { name: 'Không gian mới' });
    await person.click(trigger);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await person.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  // --- Phase 7: Continue card and the activity feed (PRD §15) -----------------

  const activity = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
    id: 'a1',
    kind: 'source.ready',
    createdAt: '2026-08-27T11:00:00.000Z',
    actor: null,
    space: { id: 'space-1', name: 'Sleep and memory', archivedAt: null },
    target: { type: 'source', id: 'src-1', title: 'Walker 2017' },
    href: '/spaces/space-1/sources/src-1',
    ...overrides,
  });

  const stubHome = (opts: {
    spaces?: Space[];
    pages?: Record<string, ActivityPage>;
    activityStatus?: () => number;
    requests?: string[];
  }) => {
    stubFetch((path, init) => {
      opts.requests?.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) {
        const status = opts.activityStatus?.() ?? 200;
        if (status !== 200) {
          return jsonResponse({ error: { code: 'internal_error', message: 'Something went wrong on our side.' } }, status);
        }
        const cursor = new URL(path, 'http://x').searchParams.get('cursor') ?? 'first';
        return jsonResponse(opts.pages?.[cursor] ?? { items: [], nextCursor: null });
      }
      if (path.includes('/spaces?filter=')) return jsonResponse({ spaces: opts.spaces ?? [] });
      throw new Error(`unexpected request: ${path}`);
    });
  };

  it('shows the most recently opened space as the Continue card with its counts (REQ-275)', async () => {
    stubHome({
      spaces: [
        space({ id: 'recent', name: 'Recent study', lastOpenedAt: '2026-08-27T10:00:00.000Z', sourceCount: 12, noteCount: 1 }),
        space({ id: 'older', name: 'Older study', lastOpenedAt: '2026-08-01T10:00:00.000Z' }),
      ],
    });
    renderWithProviders(<HomePage />);

    const card = await screen.findByRole('region', { name: 'Recent study' });
    expect(card).toHaveTextContent('12 sources · 1 note');
    expect(within(card).getByRole('link', { name: 'Open space' })).toHaveAttribute('href', '/spaces/recent');
    expect(within(card).getByText(/updated/).querySelector('time')).toHaveAttribute('dateTime', '2026-08-01T10:00:00.000Z');
  });

  it('shows no Continue card when no space has been opened yet (REQ-275)', async () => {
    stubHome({ spaces: [space({ lastOpenedAt: null })] });
    renderWithProviders(<HomePage />);
    await screen.findByRole('heading', { name: 'Sleep and memory' });
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('renders the feed newest first, each entry a link to its href, a gone target without one (REQ-276)', async () => {
    stubHome({
      spaces: [space()],
      pages: {
        first: {
          items: [
            activity({ id: 'a1', kind: 'note.created', target: { type: 'note', id: 'n1', title: 'Carbon' }, href: '/spaces/space-1/notes?noteId=n1' }),
            activity({ id: 'a2', kind: 'source.ready' }),
            activity({ id: 'a3', kind: 'source.added', target: null, href: '/spaces/space-1' }),
            activity({ id: 'a4', kind: 'notebook.exported', target: null, href: '/spaces/space-1/notebook' }),
          ],
          nextCursor: null,
        },
      },
    });
    renderWithProviders(<HomePage />);

    const feed = await screen.findByRole('region', { name: 'Recent activity' });
    const rows = await within(feed).findAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Created note “Carbon”'),
      expect.stringContaining('Finished processing “Walker 2017”'),
      expect.stringContaining('Added source an item that has since been deleted'),
      expect.stringContaining('Exported the notebook'),
    ]);
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', '/spaces/space-1/notes?noteId=n1');
    expect(within(rows[1]!).getByRole('link')).toHaveAttribute('href', '/spaces/space-1/sources/src-1');
    // The gone source still names the space it happened in.
    expect(within(rows[2]!).getByRole('link')).toHaveAttribute('href', '/spaces/space-1');
    expect(rows[2]).toHaveTextContent('in Sleep and memory');
    expect(within(rows[3]!).getByRole('link')).toHaveAttribute('href', '/spaces/space-1/notebook');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('Load more appends the next page and disappears when the cursor runs out (REQ-276)', async () => {
    const person = userEvent.setup();
    stubHome({
      spaces: [space()],
      pages: {
        first: { items: [activity({ id: 'a1' })], nextCursor: '2026-08-27T11:00:00.000Z_a1' },
        '2026-08-27T11:00:00.000Z_a1': {
          items: [activity({ id: 'a2', kind: 'space.created', target: { type: 'space', id: 'space-1', title: 'Sleep and memory' }, href: '/spaces/space-1' })],
          nextCursor: null,
        },
      },
    });
    renderWithProviders(<HomePage />);

    const feed = await screen.findByRole('region', { name: 'Recent activity' });
    expect(await within(feed).findAllByRole('listitem')).toHaveLength(1);
    await person.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(feed).getAllByRole('listitem')).toHaveLength(2));
    expect(within(feed).getAllByRole('listitem')[1]).toHaveTextContent('Created space “Sleep and memory”');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a failed feed keeps the space list up and its Retry refetches only the feed (REQ-277)', async () => {
    const person = userEvent.setup();
    const requests: string[] = [];
    let failing = true;
    stubHome({
      spaces: [space({ name: 'Current study' })],
      pages: { first: { items: [activity()], nextCursor: null } },
      activityStatus: () => (failing ? 500 : 200),
      requests,
    });
    renderWithProviders(<HomePage />);

    expect(await screen.findByRole('heading', { name: 'Current study' })).toBeInTheDocument();
    const feed = await screen.findByRole('region', { name: 'Recent activity' });
    await waitFor(() => expect(within(feed).getByRole('alert')).toHaveTextContent('Something went wrong on our side.'), {
      timeout: 4000,
    });

    failing = false;
    const before = requests.filter((r) => r.includes('/spaces?filter=')).length;
    await person.click(within(feed).getByRole('button', { name: 'Try again' }));
    expect(await within(feed).findByText(/Finished processing/)).toBeInTheDocument();
    expect(requests.filter((r) => r.includes('/spaces?filter=')).length).toBe(before);
  });

  it('shows the empty feed state when nothing has happened yet (REQ-277)', async () => {
    stubHome({ spaces: [] });
    renderWithProviders(<HomePage />);
    expect(await screen.findByText(/Nothing yet\./)).toBeInTheDocument();
  });

  // --- Shared spaces v1: mine first, then what others shared with me ------------

  it('splits the list into My spaces and Shared with me, with role and owner on shared rows', async () => {
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      if (path.includes('/spaces?filter=')) {
        return jsonResponse({
          spaces: [
            space({ id: 'shared-1', name: 'Team space', myRole: 'editor', ownerName: 'Tan', memberCount: 3 }),
            space({ id: 'mine-1', name: 'Sleep and memory' }),
          ],
        });
      }
      throw new Error(`unexpected request: ${path}`);
    });

    renderWithProviders(<HomePage />);

    expect(await screen.findByRole('heading', { name: 'Không gian của tôi' })).toBeInTheDocument();
    const shared = screen.getByRole('region', { name: 'Được chia sẻ với tôi' });
    expect(within(shared).getByRole('heading', { name: 'Team space' })).toBeInTheDocument();
    expect(within(shared).getByText('Editor')).toBeInTheDocument();
    expect(within(shared).getByText(/3 members · owned by Tan/)).toBeInTheDocument();
    // An editor may edit details but not archive; only the owner archives.
    expect(within(shared).getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(within(shared).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    const mine = screen.getByRole('region', { name: 'Không gian của tôi' });
    expect(within(mine).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('keeps the one flat list when nothing is shared, so a solo owner sees no sections', async () => {
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/activity')) return jsonResponse({ items: [], nextCursor: null });
      if (path.includes('/spaces?filter=')) return jsonResponse({ spaces: [space()] });
      throw new Error(`unexpected request: ${path}`);
    });
    renderWithProviders(<HomePage />);
    await screen.findByRole('heading', { name: 'Sleep and memory' });
    expect(screen.queryByRole('heading', { name: 'Không gian của tôi' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Được chia sẻ với tôi' })).not.toBeInTheDocument();
  });
});
