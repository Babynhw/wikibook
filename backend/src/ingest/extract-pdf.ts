import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfDetection, UnretryableIngestError } from './errors.js';
import type { ExtractionResult } from './extracted.js';
import type { LocatedBlock } from './chunk.js';

/** Below this many extractable characters the PDF is treated as having no text layer. */
const MIN_TEXT_CHARS = 20;

/**
 * Paragraph grouping thresholds (wiki-docs/plan/source-detail-reader/design.md
 * "grouped by geometry"). All ratios are relative to the *previous* line's font
 * height, so a 24pt heading and a 10pt footnote are judged on their own scale.
 */
/**
 * A line continues its paragraph when the baseline gap is at most this many
 * font heights. Body leading runs 1.2–1.7 (a browser's print-to-PDF sits at
 * ~1.63); a paragraph break adds at least half a line on top, so 1.9 sits in
 * the gap between the two.
 */
export const MAX_LINE_GAP_RATIO = 1.9;
/** Two lines are the same font size when they differ by less than this fraction. */
export const FONT_SIZE_TOLERANCE = 0.12;
/** Left edges within this many ems are the same column edge. */
export const INDENT_TOLERANCE_EM = 1.0;
/** A first line may be indented by up to this many ems and still start the paragraph. */
export const FIRST_LINE_INDENT_EM = 3.0;
/** A line at least this many times the body size is heading-sized. */
export const HEADING_SIZE_RATIO = 1.15;
/** Longer than this is large-type body (a pull quote, an intro), not a heading. */
export const HEADING_MAX_CHARS = 120;
/** Taller than this is large-type body, not a heading. */
export const HEADING_MAX_LINES = 2;
/** More than this fraction of consecutive lines moving *up* the page means the order is not reading order. */
export const MAX_UPWARD_JUMP_RATIO = 0.2;
/** Under this many lines the median font height is meaningless, so nothing is a heading. */
export const MIN_LINES_FOR_MEDIAN = 3;
/** A sentence end; followed by an indented line it marks a paragraph boundary. */
export const TERMINAL_PUNCT = /[.!?]["')\]]?$/;
/** Items closer than this fraction of a line height in y are one visual line pdf.js split. */
const SAME_LINE_RATIO = 0.5;

export interface ExtractPdfOptions {
  /** PRD §5 `pdf_max_pages`, read from `AppConfig` by the caller. */
  maxPages: number;
}

/**
 * PDF extraction via pdf.js, page by page — `getPage(n).getTextContent()` makes
 * the page number structural rather than reconstructed from form feeds, which is
 * what PRD §6's "page references stay accurate" acceptance criterion is about
 * (wiki-docs/plan/phase-2-ingestion/design.md "PDF extraction").
 *
 * Blocks are *paragraphs*, not printed lines: lines are grouped by their
 * geometry, and a line set noticeably larger than the document's body text is
 * emitted as a heading block — marked by `heading === text`, the convention
 * `LocatedBlock.heading` documents. A page whose line order does not read top to
 * bottom keeps one block per line, which is what every PDF got before this.
 *
 * Failures map to {@link UnretryableIngestError} with the plain-language
 * messages the design lists; the underlying error stays in the `cause`.
 */
export async function extractPdf(
  data: Buffer,
  { maxPages }: ExtractPdfOptions,
): Promise<ExtractionResult> {
  let document;
  try {
    document = await getDocument({
      data: new Uint8Array(data),
      verbosity: VerbosityLevel.ERRORS,
    }).promise;
  } catch (error) {
    throw pdfDetection(error);
  }

  if (document.numPages > maxPages) {
    throw new UnretryableIngestError(
      `This PDF has ${document.numPages} pages, over the ${maxPages}-page limit. Split it into smaller files and add them separately.`,
    );
  }

  // Two passes: the heading threshold is a *document* property (its body size),
  // so every page's lines are collected before any page is grouped.
  const pages: PdfLine[][] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(
      collectLines(
        content.items.filter(
          (item): item is Extract<typeof item, { str?: string }> => 'str' in item,
        ),
      ),
    );
  }

  const allLines = pages.flat();
  const bodyHeight = medianFontHeight(allLines);
  const headingsEnabled = allLines.length >= MIN_LINES_FOR_MEDIAN;

  const blocks: LocatedBlock[] = [];
  // The nearest preceding heading carries across pages, as it does for a web
  // article's sections; paragraphs themselves never do (REQ-128).
  let currentHeading: string | undefined;
  pages.forEach((lines, index) => {
    const page = index + 1;
    const paragraphs = layoutLooksLinear(lines)
      ? groupParagraphs(lines, bodyHeight, headingsEnabled)
      : lines.map((line) => ({ text: line.text, isHeading: false }));
    for (const paragraph of paragraphs) {
      if (paragraph.isHeading) currentHeading = paragraph.text;
      blocks.push({
        text: paragraph.text,
        page,
        ...(paragraph.isHeading
          ? { heading: paragraph.text }
          : currentHeading !== undefined
            ? { heading: currentHeading }
            : {}),
      });
    }
  });

  const text = blocks.map((block) => block.text).join('\n');
  if (text.trim().length < MIN_TEXT_CHARS) {
    // §20 excludes OCR, so a scan with no text layer is a final state, not a TODO.
    throw new UnretryableIngestError(
      'This PDF has no selectable text — scanned documents are not supported.',
    );
  }

  return { text, blocks };
}

