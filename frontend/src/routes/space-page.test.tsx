import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Space } from '@/lib/api';
import { SpacePage } from '@/routes/space-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const space = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
  name: 'Sleep and memory',
  objective: 'How does sleep consolidate memory?',
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

function renderSpacePage(handler: Parameters<typeof stubFetch>[0]) {
  stubFetch(handler);
  return renderWithProviders(
    <Routes>
      <Route path="/spaces/:id" element={<SpacePage />} />
    </Routes>,
    { routerProps: { initialEntries: ['/spaces/space-1'] } },
  );
}

describe('SpacePage', () => {
  /** REQ-071 — the new-space state names every region and prompts for evidence. */
  it('renders the new-space state and stamps last-opened once', async () => {
    const calls: string[] = [];
    renderSpacePage((path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.endsWith('/open')) return jsonResponse({ space: space({ lastOpenedAt: 'now' }) });
      if (path.includes('/sources')) return jsonResponse({ sources: [] });
      return jsonResponse({ space: space() });
    });

    expect(await screen.findByRole('heading', { name: 'Sleep and memory' })).toBeInTheDocument();

    for (const region of ['Source library', 'Assistant', 'Notes', 'Notebook']) {
      expect(screen.getByRole('heading', { name: region })).toBeInTheDocument();
    }
    expect(screen.getByText(/only answers from evidence you add/i)).toBeInTheDocument();

    // Live since Phase 2: the empty-library copy stays, the action works. The
    // rail offers Add source too, so ask the page body, not the whole screen.
    expect(
      within(screen.getByRole('main')).getByRole('button', { name: 'Add source' }),
    ).toBeEnabled();
    // …and the rail's (REQ-237) makes two on the library page.
    expect(screen.getAllByRole('button', { name: 'Add source' })).toHaveLength(2);
    expect(screen.getByText(/No sources yet/i)).toBeInTheDocument();

    await waitFor(() => expect(calls).toContain('POST /api/spaces/space-1/open'));
    expect(calls.filter((call) => call.endsWith('/open'))).toHaveLength(1);
  });

  /**
   * Found by the Phase 7 §21 walk: the first source of a space flips the library
   * from its empty state to the list, and the Add dialog — rendered inside each
   * branch — remounted there and stayed open, blank, over the new list.
   */
  it('closes the Add dialog after the first source lands, as the library flips from empty to list', async () => {
    const person = userEvent.setup();
    const added = {
      id: 'src-1', spaceId: 'space-1', type: 'manual', title: 'A pasted excerpt', author: null, url: null,
      state: 'processing', errorMessage: null, createdAt: '2026-08-12T10:00:00.000Z', updatedAt: '2026-08-12T10:00:00.000Z',
    };
    let sources: unknown[] = [];
    renderSpacePage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.endsWith('/open')) return jsonResponse({ space: space({ lastOpenedAt: 'now' }) });
      if (path.endsWith('/sources') && init?.method === 'POST') {
        sources = [added];
        return jsonResponse({ source: added }, 201);
      }
      // The refetch takes real time in a browser; give React the same chance to
      // commit the empty → list flip before the mutation settles.
      if (path.includes('/sources')) {
        return new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse({ sources })), 30));
      }
      return jsonResponse({ space: space() });
    });

    await screen.findByText(/No sources yet/i);
    await person.click(within(screen.getByRole('main')).getByRole('button', { name: 'Add source' }));
    const dialog = screen.getByRole('dialog');
    await person.click(within(dialog).getByRole('tab', { name: 'Text' }));
    await person.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'A pasted excerpt');
    await person.type(within(dialog).getByRole('textbox', { name: /^Text$/ }), 'Memory is consolidated during sleep.');
    await person.click(within(dialog).getByRole('button', { name: 'Add source' }));

    expect(await screen.findByRole('link', { name: /A pasted excerpt/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  /** REQ-076 — an archived space is read-only, says so, and is never opened. */
  it('shows a read-only banner for an archived space, hides Add source, and never opens it', async () => {
    const calls: string[] = [];
    renderSpacePage((path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/sources')) return jsonResponse({ sources: [] });
      return jsonResponse({ space: space({ archivedAt: '2026-08-11T10:00:00.000Z' }) });
    });

    expect(await screen.findByText(/archived and read-only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    // Adding a source answers 409 while archived, so the action is not offered.
    expect(screen.queryByRole('button', { name: 'Add source' })).not.toBeInTheDocument();
    // The API answers 409 for open on an archived space; the SPA must not ask.
    expect(calls.some((call) => call.endsWith('/open'))).toBe(false);
  });

  /** REQ-073 — a restore that fails on the banner says so rather than stalling. */
  it('explains a failed restore from the archived banner', async () => {
    const person = userEvent.setup();
    renderSpacePage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/sources')) return jsonResponse({ sources: [] });
      if (init?.method === 'POST') {
        return jsonResponse(
          { error: { code: 'not_found', message: 'We could not find that.' } },
          404,
        );
      }
      return jsonResponse({ space: space({ archivedAt: '2026-08-11T10:00:00.000Z' }) });
    });

    await person.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('We could not find that.')).toBeInTheDocument();
    // The banner stays: the space is still archived, and it still says why.
    expect(screen.getByText(/archived and read-only/i)).toBeInTheDocument();
  });

  /** REQ-077 — a load failure that is not a 404 offers a retry, not a dead end. */
  it('offers a retry when the space fails to load for another reason', async () => {
    const person = userEvent.setup();
    let failing = true;
    renderSpacePage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/spaces/space-1') && failing) {
        failing = false;
        // A 4xx, which the client's retry rule declines to repeat.
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
      return jsonResponse({ space: space() });
    });

    expect(await screen.findByText('We could not load that space')).toBeInTheDocument();
    expect(screen.getByText('Too many attempts. Please try again shortly.')).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Sleep and memory' })).toBeInTheDocument();
  });

  /** REQ-077 — a foreign or deleted space explains itself instead of looping. */
  it('renders a not-found state for a space the user cannot see', async () => {
    renderSpacePage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      return jsonResponse({ error: { code: 'not_found', message: 'We could not find that.' } }, 404);
    });

    expect(await screen.findByText('We could not find that space')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to your spaces' })).toBeInTheDocument();
  });

  // --- Shared spaces v1 ---------------------------------------------------------

  it('a viewer sees the library and the shared line, but no Add source anywhere', async () => {
    const calls: string[] = [];
    renderSpacePage((path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      // `open` writes the detail cache from its response, so it must carry the same shape.
      const viewer = space({ myRole: 'viewer', ownerName: 'Tan', memberCount: 2 });
      if (path.endsWith('/open')) return jsonResponse({ space: { ...viewer, lastOpenedAt: 'now' } });
      if (path.includes('/sources')) return jsonResponse({ sources: [] });
      return jsonResponse({ space: viewer });
    });

    expect(await screen.findByRole('heading', { name: 'Sleep and memory' })).toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.getByText(/2 members · owned by Tan/)).toBeInTheDocument();
    expect(screen.getByText(/needs an editor role/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add source' })).not.toBeInTheDocument();
    // Resume is per member: a viewer's open still stamps their own row.
    await waitFor(() => expect(calls).toContain('POST /api/spaces/space-1/open'));
  });

  it('an archived shared space tells a non-owner that only the owner can restore it', async () => {
    renderSpacePage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/sources')) return jsonResponse({ sources: [] });
      return jsonResponse({
        space: space({ myRole: 'editor', ownerName: 'Tan', memberCount: 2, archivedAt: '2026-08-20T00:00:00.000Z' }),
      });
    });
    expect(await screen.findByText(/Only the owner can restore it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('marks a source another member added since my last visit — measured before this visit stamps', async () => {
    const before = space({ myRole: 'owner', memberCount: 2, lastOpenedAt: '2026-08-10T10:00:00.000Z' });
    const added = {
      id: 'src-new', spaceId: 'space-1', type: 'manual', title: 'Minh’s addition', author: null, url: null,
      state: 'ready', errorMessage: null, createdAt: '2026-08-20T10:00:00.000Z', updatedAt: '2026-08-20T10:00:00.000Z',
      addedBy: { id: 'u-minh', name: 'Minh' },
    };
    renderSpacePage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.endsWith('/open')) return jsonResponse({ space: { ...before, lastOpenedAt: '2026-08-28T10:00:00.000Z' } });
      if (path.includes('/sources') && init?.method !== 'POST') return jsonResponse({ sources: [added] });
      return jsonResponse({ space: before });
    });
    expect(await screen.findByText(/added .* by Minh/)).toBeInTheDocument();
    expect(await screen.findByText('New since your last visit')).toBeInTheDocument();
  });
});
