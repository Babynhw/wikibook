---
title: Assistant pane reader header — Design
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, ui, reader, assistant, design]
---

# Design: `ReaderHeader variant="compact"`

## The prop

`variant?: 'full' | 'compact'`, default `'full'`. Compact implies `hideActions`:
Edit details, Archive and Delete never render — the pane is where a source is
read, not managed. The `full` output is unchanged.

## Compact layout

```
[icon] Title, bold mono, truncate…                         [↗]  Close
       author · vi.wikipedia.org · Added 8/15/2026 (truncate)
```

| Wireframe (`knowledge_assistant/code.html` 282–295) | Chosen | Why |
|---|---|---|
| `material-symbols description` in `text-primary` | `TYPE_ICON[type]`, `size-5 text-primary`, plus `sr-only` type label | Type stays announced (REQ-141) without a chip row |
| `h3 text-label-md font-bold truncate` | `h1 truncate font-mono text-base font-bold`, `title=` full text | `label-md` is JetBrains Mono per DESIGN.md; `h1` keeps the pane's heading level |
| `p text-label-sm text-on-surface-variant truncate` | `p truncate text-xs text-on-surface-variant`, `title=` full text | One line carries author, host or page count, date, Archived |
| "Open Source" outlined button | `buttonVariants({variant:'ghost', size:'icon-sm'})` link, `aria-label` = the full variant's visible text | One 32px control; same accessible name as before so REQ-236's queries hold |
| `h-16` row, `border-b` on the panel | No border on the header; wrapper keeps `border-b px-4 py-3`, now `items-center` | One rule, one owner |

Close stays in `assistant-page.tsx` (it owns `setPane`), `ghost sm`, beside the
icon link in one right-hand cluster.

The archived `Alert` and its Restore button render in both variants: they are
state, not chrome, and they already sit below the row.

## Tests

`source-reader.test.tsx`: the `hideActions` case becomes a compact case — PDF
shows the `Download` link, no Edit / More actions, the sub-line carries author,
`Added`, page count, the type label is in the document; a web source shows
`Open original` and its host. A full-variant `hideActions` assertion stays.
