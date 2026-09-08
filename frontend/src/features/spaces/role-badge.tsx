import type { SpaceRole } from '@/lib/api';
import { cn } from '@/lib/utils';

const LABEL: Record<SpaceRole, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

/**
 * A member's role as a chip — DESIGN.md: small-scale, mono, a quiet fill. Text,
 * never colour alone (PRD §18), so every role reads the same way.
 */
export function RoleBadge({ role, className }: { role: SpaceRole; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-on-surface-variant',
        className,
      )}
    >
      {LABEL[role]}
    </span>
  );
}
