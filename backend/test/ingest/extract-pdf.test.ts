import { describe, expect, it } from 'vitest';
import {
  HEADING_MAX_CHARS,
  MAX_LINE_GAP_RATIO,
  collectLines,
  extractPdf,
  groupParagraphs,
  joinLines,
  layoutLooksLinear,
  medianFontHeight,
  type PdfLine,
} from '../../src/ingest/extract-pdf.js';
import { UnretryableIngestError } from '../../src/ingest/errors.js';
import { buildMinimalPdf } from '../../scripts/pdf-fixture-builder.js';

const TEXT_PAGE_ONE = 'BT /F1 24 Tf 72 720 Td (Sleep consolidates memory) Tj ET';
const TEXT_PAGE_TWO = 'BT /F1 24 Tf 72 720 Td (During slow wave rest) Tj ET';

/** One positioned line of Helvetica: `size` pt at (`x`, `y`). */
const line = (size: number, x: number, y: number, text: string) =>
  `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`;

/** A body-sized article: a 24pt title, a two-line paragraph, and a second paragraph. */
const ARTICLE_PAGE = [
  line(24, 72, 720, 'Sleep and Memory'),
  line(12, 72, 690, 'Sleep consolidates memory by replaying'),
  line(12, 72, 676, 'the day traces during slow waves.'),
  line(12, 72, 640, 'A second paragraph begins here.'),
].join('\n');

