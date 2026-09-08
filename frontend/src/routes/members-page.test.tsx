import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Space, SpaceInvite, SpaceMember } from '@/lib/api';
import { MembersPage } from '@/routes/members-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const me = { id: 'u-owner', name: 'Tan', email: 'tan@example.test' };

const space = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
  name: 'Team space',
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
  ownerName: 'Tan',
  memberCount: 3,
  ...overrides,
});

const members: SpaceMember[] = [
  { userId: 'u-owner', name: 'Tan', email: 'tan@example.test', role: 'owner', joinedAt: '2026-08-01T10:00:00.000Z' },
  { userId: 'u-editor', name: 'Minh', email: 'minh@example.test', role: 'editor', joinedAt: '2026-08-02T10:00:00.000Z' },
  { userId: 'u-viewer', name: 'Linh', email: 'linh@example.test', role: 'viewer', joinedAt: '2026-08-03T10:00:00.000Z' },
];

const invites: SpaceInvite[] = [
  { id: 'inv-1', email: 'an@example.test', role: 'editor', expiresAt: '2026-09-04T10:00:00.000Z', createdAt: '2026-08-28T10:00:00.000Z' },
];

function renderPage(handler: Parameters<typeof stubFetch>[0]) {
  const spy = stubFetch(handler);
  const result = renderWithProviders(
    <Routes>
      <Route path="/spaces/:spaceId/members" element={<MembersPage />} />
      <Route path="/" element={<p>Home</p>} />
    </Routes>,
    { routerProps: { initialEntries: ['/spaces/space-1/members'] } },
  );
  return { ...result, spy };
}

const calls = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`);

describe('MembersPage (shared-spaces-v1)', () => {
  it('shows the roster with roles; the owner sees pending invites and controls', async () => {
    renderPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: me });
      if (path.endsWith('/spaces/space-1')) return jsonResponse({ space: space() });
      if (path.endsWith('/members')) return jsonResponse({ members, invites });
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    expect(await screen.findByRole('heading', { name: '3 members' })).toBeInTheDocument();
    expect(screen.getByText('Tan')).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
    // Owner controls: a labelled role select per non-owner, Remove, Make owner for an editor.
    expect(screen.getByLabelText('Role for Minh')).toHaveValue('editor');
    expect(screen.getByLabelText('Role for Linh')).toHaveValue('viewer');
    expect(screen.getByRole('button', { name: 'Remove Minh' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Make owner' })).toHaveLength(1);
    // Pending invites, by email, with Copy link and Revoke.
    expect(screen.getByRole('heading', { name: 'Pending invites' })).toBeInTheDocument();
    expect(screen.getByText('an@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave space' })).not.toBeInTheDocument();
  });

  it('a non-owner sees the roster read-only, no invites, and can leave', async () => {
    const person = userEvent.setup();
    const { spy } = renderPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: { id: 'u-editor', name: 'Minh', email: 'minh@example.test' } });
      if (path.endsWith('/spaces/space-1')) return jsonResponse({ space: space({ myRole: 'editor' }) });
      if (path.endsWith('/members')) return jsonResponse({ members, invites: [] });
      if (path.endsWith('/leave') && init?.method === 'POST') return new Response(null, { status: 204 });
      if (path.includes('/spaces?filter=')) return jsonResponse({ spaces: [] });
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    await screen.findByRole('heading', { name: '3 members' });
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pending invites' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(screen.getByText(/Tan owns it/)).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Leave space' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/conversations with the assistant here are deleted/);
    await person.click(within(dialog).getByRole('button', { name: 'Leave space' }));
    await waitFor(() => expect(calls(spy)).toContain('POST /api/spaces/space-1/leave'));
    expect(await screen.findByText('Home')).toBeInTheDocument();
  });

  it('invites by email and shows the link once, with a Copy control', async () => {
    const person = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { spy } = renderPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: me });
      if (path.endsWith('/spaces/space-1')) return jsonResponse({ space: space() });
      if (path.endsWith('/members')) return jsonResponse({ members, invites: [] });
      if (path.endsWith('/invites') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ email: 'an@example.test', role: 'viewer' });
        return jsonResponse(
          { invite: { ...invites[0], role: 'viewer' }, url: 'http://localhost:5173/invite/tok-123' },
          201,
        );
      }
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    await screen.findByRole('heading', { name: '3 members' });
    await person.click(screen.getByRole('button', { name: 'Invite' }));
    const dialog = screen.getByRole('dialog');
    await person.type(within(dialog).getByLabelText('Email'), 'an@example.test');
    await person.selectOptions(within(dialog).getByLabelText('Role'), 'viewer');
    await person.click(within(dialog).getByRole('button', { name: 'Create invite link' }));

    expect(await within(dialog).findByText('http://localhost:5173/invite/tok-123')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/only time the link is shown/i);
    await person.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('http://localhost:5173/invite/tok-123');
    expect(await within(dialog).findByText('Copied.')).toBeInTheDocument();
    expect(calls(spy)).toContain('POST /api/spaces/space-1/invites');
  });

  it('shows the server’s refusal beside the form and keeps the typed email', async () => {
    const person = userEvent.setup();
    renderPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: me });
      if (path.endsWith('/spaces/space-1')) return jsonResponse({ space: space() });
      if (path.endsWith('/members')) return jsonResponse({ members, invites: [] });
      if (path.endsWith('/invites') && init?.method === 'POST') {
        return jsonResponse(
          { error: { code: 'members_limit', message: 'This space can have at most 3 members, pending invites included.' } },
          409,
        );
      }
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    await screen.findByRole('heading', { name: '3 members' });
    await person.click(screen.getByRole('button', { name: 'Invite' }));
    const dialog = screen.getByRole('dialog');
    await person.type(within(dialog).getByLabelText('Email'), 'an@example.test');
    await person.click(within(dialog).getByRole('button', { name: 'Create invite link' }));
    expect(await within(dialog).findByText(/at most 3 members/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Email')).toHaveValue('an@example.test');
  });

  it('removing a member asks first and names what is lost', async () => {
    const person = userEvent.setup();
    const { spy } = renderPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: me });
      if (path.endsWith('/spaces/space-1')) return jsonResponse({ space: space() });
      if (path.endsWith('/members') && init?.method !== 'DELETE') return jsonResponse({ members, invites: [] });
      if (path.endsWith('/members/u-editor') && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    await screen.findByRole('heading', { name: '3 members' });
    await person.click(screen.getByRole('button', { name: 'Remove Minh' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Remove Minh?');
    expect(dialog).toHaveTextContent(/Sources and notes they added stay/);
    expect(calls(spy).some((c) => c.startsWith('DELETE'))).toBe(false);
    await person.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls(spy)).toContain('DELETE /api/spaces/space-1/members/u-editor'));
  });
});
