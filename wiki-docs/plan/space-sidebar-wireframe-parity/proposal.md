---
title: Space sidebar wireframe parity — the rail's density, type, and Add Source
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, ui, sidebar, wireframe, design-tokens]
---

# Proposal: make the space rail look like the `source_library` wireframe

## Problem

[[../space-sidebar/proposal]] built the rail's *structure* correctly — identity,
nav, a ruled-off footer, 280px, below the 4rem header, the current area filled
in `primary-container` — and then rendered it with shadcn's compact defaults.
Against `wireframe/source_library/code.html` lines 223–271 the gap is density
and typography, plus one missing control:

| # | Wireframe | Was | Where |
|---|---|---|---|
| 1 | Nav row `px-4 py-3 gap-3 rounded-lg` (~48px) | `SidebarMenuButton` `default` = `h-8 p-2 gap-2 rounded-md` (32px) | `ui/sidebar.tsx` variants; `space-shell.tsx` passed no `size` |
| 2 | Labels in JetBrains Mono (`label-md`) — nav, space name, Add Source | `text-sm` Inter | same |
| 3 | 24px icons | lucide `size-4` (16px) | `[&_svg]:size-4` in the variant |
| 4 | **"+ Add Source"** outlined, full-width, under the identity | Absent from the rail; only on the library page | `routes/space-page.tsx` |
| 5 | Header `px-6`, `rounded-xl` icon box in `text-primary`, `font-black` name | `p-4`, `rounded-lg`, `text-on-primary-container`, `font-semibold` | `space-shell.tsx` |
| 6 | `nav px-2 space-y-1`, footer `px-2 pt-4` with shorter rows | group `p-2` + menu `gap-1`, footer rows same height as nav | same |

Not a gap: the rail collapses to a 3rem icon strip and the wireframe has no
collapsed state. That was decided in [[../space-sidebar/design]] and stays.
Also not a gap: the header chrome above the rail (Folio, Workspace/Notebook
tabs, workspace search, bell, gear, avatar) — [[../../wireframe/index]] lists
most of it as out of MVP scope.

## Goal

The rail reads as the wireframe's rail at a glance — row height, mono labels,
icon weight, the outlined Add Source under the space's name — without editing
`ui/sidebar.tsx` beyond the two hand-patches it already carries, and without a
single literal colour.

## Decisions (confirmed with the operator 2026-08-27)

- **Add Source moves into the rail and the library page keeps its own.** One
  dialog component, two openers. The rail's works from the assistant, the
  notes, and the reader — the cases where going back to the library first was
  the friction.
- **Keep `collapsible="icon"`.** The collapsed strip is made to look right with
  the larger rows rather than removed to match a wireframe that never drew it.

## Non-goals

Citations, Drafts, Help, Trash (§20 / no §2 counterpart); the header chrome;
a collapsed-state Add Source icon (nothing to copy, and the expand control is
one click away).

## Cross-references

[[design]] · [[tasks]] · [[../space-sidebar/proposal]] ·
[[../../wireframe/index]] · [[../../specs/spaces/spec]] REQ-237
