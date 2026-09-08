import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthLayout } from '@/features/auth/auth-layout';
import { useResetPassword } from '@/features/auth/use-auth';

export function ResetPage() {
  const [searchParams] = useSearchParams();
  const reset = useResetPassword();
  // The token arrives in the reset link; it stays editable so a user who pasted
  // a truncated link can fix it.
  const [token, setToken] = useState(searchParams.get('token') ?? '');
  const [password, setPassword] = useState('');

  const error = reset.error instanceof ApiError ? reset.error : null;

  return (
    <AuthLayout
      title="Choose a new password"
      footer={
        <Link to="/login" className="text-primary underline">
          Back to sign in
        </Link>
      }
    >
      {reset.isSuccess ? (
        <Alert variant="info">
          Your password has been changed and other sessions were signed out.{' '}
          <Link to="/login" className="text-primary underline">
            Sign in
          </Link>
        </Alert>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            reset.mutate({ token, password });
          }}
        >
          {error ? <Alert>{error.message}</Alert> : null}

          <Field
            label="Reset token"
            name="token"
            value={token}
            error={error?.fields.token}
            hint="From the reset link in your email."
            onChange={(event) => setToken(event.target.value)}
          />
          <Field
            label="New password"
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            hint="At least 8 characters."
            error={error?.fields.password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <Button type="submit" disabled={reset.isPending}>
            {reset.isPending ? 'Saving…' : 'Change password'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
