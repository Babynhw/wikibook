import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequireAuth } from '@/features/auth/require-auth';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com' };

function renderGuardedApp() {
  return renderWithProviders(
    <Routes>
      <Route element={<RequireAuth />}>
        <Route path="/" element={<p>Your workspace</p>} />
      </Route>
      <Route path="/login" element={<p>Sign in screen</p>} />
    </Routes>,
    { routerProps: { initialEntries: ['/'] } },
  );
}

describe('RequireAuth', () => {
  it('renders nothing but a status while the session hydrates (REQ-011)', async () => {
    // A request that never settles: redirecting here would bounce a signed-in
    // user who simply refreshed the page.
    stubFetch(() => new Promise<Response>(() => {}));

    renderGuardedApp();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading your workspace');
    expect(screen.queryByText('Sign in screen')).not.toBeInTheDocument();
  });

  it('lets a signed-in user through', async () => {
    stubFetch(() => jsonResponse({ user: USER }));

    renderGuardedApp();

    expect(await screen.findByText('Your workspace')).toBeInTheDocument();
  });

  it('redirects to sign-in when the session is genuinely gone (REQ-015)', async () => {
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthorized', message: 'You need to sign in.' } }, 401),
    );

    renderGuardedApp();

    expect(await screen.findByText('Sign in screen')).toBeInTheDocument();
  });

  describe('when the session lookup itself fails (REQ-017)', () => {
    it('shows the failure and a retry instead of pretending the user signed out', async () => {
      stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

      renderGuardedApp();

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      // The important half: a transient failure must not read as "signed out".
      expect(screen.queryByText('Sign in screen')).not.toBeInTheDocument();
    });

    it('recovers when the retry succeeds', async () => {
      let attempt = 0;
      stubFetch(() => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : jsonResponse({ user: USER });
      });

      renderGuardedApp();
      await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(screen.getByText('Your workspace')).toBeInTheDocument());
    });

    it('treats a 500 the same way — an error, not a sign-out', async () => {
      stubFetch(() =>
        jsonResponse({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500),
      );

      renderGuardedApp();

      expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
      expect(screen.queryByText('Sign in screen')).not.toBeInTheDocument();
    });
  });
});
