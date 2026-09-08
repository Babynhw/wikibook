import { useEffect, useRef, useState } from 'react';

/**
 * Reveals streamed answer text at a steady rate instead of in the jumps it
 * arrives in.
 *
 * The `structured` tier cannot stream more finely than one segment at a time:
 * `Output.array()` validates whole elements, and the AI SDK's
 * `partialOutputStream` was measured emitting **3 updates for the same answer
 * `elementStream` delivered in 2** — no finer, even though the endpoint sent ~16
 * raw chunks for it. Sub-segment text would mean hand-parsing the JSON again and
 * giving up the citation-index enum REQ-198 rests on. So the jumpiness is fixed
 * where it is actually fixable: in how it is *shown*.
 *
 * Presentation only. `pending.text` stays the authoritative record of what
 * arrived, nothing is held past the end of the answer, and a stored answer
 * renders whole — a saved answer is not typed out again on reload.
 */

/** Never slower than this, so a short tail does not crawl. */
const MIN_CHARS_PER_SECOND = 45;

/**
 * Pacing is aimed at the *next* arrival, not at emptying the buffer.
 *
 * Draining as fast as possible was the first version's mistake and it is worth
 * spelling out, because it looks right and reads wrong. Segments arrive roughly a
 * second apart; emptying each one in 250 ms produced 250 ms of typing followed by
 * **617 ms of frozen text** — measured, between two real frames — and then
 * another burst. The citation marker is appended immediately after its segment,
 * so the freeze landed just after `[1]` every time, which is exactly where it was
 * reported from.
 *
 * So the reveal spends the whole gap instead: it estimates how long arrivals have
 * been taking and paces to finish just as the next one is due. Falling behind
 * accelerates it automatically, because the time remaining in the estimate is the
 * denominator.
 */
const INITIAL_GAP_SECONDS = 1;
/** How fast the estimate follows a change in arrival rhythm. */
const GAP_SMOOTHING = 0.4;
/** Below this, pacing is pointless; above it, the tail left at `done` gets big. */
const MIN_GAP_SECONDS = 0.15;
const MAX_GAP_SECONDS = 1.6;
/** Always leave some runway, so the rate cannot divide by ~zero. */
const MIN_RUNWAY_SECONDS = 0.08;
/**
 * The most text the reveal will ever sit on.
 *
 * Pacing to the next arrival and flushing on `done` pull against each other:
 * holding back more removes mid-answer freezes and leaves more to appear at once
 * when the answer ends. Measured across runs, the two moved together — a 2 s
 * ceiling on the estimate cut the freezes to one but made the ending jump **229
 * characters**, about a third of the answer.
 *
 * So the backlog is capped rather than the runway. Anything beyond this drains
 * fast regardless of rhythm, which bounds what the ending can ever dump, while
 * a normal-sized backlog is still spread across the whole gap.
 */
const MAX_HELD_CHARS = 90;
/** How quickly the excess above `MAX_HELD_CHARS` is worked off. */
const CATCHUP_SECONDS = 0.25;
/**
 * The most elapsed time one frame may claim credit for.
 *
 * Without it a dropped frame — a slow paint, a background tab, a busy main
 * thread — hands the next frame its whole stall as elapsed time, and the reveal
 * dumps the accumulated characters in one step. Measured at 84 characters in a
 * single frame, which is the jump this hook exists to remove. Capping means the
 * reveal falls slightly behind after a stall and then catches up, because the
 * rate is driven by the backlog it just grew.
 */
const MAX_FRAME_SECONDS = 1 / 30;

/**
 * Backs an index out of the middle of a `[12]` citation marker.
 *
 * `renderWithMarkers` finds markers with `/\[(\d+)\]/`, so stopping after `[` or
 * `[1` would paint those characters as literal text for a frame and then swap
 * them for a control — a flicker on exactly the element §9 cares most about.
 * Revealing a marker all at once is calmer and also truer: half a citation is
 * not a citation.
 */
export function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const open = text.lastIndexOf('[', index - 1);
  if (open === -1) return index;
  // Only the run between `[` and the cut matters; anything else means the cut is
  // not inside a marker at all.
  return /^\[\d*$/.test(text.slice(open, index)) ? open : index;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * @param text   everything received so far
 * @param active whether the answer is still streaming. Going false reveals the
 *               rest at once, so the handoff to the stored thread never waits on
 *               an animation.
 */
export function useSmoothedText(text: string, active: boolean): string {
  const [shown, setShown] = useState(0);
  // Read inside the animation frame rather than closed over, so the loop does not
  // have to be torn down and rebuilt on every delta — restarting it each time was
  // what made the first version of this never advance: the elapsed-time baseline
  // reset before any frame could use it.
  const target = useRef(text);
  target.current = text;

  // A fresh answer starts empty, which is the signal to rewind.
  useEffect(() => {
    if (text === '') setShown(0);
  }, [text]);

  useEffect(() => {
    if (!active || prefersReducedMotion()) return;

    let frame = 0;
    let last = 0;
    let carry = 0;
    // Arrival rhythm, learned from the stream rather than assumed.
    let gap = INITIAL_GAP_SECONDS;
    let arrivedAt = 0;
    let seen = target.current.length;

    const step = (now: number) => {
      const elapsed = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
      last = now;

      if (target.current.length > seen) {
        if (arrivedAt !== 0) {
          const observed = (now - arrivedAt) / 1000;
          gap = gap * (1 - GAP_SMOOTHING) + observed * GAP_SMOOTHING;
        }
        arrivedAt = now;
        seen = target.current.length;
      }

      setShown((current) => {
        const backlog = target.current.length - current;
        if (backlog <= 0) return current;
        // Time left before the next arrival is due. Shrinking as it approaches is
        // what makes the reveal speed up rather than run out of text early.
        const sinceArrival = arrivedAt === 0 ? 0 : (now - arrivedAt) / 1000;
        const expected = Math.min(Math.max(gap, MIN_GAP_SECONDS), MAX_GAP_SECONDS);
        const runway = Math.max(MIN_RUNWAY_SECONDS, expected - sinceArrival);
        const rate = Math.max(
          MIN_CHARS_PER_SECOND,
          backlog / runway,
          Math.max(0, backlog - MAX_HELD_CHARS) / CATCHUP_SECONDS,
        );
        carry += rate * elapsed;
        const chars = Math.floor(carry);
        if (chars < 1) return current;
        carry -= chars;
        return current + Math.min(backlog, chars);
      });

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (!active || prefersReducedMotion()) return text;
  return text.slice(0, safeCut(text, Math.min(shown, text.length)));
}
