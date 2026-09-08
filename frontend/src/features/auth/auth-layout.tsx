import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/** Shared frame for the four unauthenticated forms. */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-12">
      <p className="mb-8 font-mono text-xs tracking-widest text-on-surface-variant uppercase">
        WikiBookLM
      </p>
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-on-surface">{title}</h1>
        {description ? (
          <p className="mt-2 text-sm text-on-surface-variant">{description}</p>
        ) : null}
        <div className="mt-6">{children}</div>
      </Card>
      {footer ? <div className="mt-6 text-sm text-on-surface-variant">{footer}</div> : null}
    </main>
  );
}
