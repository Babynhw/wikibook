import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthLayout } from '@/features/auth/auth-layout';
import { useLogin } from '@/features/auth/use-auth';
import { useUi } from '@/lib/locale';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useLogin();
  // Where the guard turned this user away from, so a deep link survives sign-in.
  // Only in-app paths: a `from` that isn't ours would be an open redirect.
  const requested = (location.state as { from?: string } | null)?.from;
  const from = requested?.startsWith('/') && !requested.startsWith('//') ? requested : '/';
  // Controlled inputs: a failed submit must keep what the user typed (PRD §16).
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { text } = useUi();

  const error = login.error instanceof ApiError ? login.error : null;

  return (
    <AuthLayout
      title={text.auth.signIn}
      description={text.auth.researchSpaces}
      footer={
        <>
          {text.auth.noAccount}{' '}
          <Link to="/register" className="text-primary underline">
            {text.auth.createAccount}
          </Link>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ email, password }, { onSuccess: () => navigate(from, { replace: true }) });
        }}
      >
        {error ? <Alert>{error.message}</Alert> : null}

        <Field
          label={text.auth.email}
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          error={error?.fields.email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label={text.auth.password}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          error={error?.fields.password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <Button type="submit" disabled={login.isPending}>
          {login.isPending ? text.auth.signingIn : text.auth.signIn}
        </Button>

        <Link to="/forgot" className="text-sm text-on-surface-variant underline">
          {text.auth.forgotPassword}
        </Link>
      </form>
    </AuthLayout>
  );
}
