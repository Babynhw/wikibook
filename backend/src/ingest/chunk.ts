/** A sheet of text with an exact location: page, paragraph index, or nearest heading. */
export interface LocatedBlock {
  text: string;
  /** Structural for PDFs: set by `getPage(n)`, so it cannot drift (PRD §6). */
  page?: number;
  /** Sequential across a source; web and manual blocks always carry it. */
  paragraphIndex?: number;
  /**
   * Nearest preceding heading; undefined where there is none. A block that *is*
   * a heading carries its own text here (`heading === text`) — the convention
   * the PDF extractor emits and the reader renders as a heading
   * (wiki-docs/plan/source-detail-reader/design.md). Web extraction folds
   * headings into the following blocks and emits no heading block.
   */
  heading?: string;
}

/**
 * One passage: exactly one source's text, at an exact location (PRD §6).
 * `chunkBlocks` takes no source id, so a passage mixing sources is not
 * expressible — the caller hands it one source's blocks.
 */
export interface ChunkedPassage {
  text: string;
  page: number | null;
  /** `p12`, or `p12-p14` when a passage merges blocks 12..14. Null for PDFs. */
  paragraphRef: string | null;
  sectionHeading: string | null;
  /**
   * The 1-based block range this passage was built from — the reader highlights
   * exactly these blocks, so a citation resolves by lookup rather than by
   * matching text back against the document (PRD §8). The pieces of an over-long
   * single paragraph all carry that one block's range, so a highlight covers the
   * whole paragraph rather than a slice of it.
   */
  startBlockOrd: number;
  endBlockOrd: number;
}

/** Target passage length, ≈1,200 characters (wiki-docs/plan/phase-2-ingestion/design.md). */
export const CHUNK_TARGET_CHARS = 1_200;
/** Overlap carried between the pieces of an over-long single paragraph (≈15%). */
export const CHUNK_OVERLAP_CHARS = Math.round(CHUNK_TARGET_CHARS * 0.15);

/**
 * Splits located blocks into passages. Two structural rules, enforced by the
 * algorithm rather than checked afterwards:
 *
 * - A passage never spans two sources — there is no source id in the signature.
 * - A PDF passage never spans two pages, which is what keeps `page` exact.
 *
 * Merging respects paragraph boundaries and stops at ~1,200 chars; a single
 * paragraph that exceeds the target is split mid-paragraph with a ~15% overlap
 * carried between pieces.
 */
export function chunkBlocks(blocks: LocatedBlock[]): ChunkedPassage[] {
  const passages: ChunkedPassage[] = [];
  // The block's own position in the source, carried alongside it: the reader
  // renders blocks by `ord`, so a passage has to name the range it came from.
  let buffer: { block: LocatedBlock; ord: number }[] = [];
  let bufferChars = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.map((entry) => entry.block.text).join('\n');
    passages.push(describe(buffer, text));
    buffer = [];
    bufferChars = 0;
  };

  for (const [index, block] of blocks.entries()) {
    const ord = index + 1;
    const last = buffer[buffer.length - 1]?.block;
    // Page boundary is a hard stop: nothing is merged across it, which is what
    // keeps `page` exact rather than "the page this passage mostly came from".
    if (last !== undefined && last.page !== block.page) {
      flush();
    }

    // A single over-long paragraph becomes its own passages, mid-paragraph
    // splits carrying the overlap so context is not cut at the seams.
    if (block.text.length > CHUNK_TARGET_CHARS) {
      flush();
      pushMidParagraph(block, ord, passages);
      continue;
    }

    if (buffer.length > 0 && bufferChars + block.text.length > CHUNK_TARGET_CHARS) {
      flush();
    }
    buffer.push({ block, ord });
    bufferChars += block.text.length;
  }
  flush();

  return passages;
}

function pushMidParagraph(block: LocatedBlock, ord: number, out: ChunkedPassage[]): void {
  let start = 0;
  while (start < block.text.length) {
    // The *raw* slice decides whether text remains; only the emitted text is
    // trimmed. Testing the trimmed length here would end the loop early whenever
    // the seam landed on whitespace — which is most of the time in real prose —
    // and silently drop the rest of the paragraph. REQ-089 requires a split with
    // an overlap, never a truncation.
    const raw = block.text.slice(start, start + CHUNK_TARGET_CHARS);
    const piece = raw.trim();
    if (piece.length > 0) out.push(describe([{ block, ord }], piece));
    if (raw.length < CHUNK_TARGET_CHARS) break;
    start += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS;
  }
}

function describe(entries: { block: LocatedBlock; ord: number }[], text: string): ChunkedPassage {
  const blocks = entries.map((entry) => entry.block);
  const firstPage = blocks.find((block) => block.page !== undefined)?.page;
  const paragraphs = blocks
    .filter((block) => block.paragraphIndex !== undefined)
    .map((block) => block.paragraphIndex!);

  let paragraphRef: string | null = null;
  if (paragraphs.length > 0) {
    const min = Math.min(...paragraphs);
    const max = Math.max(...paragraphs);
    paragraphRef = min === max ? `p${min}` : `p${min}-p${max}`;
  }

  return {
    text,
    page: firstPage ?? null,
    paragraphRef,
    sectionHeading: blocks.find((block) => block.heading !== undefined)?.heading ?? null,
    startBlockOrd: entries[0]!.ord,
    endBlockOrd: entries[entries.length - 1]!.ord,
  };
}
