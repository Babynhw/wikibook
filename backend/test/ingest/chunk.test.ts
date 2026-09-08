import { describe, expect, it } from 'vitest';

import {
  chunkBlocks,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  type LocatedBlock,
} from '../../src/ingest/chunk.js';

const paragraph = (index: number, text: string, heading?: string): LocatedBlock => ({
  text,
  paragraphIndex: index,
  ...(heading === undefined ? {} : { heading }),
});

describe('chunkBlocks', () => {
  it('never merges across a PDF page boundary', () => {
    // Both blocks are short enough to merge on length alone — only the page
    // boundary keeps them apart, so this test is what the rule rests on.
    const passages = chunkBlocks([
      { text: 'Tail of page one.', page: 1 },
      { text: 'Head of page two.', page: 2 },
    ]);

    expect(passages).toHaveLength(2);
    expect(passages.map((passage) => passage.page)).toEqual([1, 2]);
    expect(passages[0]?.text).toBe('Tail of page one.');
    expect(passages[1]?.text).toBe('Head of page two.');
  });

  it('merges consecutive blocks on the same page', () => {
    const passages = chunkBlocks([
      { text: 'First half.', page: 3 },
      { text: 'Second half.', page: 3 },
    ]);

    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ page: 3, text: 'First half.\nSecond half.' });
  });

  it('records the block range each passage was built from', () => {
    // The reader highlights this range, so it is the citation's real target: a
    // range that drifts by one block highlights the wrong sentence (PRD §8).
    const passages = chunkBlocks([
      paragraph(1, 'One.'),
      paragraph(2, 'Two.'),
      { text: 'Page two starts.', page: 2 },
    ]);

    expect(passages.map((passage) => [passage.startBlockOrd, passage.endBlockOrd])).toEqual([
      [1, 2],
      [3, 3],
    ]);
  });

  it('gives every piece of an over-long paragraph that paragraph’s block range', () => {
    // The pieces overlap, so a per-piece range would be a guess; the whole
    // paragraph is the honest highlight.
    const passages = chunkBlocks([paragraph(1, 'a'), paragraph(2, 'z'.repeat(CHUNK_TARGET_CHARS * 2))]);

    expect(passages.length).toBeGreaterThan(2);
    expect(passages[0]).toMatchObject({ startBlockOrd: 1, endBlockOrd: 1 });
    for (const piece of passages.slice(1)) {
      expect(piece).toMatchObject({ startBlockOrd: 2, endBlockOrd: 2 });
    }
  });

  it('stops merging at the target length and emits a paragraph range', () => {
    const half = 'x'.repeat(Math.floor(CHUNK_TARGET_CHARS * 0.6));
    const passages = chunkBlocks([paragraph(1, half), paragraph(2, half), paragraph(3, 'Tail.')]);

    // 0.6 + 0.6 exceeds the target, so paragraph 2 starts a new passage.
    expect(passages.map((passage) => passage.paragraphRef)).toEqual(['p1', 'p2-p3']);
    expect(passages.every((passage) => passage.page === null)).toBe(true);
  });

  it('splits an over-long paragraph with an overlap instead of dropping text', () => {
    const long = 'y'.repeat(CHUNK_TARGET_CHARS * 2);
    const passages = chunkBlocks([paragraph(7, long)]);

    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((passage) => passage.paragraphRef === 'p7')).toBe(true);
    expect(passages[0]?.text).toHaveLength(CHUNK_TARGET_CHARS);
    // The second piece starts inside the first: the seam carries context.
    const advance = CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS;
    expect(passages[1]?.text.length).toBe(Math.min(CHUNK_TARGET_CHARS, long.length - advance));
  });

  /**
   * The fixture above is a single repeated character, so no split can ever land
   * on whitespace. Real prose is spaced, and a seam that falls on a space is the
   * case that used to end the loop early and drop the rest of the paragraph.
   * REQ-089: split with an overlap, never truncate.
   */
  it('keeps the whole paragraph when a split lands on whitespace', () => {
    const words = Array.from({ length: 1_000 }, (_, index) => `word${index % 7}`);
    const spaced = words.join(' ');
    // Force a space exactly on the first seam, which `trim()` would remove.
    const long = `${spaced.slice(0, CHUNK_TARGET_CHARS - 1)} ${spaced.slice(CHUNK_TARGET_CHARS)}`;
    expect(long[CHUNK_TARGET_CHARS - 1]).toBe(' ');

    const passages = chunkBlocks([paragraph(1, long)]);

    expect(passages.length).toBeGreaterThan(1);
    // Overlap means more characters out than in; truncation means far fewer.
    const kept = passages.reduce((total, passage) => total + passage.text.length, 0);
    expect(kept).toBeGreaterThanOrEqual(long.length);
    // The tail of the paragraph has to appear in the last passage.
    expect(passages.at(-1)?.text.endsWith(long.trimEnd().slice(-40))).toBe(true);
  });

  it('carries the nearest preceding heading as the section heading', () => {
    const passages = chunkBlocks([
      paragraph(1, 'Under the first heading.', 'Sleep and memory'),
      paragraph(2, 'Under the second heading.', 'Open questions'),
    ]);

    // Merged into one passage, so the heading is the first one seen — the
    // heading a reader would scroll past to reach this text.
    expect(passages).toHaveLength(1);
    expect(passages[0]?.sectionHeading).toBe('Sleep and memory');
  });

  it('returns nothing for no blocks', () => {
    expect(chunkBlocks([])).toEqual([]);
  });
});
