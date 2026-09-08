---
title: Assistant pane reader header — Tasks
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, ui, reader, assistant, tasks]
---

# Tasks: assistant pane reader header

## Backend

None.

## Frontend

### F1 — `reader-header.tsx`

- [x] `variant` prop; compact implies `hideActions`
- [x] Compact row: icon + `sr-only` type, truncated mono title with `title=`,
      truncated metadata sub-line with `title=`
- [x] Original link as `icon-sm` ghost with `aria-label` (Open original / Download)
- [x] No `border-b` / `pb-6` in compact; full variant unchanged

### F2 — `assistant-page.tsx`

- [x] `variant="compact"`, wrapper `items-center`, comment updated

### F3 — Tests

- [x] Compact cases (pdf + web) in `source-reader.test.tsx`; full `hideActions` kept
- [x] **Gate: `pnpm test`, `pnpm lint`, `pnpm build` clean**

### F4 — Wiki

- [x] This folder `status: done`
- [x] [[../../specs/library-reader/spec]] REQ-236 amended + test list
- [x] [[../../wireframe/index]] knowledge_assistant row
- [x] [[../../index]] plan row; [[../../log]] entry

## Implementation notes

**Verified in jsdom and the compiled stylesheet, not in a browser.** The Chrome
extension was not connected in the implementing session — the same gap every
plan since [[../space-sidebar/tasks]] has recorded. What jsdom cannot answer:
that the row lands near the wireframe's 64px, that the title actually
ellipsises inside the pane's `min-w-0` chain, and how the ghost icon link sits
beside the text Close button. `pnpm test` 173 (was 171, +2), `pnpm lint`
(`tsc -b`) and `pnpm build` clean. The project has no prettier; formatting was
kept by hand.

Built as designed with one refactor the design did not name: the original link,
the archived notice and the three dialogs were lifted into local fragments
(`originalLink`, `archivedNotice`, `dialogs`) so the two variants render them
from one definition — the `full` markup is otherwise as it was.

**Follow-up, same day.** The operator reported the pane scrolling horizontally
after the change. Not reproducible without a browser; fixed on both plausible
fronts at once: reader blocks (`block.tsx`) get `wrap-anywhere` so a bare URL or
unspaced run wraps instead of widening the column, the pane's scroller gets
`overflow-x-hidden` (`overflow-y-auto` alone had been computing `overflow-x` to
`auto`), and the compact header's truncate chain gets an explicit `min-w-0`.
Suite unchanged at 173; lint and build clean.
