---
title: Source detail reader — Design
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [reader, pdf-extraction, design, typography]
---

# Design: Source detail reader

**No migration.** `SourceBlock.heading` (REQ-127, "nearest preceding heading")
already exists; a heading block is marked by the convention
`block.heading === block.text`. No API route changes.

## API surface

None. `GET /sources/:id/blocks` and `/outline` answer the same shapes with
better data: PDF blocks are paragraphs, and heading blocks appear in the outline
as the first ord of their run.

## Decisions

### PDF paragraphs are grouped by geometry, not by `hasEOL` alone (decided 2026-08-27)

pdf.js `TextItem` carries `transform` (x = `[4]`, y = `[5]`), `height` (font
size in user space), `width`, `dir`, `fontName`. `collectLines` keeps the
`hasEOL` grouping and records that geometry per line; items whose `|Δy|` is
under half a line height belong to the same visual line and are re-joined.

`groupParagraphs` continues a paragraph only when every check holds:

| Check | Threshold |
|---|---|
| vertical gap `prev.y − line.y` | `0 < gap ≤ prev.fontHeight × 1.9` (`MAX_LINE_GAP_RATIO`; body leading runs 1.2–1.7, a browser print-to-PDF sits at 1.63, paragraph breaks start around 2.1) |
| font size | within 12 % of the previous line (`FONT_SIZE_TOLERANCE`) |
| left edge | within 1 em of the paragraph's second line; a first line may be indented (`INDENT_TOLERANCE_EM`) |
| sentence end + indent | previous line ends `[.!?]` and the next is indented → new paragraph |
| heading parity | a heading-sized line never merges with a body-sized one |

A finished group is a **heading** when every line is `≥ 1.15 ×` the document's
character-weighted median font height, the text is `≤ 120` chars, and it spans
`≤ 2` lines. Detection is off for documents under 3 lines (the median is the
line itself). No bold heuristic: `TextContent.styles` only exposes a generic
family.

Lines join with one space; a line ending in a single `-` followed by a
lowercase letter drops the hyphen (`Wurtem-` / `berg` → `Wurtemberg`).

### Fallback: a page whose reading order is not linear keeps per-line blocks (decided 2026-08-27)

`layoutLooksLinear` fails a page with rotated text (`dir === 'ttb'` or a
non-zero skew) or where more than 20 % of consecutive lines move *up* the page
— scrambled columns or overlays. That page emits one block per line with no
heading, which is exactly today's behaviour. A single upward jump (the top of a
second column) passes and simply starts a new paragraph.

### A heading is a block whose `heading` is its own text (decided 2026-08-27)

Alternatives were a `kind` column (migration + backfill for one consumer) or
dropping heading blocks as web extraction does (then the reader cannot draw
them). The convention costs nothing and improves the outline: the run for
heading *H* now starts at the heading block itself, so REQ-131's navigation
target is the heading, not its first paragraph. `chunk.ts` picks the first
block's `heading` as `sectionHeading`, so passages under a heading name it and
the heading line rides along in the passage text. Web extraction is left as is;
aligning it is a later, optional change.

### Reprocessing is a maintenance script, not a route (decided 2026-08-27)

Already-ingested PDFs keep their line blocks until reprocessed, and
`runSourceIngestion` refuses a `ready` source. `scripts/reprocess-sources.ts`
resets `state` to `processing` with the same atomic `updateMany` guard the retry
route uses, clears the settled job, and enqueues with `ingestJobOptions`.
`persistReady` then rewrites blocks and passages in one transaction (REQ-129).
PRD §8 does not ask users to re-extract, so no route and no button.

### `rematchCitations` compares whitespace-normalised text (decided 2026-08-27)

Old passages joined lines with `\n`; new ones with a space. An exact
`includes` would mark every quote spanning a former line break `stale` on the
very reprocess that motivates this change. Both sides are collapsed with
`/\s+/g → ' '` before matching; citations point at `passageId`, so shifting
block ordinals do not matter.

### Reading typography gets its own token (decided 2026-08-27)

`--font-serif` (Lora Variable, self-hosted via `@fontsource-variable/lora` like
the other two faces) is the long-form *reading* face, used only for extracted
source text inside the reader. UI copy stays Inter; metadata stays JetBrains
Mono. Recorded in `frontend/DESIGN.md` §Typography.

### Archive and Delete move to an overflow menu (decided 2026-08-27)

The wireframe's header is `Edit details · Download · ⋮`. Archive and Delete are
rarer and one of them is destructive; they live in the `⋮` menu (shadcn
`dropdown-menu`, committed as generated). `readOnly` still hides Edit and
Archive; `hideActions` hides the menu entirely, as before.
