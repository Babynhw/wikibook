import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthLayout } from '@/features/auth/auth-layout';
import { useForgotPassword } from '@/features/auth/use-auth';

export function ForgotPage() {
  const forgot = useForgotPassword();
  const [email, setEmail] = useState('');

  const error = forgot.error instanceof ApiError ? forgot.error : null;

  return (
    <AuthLayout
      title="Reset your password"
      description="We'll send reset instructions to your email address."
      footer={
        <Link to="/login" className="text-primary underline">
          Back to sign in
        </Link>
      }
    >
      {forgot.isSuccess ? (
        // Deliberately the same message whether or not the address exists (PRD §3).
        <Alert variant="info">{forgot.data.message}</Alert>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            forgot.mutate({ email });
          }}
        >
          {error ? <Alert>{error.message}</Alert> : null}

          <Field
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            error={error?.fields.email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <Button type="submit" disabled={forgot.isPending}>
            {forgot.isPending ? 'Sending…' : 'Send reset instructions'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
