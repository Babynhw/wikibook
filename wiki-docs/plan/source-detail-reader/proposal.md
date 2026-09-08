---
title: Source detail reader — match the wireframe
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [reader, pdf-extraction, source-detail, typography]
---

# Proposal: Source detail reader — match the `source_detail` wireframe

## Problem

The reader route (`/spaces/:spaceId/sources/:id`) does not look like
[`wireframe/source_detail`](../../wireframe/source_detail/screen.png). Most of
the gap is not styling:

- **PDF blocks are physical lines.** `extract-pdf.ts` groups pdf.js text items
  only by `hasEOL`, so every printed line becomes one `SourceBlock`. The reader
  draws a `<p>` per block, and a paragraph reads as a stack of short lines with
  a gap after each. Headings are indistinguishable from body text — nothing in
  the extraction records that a line *is* a heading.
- **The reading surface is UI typography.** Inter 16px, left-aligned, in the
  same voice as the chrome around it; the wireframe reads as a document: a serif
  18px column, centred, with a large heading.
- **Header and toolbar drift.** A "Back to the space" link that duplicates the
  breadcrumb, no rule under the header, a small title, a type chip without an
  icon, four actions spread across the row where the wireframe shows
  `Edit details · Download · ⋮`, and a "Go" button the pager does not need.

## Goal

A PDF source reads as paragraphs under headings; the reader column looks like
the wireframe's paper; the header and toolbar carry the wireframe's hierarchy —
without adding anything PRD §8 does not ask for (no zoom, no annotation), and
without a schema migration.

```
pdf.js text items ──collectLines──▶ lines (y, x, font height)
                  ──groupParagraphs──▶ paragraphs + heading blocks
                  ──persistReady──▶ SourceBlock rows (heading === text marks a heading)
reader ──▶ <h2> for heading blocks, serif <p> for the rest
```

## Scope

1. **Paragraph-level PDF extraction** with size-based heading detection and a
   line-order sanity check that falls back to today's per-line behaviour.
2. **Citation rematch survives the reflow** — whitespace-insensitive matching
   in `rematchCitations`, so quotes spanning a former line break do not go
   `stale` when a source is reprocessed.
3. **A one-off reprocess script** for sources that are already `ready`; there is
   no API route for it and PRD §8 does not want one.
4. **Reader typography and layout**: a `--font-serif` (Lora) token, heading
   blocks rendered as headings, a centred reading column.
5. **Header and toolbar** aligned to the wireframe: `← Library / <space>`
   breadcrumb, `border-b` header, `Edit details · Download · ⋮` with Archive and
   Delete in the overflow menu, pager without "Go".

## Out of scope

The mock's top nav, its Citations / Saved Notes / Drafts / Help / Trash rail
items, workspace search, "Folio" branding, and the zoom toolbar — see
[[../../wireframe/index]] "Not in scope". Web and manual extraction are
unchanged.
