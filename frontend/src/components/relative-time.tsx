import { formatAbsolute, formatRelative } from '@/lib/relative-time';

/**
 * `<time>` with the machine-readable instant, the relative text visible, and
 * the full timestamp as the tooltip — one element for the Continue card, the
 * space rows, and the activity feed.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)} className={className}>
      {formatRelative(iso)}
    </time>
  );
}