/** The subset of pdf.js's `TextItem` the grouping reads. */
export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  /** `[scaleX, skewY, skewX, scaleY, x, y]` in user space. */
  transform?: number[];
  width?: number;
  /** Font size in user space — already scaled, unlike `transform[0]`, which is 0 for rotated text. */
  height?: number;
  fontName?: string;
  dir?: string;
}

/** One printed line with the geometry paragraph grouping needs. */
export interface PdfLine {
  text: string;
  /** Baseline, from the first non-blank item. */
  y: number;
  /** Left edge, from the first non-blank item. */
  x: number;
  xEnd: number;
  /** The largest font height on the line. */
  fontHeight: number;
  fontName: string;
  /** Vertical writing or a skewed matrix — the page's order is not top-to-bottom reading order. */
  rotated: boolean;
}

export interface PdfParagraph {
  text: string;
  isHeading: boolean;
}

/**
 * Groups getTextContent items into lines via `hasEOL`, trimming empties. Items
 * are word fragments, so within a line they join with no separator and rely on
 * pdf.js's space items to keep words apart. Marked content (group boundaries)
 * carries no `str` and is filtered out by the caller.
 *
 * Geometry is taken from the first non-blank item of the line. pdf.js sometimes
 * splits one visual line into two `hasEOL` runs at the same baseline; those are
 * re-joined here so the grouping below sees one line.
 */
export function collectLines(items: PdfTextItem[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let text = '';
  let first: PdfTextItem | null = null;
  let width = 0;
  let fontHeight = 0;
  let rotated = false;
  const fonts = new Map<string, number>();

  const flush = () => {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      const transform = first?.transform ?? [];
      const x = transform[4] ?? 0;
      let fontName = '';
      let best = -1;
      for (const [name, count] of fonts) {
        if (count > best) {
          best = count;
          fontName = name;
        }
      }
      lines.push({
        text: trimmed,
        y: transform[5] ?? 0,
        x,
        xEnd: x + width,
        fontHeight,
        fontName,
        rotated,
      });
    }
    text = '';
    first = null;
    width = 0;
    fontHeight = 0;
    rotated = false;
    fonts.clear();
  };

  for (const item of items) {
    const str = item.str ?? '';
    text += str;
    if (str.trim().length > 0) {
      if (first === null) first = item;
      width += item.width ?? 0;
      fontHeight = Math.max(fontHeight, item.height ?? 0);
      if (item.fontName) fonts.set(item.fontName, (fonts.get(item.fontName) ?? 0) + str.length);
      const skew = item.transform?.[1] ?? 0;
      if (item.dir === 'ttb' || Math.abs(skew) > 0.01) rotated = true;
    }
    if (item.hasEOL) flush();
  }
  flush();

  // Re-join a visual line pdf.js split at the same baseline.
  const merged: PdfLine[] = [];
  for (const line of lines) {
    const prev = merged[merged.length - 1];
    const height = Math.max(prev?.fontHeight ?? 0, line.fontHeight);
    if (prev && height > 0 && Math.abs(prev.y - line.y) < height * SAME_LINE_RATIO) {
      prev.text = `${prev.text} ${line.text}`;
      prev.xEnd = Math.max(prev.xEnd, line.xEnd);
      prev.fontHeight = height;
      prev.rotated = prev.rotated || line.rotated;
      continue;
    }
    merged.push({ ...line });
  }
  return merged;
}

/**
 * The document's body font height: the median weighted by characters, so a
 * long body in 11pt is not outvoted by many short 9pt footnotes. Zero for an
 * empty document.
 */
