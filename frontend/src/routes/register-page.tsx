import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthLayout } from '@/features/auth/auth-layout';
import { useRegister } from '@/features/auth/use-auth';
import { useUi } from '@/lib/locale';

export function RegisterPage() {
  const navigate = useNavigate();
  const register = useRegister();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { text } = useUi();

  const error = register.error instanceof ApiError ? register.error : null;

  return (
    <AuthLayout
      title={text.auth.createYourAccount}
      footer={
        <>
          {text.auth.alreadyHaveOne}{' '}
           <Link to="/login" className="text-primary underline">
            {text.auth.signIn}
           </Link>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          register.mutate(
            { name, email, password },
            { onSuccess: () => navigate('/', { replace: true }) },
          );
        }}
      >
        {error ? <Alert>{error.message}</Alert> : null}

        <Field
          label={text.auth.name}
          name="name"
          autoComplete="name"
          value={name}
          error={error?.fields.name}
          onChange={(event) => setName(event.target.value)}
        />
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
          autoComplete="new-password"
          value={password}
          hint={text.auth.atLeastEight}
          error={error?.fields.password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <Button type="submit" disabled={register.isPending}>
          {register.isPending ? text.auth.creatingAccount : text.auth.createAccount}
        </Button>
      </form>
    </AuthLayout>
  );
}
