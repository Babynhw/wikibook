---
title: Assistant pane reader header — a compact header for the reader beside an answer
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, ui, reader, assistant, wireframe]
---

# Proposal: give the assistant's reader pane the wireframe's one-row header

## Problem

Clicking a citation on the assistant route opens the source reader in a pane
beside the thread ([[../phase-4-assistant/proposal]]). That pane mounts the
full-page `ReaderHeader` — built for the `source_detail` wireframe by
[[../source-detail-reader/proposal]] — with only `hideActions`. Measured on a
1080px-tall viewport (2026-08-27): the header takes **~350px of an ~840px
pane**, so ~10 lines of the cited passage are visible. The pane exists to read
the passage the user just clicked.

| # | What | Where | Cost |
|---|---|---|---|
| 1 | Title at `text-4xl sm:text-5xl` | `reader-header.tsx` | ~60px |
| 2 | Chip, author, date + host, then a button row, stacked | same | ~130px |
| 3 | Header `pb-6` under the pane wrapper's `py-3` | header + `assistant-page.tsx` | ~36px |
| 4 | Header `border-b` **and** wrapper `border-b` — a double rule | same | visible defect |
| 5 | `vi.wikipedia.org` repeats the "Open original" link | header | noise |

The `knowledge_assistant` wireframe (`code.html` 281–296) draws the pane header
as one `h-16` row: type icon · bold mono title, truncated · `author • publisher`
sub-line, truncated · an "Open Source" button on the right.

## Goal

The pane's header reads as that row: one line of title, one line of metadata,
the original-link as an icon, no second rule — and the highlighted passage is on
screen when the pane opens. The full reader route is untouched (REQ-236).

## Decisions (confirmed with the operator 2026-08-27)

- **Every REQ-141 field stays in the pane.** The sub-line is
  `author · host-or-pages · Added <date>`, truncated with an ellipsis and
  recoverable on hover; the type is the icon with a screen-reader label. No spec
  change to REQ-141.
- **A `variant` prop, not a second component.** `TYPE_ICON`, `hostOf`, the web
  link and the proxied PDF link (PRD §17) stay in one file.
- **The host owns the rule.** Compact renders no border; the pane wrapper's
  `border-b` is the one line.

## Non-goals

The reader's body typography in the pane (Lora 18/32, REQ-236); the wireframe's
"other relevant excerpts"; a shrink-on-scroll header; a Details popover.

## Cross-references

[[design]] · [[tasks]] · [[../source-detail-reader/proposal]] ·
[[../../wireframe/index]] · [[../../specs/library-reader/spec]] REQ-141, REQ-236
