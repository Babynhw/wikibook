import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface AlertProps {
  children: ReactNode;
  variant?: 'error' | 'info';
  className?: string;
}

/**
 * Form-level message. A failed submit is announced assertively (`role="alert"`)
 * so the user does not have to hunt for it (PRD §16/§18); a confirmation is
 * announced politely (`role="status"`) instead of interrupting the reader
 * mid-sentence — and `variant="info"` panels may contain a link, which belongs
 * in a polite region.
 */
export function Alert({ children, variant = 'error', className }: AlertProps) {
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded border px-3 py-2 text-sm',
        variant === 'error'
          ? 'border-error/30 bg-error-container text-on-error-container'
          : 'border-outline-variant bg-surface-container-low text-on-surface-variant',
        className,
      )}
    >
      {children}
    </div>
  );
}
