import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvitePage } from '@/routes/invite-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const me = { id: 'u-editor', name: 'Minh', email: 'minh@example.test' };

function renderPage(handler: Parameters<typeof stubFetch>[0]) {
  const spy = stubFetch(handler);
  const result = renderWithProviders(
    <Routes>
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/spaces/:id" element={<p>Space page</p>} />
      <Route path="/login" element={<p>Login page</p>} />
      <Route path="/" element={<p>Home</p>} />
    </Routes>,
    { routerProps: { initialEntries: ['/invite/tok-123'] } },
  );
  return { ...result, spy };
}

describe('InvitePage (shared-spaces-v1)', () => {
  it('previews the invite for the matching account and accepts into the space', async () => {
    const person = userEvent.setup();
    const { spy } = renderPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: me });
      if (path.endsWith('/invites/tok-123') && init?.method !== 'POST') {
        return jsonResponse({
          invite: { spaceId: 'space-1', spaceName: 'Team space', role: 'editor', inviterName: 'Tan', expiresAt: '2026-09-04T10:00:00.000Z', alreadyMember: false },
        });
      }
      if (path.endsWith('/invites/tok-123/accept') && init?.method === 'POST') {
        return jsonResponse({ spaceId: 'space-1', role: 'editor' });
      }
      if (path.includes('/spaces?filter=')) return jsonResponse({ spaces: [] });
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    expect(await screen.findByRole('heading', { name: 'Team space' })).toBeInTheDocument();
    expect(screen.getByText(/Tan invited you/)).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Accept and open' }));
    await waitFor(() =>
      expect(spy.mock.calls.some(([input, init]) => String(input).endsWith('/accept') && init?.method === 'POST')).toBe(true),
    );
    expect(await screen.findByText('Space page')).toBeInTheDocument();
  });

  it('shows one neutral page for an invalid link — expired, used, or another account’s', async () => {
    renderPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: me });
      if (path.includes('/invites/')) return jsonResponse({ error: { code: 'not_found', message: 'This invite link is not valid.' } }, 404);
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    expect(await screen.findByRole('heading', { name: /isn’t valid/ })).toBeInTheDocument();
    // Names the account so a wrong-account visitor can work it out themselves.
    expect(screen.getByText(/signed in with \(minh@example\.test\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to your spaces' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign in, and never asks the server about the token', async () => {
    const { spy } = renderPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'Sign in.' } }, 401);
      return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
    });

    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(spy.mock.calls.some(([input]) => String(input).includes('/invites/'))).toBe(false);
  });
});