export function medianFontHeight(lines: PdfLine[]): number {
  const sized = lines.filter((line) => line.fontHeight > 0);
  if (sized.length === 0) return 0;
  const sorted = [...sized].sort((a, b) => a.fontHeight - b.fontHeight);
  const total = sorted.reduce((sum, line) => sum + line.text.length, 0);
  let seen = 0;
  for (const line of sorted) {
    seen += line.text.length;
    if (seen * 2 >= total) return line.fontHeight;
  }
  return sorted[sorted.length - 1]!.fontHeight;
}

/**
 * Whether a page's lines arrive in reading order — top to bottom, one baseline
 * after another. Rotated text, or too many lines that move *up* the page, mean
 * the item order is a drawing order pdf.js could not untangle, and grouping by
 * gap would glue unrelated lines together. A single upward jump (the top of a
 * second column) passes: it is a large gap, so it only starts a new paragraph.
 */
export function layoutLooksLinear(lines: PdfLine[]): boolean {
  if (lines.some((line) => line.rotated)) return false;
  if (lines.length < 2) return true;
  let upward = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.y > lines[i - 1]!.y) upward++;
  }
  return upward / (lines.length - 1) <= MAX_UPWARD_JUMP_RATIO;
}

/**
 * Lines → paragraphs and headings, per page. A line continues the open
 * paragraph only when the baseline gap, font size, left edge, and heading
 * parity all agree (design "grouped by geometry"); a sentence end followed by
 * an indented line is a paragraph boundary even when the spacing is tight.
 */
export function groupParagraphs(
  lines: PdfLine[],
  bodyHeight: number,
  headingsEnabled = true,
): PdfParagraph[] {
  const isHeadingSized = (line: PdfLine) =>
    headingsEnabled && bodyHeight > 0 && line.fontHeight >= bodyHeight * HEADING_SIZE_RATIO;

  const groups: PdfLine[][] = [];
  let current: PdfLine[] = [];

  for (const line of lines) {
    const prev = current[current.length - 1];
    if (prev && continues(current, prev, line, isHeadingSized)) {
      current.push(line);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = [line];
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const text = group.reduce((joined, line, index) =>
      index === 0 ? line.text : joinLines(joined, line.text), '');
    const isHeading =
      group.every(isHeadingSized) &&
      group.length <= HEADING_MAX_LINES &&
      text.length <= HEADING_MAX_CHARS;
    return { text, isHeading };
  });
}

function continues(
  group: PdfLine[],
  prev: PdfLine,
  line: PdfLine,
  isHeadingSized: (line: PdfLine) => boolean,
): boolean {
  // A hair of tolerance: baselines come out of a float matrix, and 700 − 680.8
  // is not exactly 19.2.
  const gap = prev.y - line.y;
  if (!(gap > 0 && gap <= prev.fontHeight * MAX_LINE_GAP_RATIO + 1e-6)) return false;
  if (Math.abs(line.fontHeight - prev.fontHeight) > prev.fontHeight * FONT_SIZE_TOLERANCE) {
    return false;
  }
  if (isHeadingSized(prev) !== isHeadingSized(line)) return false;

  const em = line.fontHeight || prev.fontHeight;
  // The paragraph's column edge is its second line's; the first may be indented.
  // Heading-sized lines are exempt: a centred two-line title has a different
  // left edge on each line, and splitting it would make the second half the
  // section's heading.
  if (!isHeadingSized(line)) {
    const edge = group.length >= 2 ? group[1]!.x : prev.x;
    const tolerance = group.length >= 2 ? INDENT_TOLERANCE_EM : FIRST_LINE_INDENT_EM;
    if (Math.abs(line.x - edge) > em * tolerance) return false;
  }

  const indented = line.x - prev.x > em * INDENT_TOLERANCE_EM;
  if (indented && TERMINAL_PUNCT.test(prev.text)) return false;

  return true;
}

/**
 * Joins two printed lines of one paragraph with a space — except across a
 * hyphenated word break, where `Wurtem-` + `berg` is `Wurtemberg`. Only a single
 * trailing hyphen followed by a lowercase letter counts: `--`, an em dash, and
 * `Coca-` + `Cola` keep their punctuation.
 */
export function joinLines(prev: string, next: string): string {
  if (/[^\s-]-$/.test(prev) && /^\p{Ll}/u.test(next)) {
    return `${prev.slice(0, -1)}${next}`;
  }
  return `${prev} ${next}`;
}
