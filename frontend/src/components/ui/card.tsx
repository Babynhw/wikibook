import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** DESIGN.md Level 1: white surface, 1px outline, 24px padding, no shadow. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-outline-variant bg-surface-container-lowest p-6',
        className,
      )}
    >
      {children}
    </div>
  );
}