describe('extractPdf', () => {
  it('extracts known text with structural page numbers', async () => {
    const pdf = buildMinimalPdf([TEXT_PAGE_ONE, TEXT_PAGE_TWO]);
    const result = await extractPdf(pdf, { maxPages: 200 });

    expect(result.text).toContain('Sleep consolidates memory');
    expect(result.text).toContain('During slow wave rest');
    // Page numbers are structural — each line knows its page, never guessed
    // from counting form feeds (PRD §6).
    const pageTwoBlocks = result.blocks.filter((block) => block.page === 2);
    expect(pageTwoBlocks.map((block) => block.text)).toEqual(['During slow wave rest']);
    // Two lines in the whole document: nothing to compare against, so nothing
    // is a heading.
    expect(result.blocks.every((block) => block.heading === undefined)).toBe(true);
  });

  it('groups printed lines into paragraphs and lifts a larger line into a heading block', async () => {
    const result = await extractPdf(buildMinimalPdf([ARTICLE_PAGE]), { maxPages: 200 });

    expect(result.blocks).toEqual([
      { text: 'Sleep and Memory', page: 1, heading: 'Sleep and Memory' },
      {
        text: 'Sleep consolidates memory by replaying the day traces during slow waves.',
        page: 1,
        heading: 'Sleep and Memory',
      },
      { text: 'A second paragraph begins here.', page: 1, heading: 'Sleep and Memory' },
    ]);
    // The full text is the blocks, one per line — the shape search indexes.
    expect(result.text).toBe(result.blocks.map((block) => block.text).join('\n'));
  });

  it('carries the nearest heading onto the next page without merging paragraphs across it', async () => {
    const pageTwo = [
      line(12, 72, 720, 'The story continues on the next page,'),
      line(12, 72, 706, 'still under the same heading.'),
    ].join('\n');
    const result = await extractPdf(buildMinimalPdf([ARTICLE_PAGE, pageTwo]), { maxPages: 200 });

    const pageTwoBlocks = result.blocks.filter((block) => block.page === 2);
    expect(pageTwoBlocks).toEqual([
      {
        text: 'The story continues on the next page, still under the same heading.',
        page: 2,
        heading: 'Sleep and Memory',
      },
    ]);
    // REQ-128: a block lies on one page, so the last page-1 paragraph and the
    // first page-2 paragraph stay separate even though they read as one.
    expect(result.blocks.filter((block) => block.page === 1)).toHaveLength(3);
  });

  it('closes a hyphenated line break', async () => {
    const page = [
      line(12, 72, 720, 'Albert Einstein was born in Ulm, in Wurtem-'),
      line(12, 72, 706, 'berg, and the family soon moved to Munich.'),
      line(12, 72, 692, 'Nothing there left a memory.'),
    ].join('\n');
    const result = await extractPdf(buildMinimalPdf([page]), { maxPages: 200 });

    expect(result.blocks.map((block) => block.text)).toEqual([
      'Albert Einstein was born in Ulm, in Wurtemberg, and the family soon moved to Munich. Nothing there left a memory.',
    ]);
  });

  it('falls back to one block per line when a page does not read top to bottom', async () => {
    // Drawn bottom-up: the item order is not reading order, so grouping by gap
    // would be guesswork. Every line stays its own block and nothing is a heading.
    const page = [
      line(12, 72, 640, 'A second paragraph begins here.'),
      line(12, 72, 676, 'the day traces during slow waves.'),
      line(12, 72, 690, 'Sleep consolidates memory by replaying'),
      line(24, 72, 720, 'Sleep and Memory'),
    ].join('\n');
    const result = await extractPdf(buildMinimalPdf([page]), { maxPages: 200 });

    expect(result.blocks.map((block) => block.text)).toEqual([
      'A second paragraph begins here.',
      'the day traces during slow waves.',
      'Sleep consolidates memory by replaying',
      'Sleep and Memory',
    ]);
    expect(result.blocks.every((block) => block.heading === undefined)).toBe(true);
  });

  it('rejects a password-protected PDF with a plain-language message', async () => {
    const pdf = buildMinimalPdf([TEXT_PAGE_ONE], {
      encrypt: '<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abc) /U (0123456789abcdef0123456789abc) /P -44 >>',
    });
    const error = await extractPdf(pdf, { maxPages: 200 }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
    expect((error as UnretryableIngestError).userMessage).toBe('This PDF is password protected.');
  });

  it('rejects a PDF over the page limit with the limit message', async () => {
    const pdf = buildMinimalPdf([TEXT_PAGE_ONE, TEXT_PAGE_TWO]);
    const error = await extractPdf(pdf, { maxPages: 1 }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
    expect((error as UnretryableIngestError).userMessage).toMatch(/2 pages, over the 1-page limit/);
  });

  it('rejects a PDF with no selectable text layer', async () => {
    // A content stream that draws nothing: no text to extract, ever.
    const pdf = buildMinimalPdf(['q Q']);
    const error = await extractPdf(pdf, { maxPages: 200 }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
    expect((error as UnretryableIngestError).userMessage).toBe(
      'This PDF has no selectable text — scanned documents are not supported.',
    );
  });

  it('rejects a corrupt file as unreadable', async () => {
    const buffer = Buffer.from('%PDF-1.4\n----- not really a pdf -----\n%%EOF');
    const error = await extractPdf(buffer, { maxPages: 200 }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
    expect((error as UnretryableIngestError).userMessage).toBe('This file could not be read as a PDF.');
  });
});

const pdfLine = (overrides: Partial<PdfLine> & { y: number }): PdfLine => ({
  text: 'Body text of a paragraph line.',
  x: 72,
  xEnd: 400,
  fontHeight: 12,
  fontName: 'F1',
  rotated: false,
  ...overrides,
});

describe('groupParagraphs', () => {
  it('splits at the gap threshold, not below it', () => {
    const tight = groupParagraphs(
      [pdfLine({ y: 700 }), pdfLine({ y: 700 - 12 * MAX_LINE_GAP_RATIO })],
      12,
    );
    expect(tight).toHaveLength(1);

    const loose = groupParagraphs(
      [pdfLine({ y: 700 }), pdfLine({ y: 700 - 12 * MAX_LINE_GAP_RATIO - 0.5 })],
      12,
    );
    expect(loose).toHaveLength(2);
  });

  it('never merges a heading-sized line with body text', () => {
    // 1.10× the body is still body (and within the 12 % size tolerance); 1.16×
    // is a heading. Only the latter splits.
    const nearly = groupParagraphs(
      [pdfLine({ y: 700, fontHeight: 12 * 1.1, text: 'Big-ish line' }), pdfLine({ y: 686 })],
      12,
    );
    expect(nearly).toHaveLength(1);
    expect(nearly[0]!.isHeading).toBe(false);

    const heading = groupParagraphs(
      [pdfLine({ y: 700, fontHeight: 12 * 1.16, text: 'A heading' }), pdfLine({ y: 686 })],
      12,
    );
    expect(heading.map((paragraph) => paragraph.isHeading)).toEqual([true, false]);
  });

  it('treats a sentence end followed by an indented line as a paragraph boundary', () => {
    const paragraphs = groupParagraphs(
      [
        pdfLine({ y: 700, text: 'The first paragraph ends here.' }),
        pdfLine({ y: 686, x: 72 + 24, text: 'The second starts indented.' }),
      ],
      12,
    );
    expect(paragraphs).toHaveLength(2);

    // No sentence end: the same indent is just an odd left edge.
    const continued = groupParagraphs(
      [
        pdfLine({ y: 700, text: 'The first paragraph continues' }),
        pdfLine({ y: 686, x: 72 + 8, text: 'onto this line.' }),
      ],
      12,
    );
    expect(continued).toHaveLength(1);
  });

  it('accepts an indented first line and holds later lines to the column edge', () => {
    const paragraphs = groupParagraphs(
      [
        pdfLine({ y: 700, x: 96, text: 'An indented opening line that runs on' }),
        pdfLine({ y: 686, x: 72, text: 'and settles at the margin,' }),
        pdfLine({ y: 672, x: 72, text: 'where it stays.' }),
        pdfLine({ y: 658, x: 120, text: 'A pulled quote sits elsewhere.' }),
      ],
      12,
    );
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'An indented opening line that runs on and settles at the margin, where it stays.',
      'A pulled quote sits elsewhere.',
    ]);
  });

  it('keeps a centred two-line title as one heading block', () => {
    const paragraphs = groupParagraphs(
      [
        pdfLine({ y: 700, x: 120, fontHeight: 24, text: 'Sleep, Memory, and the' }),
        pdfLine({ y: 672, x: 150, fontHeight: 24, text: 'Consolidating Night' }),
        pdfLine({ y: 640, x: 72, text: 'Body starts here.' }),
      ],
      12,
    );
    expect(paragraphs.map((paragraph) => [paragraph.text, paragraph.isHeading])).toEqual([
      ['Sleep, Memory, and the Consolidating Night', true],
      ['Body starts here.', false],
    ]);
  });

  it('does not merge an over-long large-type line with the body under it', () => {
    const paragraphs = groupParagraphs(
      [
        pdfLine({ y: 700, fontHeight: 18, text: 'x'.repeat(HEADING_MAX_CHARS + 1) }),
        pdfLine({ y: 686 }),
      ],
      12,
    );
    // Too long to be a heading, but still heading-sized: it stays apart from the body.
    expect(paragraphs.map((paragraph) => paragraph.isHeading)).toEqual([false, false]);
  });

  it('does not call a long or tall large-type block a heading', () => {
    const tall = groupParagraphs(
      [
        pdfLine({ y: 700, fontHeight: 18, text: 'Line one of a big intro' }),
        pdfLine({ y: 678, fontHeight: 18, text: 'line two of a big intro' }),
        pdfLine({ y: 656, fontHeight: 18, text: 'line three of a big intro' }),
      ],
      12,
    );
    expect(tall).toHaveLength(1);
    expect(tall[0]!.isHeading).toBe(false);
  });

  it('marks nothing as a heading when detection is disabled', () => {
    const paragraphs = groupParagraphs([pdfLine({ y: 700, fontHeight: 24 })], 12, false);
    expect(paragraphs[0]!.isHeading).toBe(false);
  });
});

describe('joinLines', () => {
  it('drops a soft hyphen before a lowercase continuation and keeps every other join', () => {
    expect(joinLines('in Wurtem-', 'berg, Germany')).toBe('in Wurtemberg, Germany');
    expect(joinLines('drinks Coca-', 'Cola daily')).toBe('drinks Coca- Cola daily');
    expect(joinLines('a dash --', 'then more')).toBe('a dash -- then more');
    expect(joinLines('plain line', 'next line')).toBe('plain line next line');
  });
});

describe('collectLines / medianFontHeight / layoutLooksLinear', () => {
  it('re-joins a visual line pdf.js split at the same baseline', () => {
    const lines = collectLines([
      { str: 'Sleep and', hasEOL: true, transform: [12, 0, 0, 12, 72, 700], width: 60, height: 12 },
      { str: 'Memory', hasEOL: true, transform: [12, 0, 0, 12, 140, 700.2], width: 40, height: 12 },
      { str: 'Body', hasEOL: true, transform: [12, 0, 0, 12, 72, 686], width: 30, height: 12 },
    ]);
    expect(lines.map((line) => line.text)).toEqual(['Sleep and Memory', 'Body']);
    expect(lines[0]!.xEnd).toBe(180);
  });

  it('takes a line’s geometry from its first non-blank item', () => {
    const lines = collectLines([
      { str: ' ', hasEOL: false, transform: [12, 0, 0, 12, 20, 700], width: 4, height: 0 },
      { str: 'Indented', hasEOL: true, transform: [12, 0, 0, 12, 96, 700], width: 50, height: 12 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.x).toBe(96);
    expect(lines[0]!.text).toBe('Indented');
  });

  it('weights the median by characters so footnotes do not outvote the body', () => {
    expect(
      medianFontHeight([
        pdfLine({ y: 700, fontHeight: 11, text: 'x'.repeat(200) }),
        pdfLine({ y: 690, fontHeight: 8, text: 'note' }),
        pdfLine({ y: 680, fontHeight: 8, text: 'note' }),
        pdfLine({ y: 670, fontHeight: 8, text: 'note' }),
      ]),
    ).toBe(11);
  });

  it('accepts one upward jump (a second column) but not a scrambled page', () => {
    const twoColumns = [
      pdfLine({ y: 700 }),
      pdfLine({ y: 686 }),
      pdfLine({ y: 672 }),
      pdfLine({ y: 700, x: 320 }),
      pdfLine({ y: 686, x: 320 }),
      pdfLine({ y: 672, x: 320 }),
    ];
    expect(layoutLooksLinear(twoColumns)).toBe(true);
    expect(layoutLooksLinear([...twoColumns].reverse())).toBe(false);
    expect(layoutLooksLinear([pdfLine({ y: 700, rotated: true })])).toBe(false);
  });
});
