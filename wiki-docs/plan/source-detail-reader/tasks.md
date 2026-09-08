---
title: Source detail reader — Tasks
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [reader, pdf-extraction, tasks]
---

# Tasks: Source detail reader

Backend first: the block shape is what the reader renders against. No schema
task ([[design]] "No migration").

## Backend (`backend/`)

### T1 — Paragraph and heading extraction (PRD §6, §8)

- [x] `extract-pdf.ts`: `collectLines` / `medianFontHeight` /
      `layoutLooksLinear` / `groupParagraphs` / `joinLines`, thresholds as
      named constants ([[design]] "grouped by geometry")
- [x] Heading blocks emitted with `heading === text`; body blocks carry the
      nearest preceding heading across pages; no paragraph spans a page
      (REQ-128)
- [x] Non-linear page falls back to per-line blocks ([[design]] "Fallback")
- [x] `LocatedBlock.heading` JSDoc documents the convention
- [x] Tests: heading + merged paragraph + gap split; hyphen join; two pages;
      bottom-to-top fallback; threshold edges on `groupParagraphs` /
      `joinLines`; existing extract-pdf tests unchanged

### T2 — Citation rematch survives reflow (PRD §8)

- [x] `rematchCitations` matches whitespace-normalised text
- [x] Test: a quote spanning a former line break stays matched

### T3 — Reprocess script

- [x] `scripts/reprocess-sources.ts` — `<sourceId>` | `--all [--type ...]
      [--dry-run]`; atomic `ready → processing` guard, `queue.remove` then
      `queue.add` with `ingestJobOptions`; `markSourceFailed` on enqueue error
- [x] `package.json` `reprocess:sources`

## Frontend (`frontend/`)

### T4 — Reading typography

- [x] `@fontsource-variable/lora`, `--font-serif` in `src/index.css`,
      `DESIGN.md` §Typography paragraph
- [x] `Block`: heading blocks as `<h2>`, body as serif `<p>`; cited markers
      unchanged (REQ-137)
- [x] Reading column centred `max-w-2xl`, paper padding per wireframe

### T5 — Header, breadcrumb, toolbar

- [x] Breadcrumb `← Library / <space>`; "Back to the space" removed; "Back to
      the answer" kept for `?from=` (PRD §8)
- [x] Header `border-b`, larger title, type chip with icon
- [x] Actions `Edit details · Download|Open original · ⋮` with Archive/Delete
      in a shadcn `dropdown-menu`; `readOnly` / `hideActions` semantics kept
- [x] Pager: "Go" removed, Enter still submits and clamps
- [x] Tests updated: heading block renders as `h2`; Archive/Delete via the
      menu; Enter navigates; no "Back to the space"

## Wiki

- [x] `wireframe/index.md` lists `source_detail`
- [x] `specs/library-reader/spec.md` updated from verified behaviour;
      `log.md` entry; this folder `status: done`

## Implementation notes (2026-08-27)

- **Gap ratio corrected on contact.** Designed at 1.6 line heights; the one real
  PDF in dev (a browser print-to-PDF) has leading 15.5pt on 9.5pt = 1.63, and
  the first reprocess left every line its own block. Raised to 1.9 — paragraph
  breaks in that file start at 2.16. The unit fixtures (14pt on 12pt) could not
  have caught it; the design table now carries the measured numbers.
- **Heading detection is size-only.** Same-size bold section labels ("1- Thời
  niên thiếu.") stay paragraphs — `TextContent.styles` exposes no weight.
- **Script exit.** `queue.close()` + `$disconnect()` left the process alive on
  an ioredis keep-alive; the script calls `process.exit` after cleanup.
- **Not looked at in a browser.** Chrome extension unavailable; typography and
  layout verified in jsdom and the compiled stylesheet only.
- **Review pass (same day).** A `finally { process.exit(0) }` in the script
  would have reported success on a thrown error — now caught and exit 1.
  `aria-label` on the Download / Open-original links had been set to the *old*
  label to keep a test green, which breaks WCAG 2.5.3 (label in name); the
  visible text is the name now and the test follows the UI. Heading-sized lines
  are exempt from the column-edge check so a centred two-line title stays one
  heading block. `rematchCitations` normalises rows once, not per citation.

