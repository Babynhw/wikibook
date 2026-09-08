import { describe, expect, it } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@/routes/login-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com' };

/** Reports wherever the app ended up, so a redirect is observable. */
function Landed() {
  const { pathname, search, hash } = useLocation();
  return <p>landed:{`${pathname}${search}${hash}`}</p>;
}

function renderLogin(state?: { from?: string }) {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Landed />} />
    </Routes>,
    { routerProps: { initialEntries: [{ pathname: '/login', state }] } },
  );
}

async function fillAndSubmit(password = 'password123') {
  await userEvent.type(screen.getByLabelText('Email'), USER.email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage', () => {
  describe('when the credentials are rejected (REQ-052)', () => {
    it('keeps what the user typed and shows the message beside the field', async () => {
      stubFetch(() =>
        jsonResponse(
          {
            error: {
              code: 'validation_failed',
              message: 'Please check the highlighted fields and try again.',
              fields: { password: 'Must be at least 8 characters.' },
            },
          },
          400,
        ),
      );

      renderLogin();
      await fillAndSubmit('short');

      // The form-level message is announced…
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Please check the highlighted fields and try again.',
      );
      // …the field message is attached to its own input (REQ-051/053)…
      const password = screen.getByLabelText('Password');
      expect(password).toHaveAttribute('aria-invalid', 'true');
      expect(password).toHaveAccessibleDescription('Must be at least 8 characters.');
      // …and nothing the user typed was thrown away.
      expect(screen.getByLabelText('Email')).toHaveValue(USER.email);
      expect(password).toHaveValue('short');
      expect(screen.queryByText(/^landed:/)).not.toBeInTheDocument();
    });

    it('shows a generic rejection without disclosing whether the email exists (REQ-021)', async () => {
      stubFetch(() =>
        jsonResponse(
          { error: { code: 'invalid_credentials', message: 'That email or password is incorrect.' } },
          400,
        ),
      );

      renderLogin();
      await fillAndSubmit();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'That email or password is incorrect.',
      );
      // No per-field blame that would single out the address.
      expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    });
  });

  describe('on success (REQ-019)', () => {
    it('returns the user to the location the guard sent them away from', async () => {
      stubFetch(() => jsonResponse({ user: USER }));

      renderLogin({ from: '/spaces/42?tab=sources#p3' });
      await fillAndSubmit();

      await waitFor(() =>
        expect(screen.getByText('landed:/spaces/42?tab=sources#p3')).toBeInTheDocument(),
      );
    });

    it('lands on the home screen when there was no requested location', async () => {
      stubFetch(() => jsonResponse({ user: USER }));

      renderLogin();
      await fillAndSubmit();

      await waitFor(() => expect(screen.getByText('landed:/')).toBeInTheDocument());
    });

    it.each(['//evil.example.com/phish', 'https://evil.example.com', 'javascript:alert(1)'])(
      'refuses to follow %s — a stored location is not an open redirect',
      async (from) => {
        stubFetch(() => jsonResponse({ user: USER }));

        renderLogin({ from });
        await fillAndSubmit();

        await waitFor(() => expect(screen.getByText('landed:/')).toBeInTheDocument());
      },
    );
  });
});
