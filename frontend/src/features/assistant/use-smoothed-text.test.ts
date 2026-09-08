import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { safeCut, useSmoothedText } from './use-smoothed-text';

/**
 * The reveal boundary. Everything else in the hook is timing, which jsdom cannot
 * judge; this is the part that can be wrong in a way a user would see.
 */
describe('safeCut', () => {
  const text = 'Withdrawal felt costly [1], though not everywhere [12].';

  it('leaves a cut that is not inside a marker alone', () => {
    for (const index of [0, 5, 22, text.length]) {
      expect(safeCut(text, index), String(index)).toBe(index);
    }
  });

  it('backs out of a marker rather than revealing half of it', () => {
    const open = text.indexOf('[1]');
    // `[`, `[1` — both would render as literal text for a frame and then be
    // replaced by a control, which is a flicker on the one element §9 is about.
    expect(safeCut(text, open + 1)).toBe(open);
    expect(safeCut(text, open + 2)).toBe(open);
    // The closing bracket completes it, so the whole marker may be shown.
    expect(safeCut(text, open + 3)).toBe(open + 3);
  });

  it('handles a two-digit marker', () => {
    const open = text.indexOf('[12]');
    expect(safeCut(text, open + 2)).toBe(open);
    expect(safeCut(text, open + 3)).toBe(open);
    expect(safeCut(text, open + 4)).toBe(open + 4);
  });

  it('backs out of a marker that is still arriving', () => {
    // No `]` yet, because the citation event has not landed.
    const partial = 'Withdrawal felt costly [1';
    expect(safeCut(partial, partial.length - 1)).toBe(partial.length - 2);
  });

  it('does not mistake an ordinary bracket for a marker', () => {
    const prose = 'The study [Smith and Jones] reported no pressure.';
    const inside = prose.indexOf('Smith') + 2;
    // `[Sm` is not `[digits`, so nothing is held back.
    expect(safeCut(prose, inside)).toBe(inside);
  });
});

describe('useSmoothedText', () => {
  const long = 'A sentence that arrived all at once, as a completed segment does.';

  it('reveals a segment progressively rather than in one jump', async () => {
    const { result } = renderHook(({ text }) => useSmoothedText(text, true), {
      initialProps: { text: long },
    });

    // The whole segment landed in one delta; it must not all be on screen yet.
    expect(result.current.length).toBeLessThan(long.length);
    // Generous, and deliberately so: pacing now aims at the next arrival rather
    // than at emptying the buffer, so a lone segment is spread over roughly the
    // expected gap. Worst case is `MAX_GAP_SECONDS` plus the minimum rate.
    await waitFor(() => expect(result.current).toBe(long), { timeout: 4000 });
  });

  it('shows everything at once when the answer is no longer streaming', () => {
    // The handoff to the stored thread happens on `done`; making it wait for an
    // animation would put a gap between the answer and its saved copy.
    const { result } = renderHook(() => useSmoothedText(long, false));
    expect(result.current).toBe(long);
  });

  it('rewinds when a new answer starts', async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothedText(text, true), {
      initialProps: { text: long },
    });
    await waitFor(() => expect(result.current).toBe(long), { timeout: 4000 });

    rerender({ text: '' });
    expect(result.current).toBe('');
    rerender({ text: long });
    // Not instantly complete again — the next answer types out too.
    expect(result.current.length).toBeLessThan(long.length);
  });
});
