/**
 * Relative timestamps for the home page and the activity feed (PRD §15).
 *
 * `Intl.RelativeTimeFormat` for anything inside a week ("2 minutes ago",
 * "yesterday"), an absolute date beyond it — a feed entry from March is not
 * "23 weeks ago" to anyone. No date library.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const sameYear = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const otherYear = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });
const full = new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'short' });

/** "just now" · "5 minutes ago" · "3 hours ago" · "yesterday" · "Aug 3" · "Aug 3, 2025". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso);
  const diff = now - then.getTime();
  if (Number.isNaN(diff)) return '';
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return relative.format(-Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return relative.format(-Math.floor(diff / HOUR), 'hour');
  if (diff < WEEK) return relative.format(-Math.floor(diff / DAY), 'day');
  return then.getFullYear() === new Date(now).getFullYear() ? sameYear.format(then) : otherYear.format(then);
}

/** The full timestamp, for a `title` or a screen reader. */
export function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : full.format(date);
}
