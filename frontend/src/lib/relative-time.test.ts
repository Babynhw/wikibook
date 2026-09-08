import { describe, expect, it } from 'vitest';
import { formatAbsolute, formatRelative } from '@/lib/relative-time';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('formatRelative', () => {
  it('is relative inside a week and absolute beyond it (REQ-278)', () => {
    expect(formatRelative(ago(20_000), NOW)).toBe('just now');
    expect(formatRelative(ago(5 * 60_000), NOW)).toBe('5 minutes ago');
    expect(formatRelative(ago(3 * 3_600_000), NOW)).toBe('3 hours ago');
    expect(formatRelative(ago(26 * 3_600_000), NOW)).toBe('yesterday');
    expect(formatRelative(ago(3 * 86_400_000), NOW)).toBe('3 days ago');
    expect(formatRelative(ago(8 * 86_400_000), NOW)).toBe('Aug 19');
    expect(formatRelative('2025-03-02T09:00:00.000Z', NOW)).toBe('Mar 2, 2025');
  });

  it('never throws on a bad timestamp', () => {
    expect(formatRelative('not a date', NOW)).toBe('');
    expect(formatAbsolute('not a date')).toBe('');
  });
});
