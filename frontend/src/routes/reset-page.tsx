import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthLayout } from '@/features/auth/auth-layout';
import { useResetPassword } from '@/features/auth/use-auth';
import { useUi } from '@/lib/locale';

export function ResetPage() {
  const [searchParams] = useSearchParams();
  const reset = useResetPassword();
  const { text } = useUi();
  // The token arrives in the reset link; it stays editable so a user who pasted
  // a truncated link can fix it.
  const [token, setToken] = useState(searchParams.get('token') ?? '');
  const [password, setPassword] = useState('');

  const error = reset.error instanceof ApiError ? reset.error : null;

  return (
    <AuthLayout
      title={text.authExtra.choosePassword}
      footer={
        <Link to="/login" className="text-primary underline">
          {text.authExtra.backToSignIn}
        </Link>
      }
    >
      {reset.isSuccess ? (
        <Alert variant="info">
          {text.authExtra.passwordChanged}{' '}
          <Link to="/login" className="text-primary underline">
            {text.auth.signIn}
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
            label={text.authExtra.resetToken}
            name="token"
            value={token}
            error={error?.fields.token}
            hint={text.authExtra.tokenHint}
            onChange={(event) => setToken(event.target.value)}
          />
          <Field
            label={text.authExtra.newPassword}
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            hint={text.auth.atLeastEight}
            error={error?.fields.password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <Button type="submit" disabled={reset.isPending}>
            {reset.isPending ? text.common.saving : text.authExtra.changePassword}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
