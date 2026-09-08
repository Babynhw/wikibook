---
title: Space sidebar wireframe parity — Design
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, ui, sidebar, wireframe, design-tokens, design]
---

# Design: rail density, type, and Add Source

Everything lands in `frontend/src/components/space-shell.tsx`. The generated
`ui/sidebar.tsx` is not touched; its variants are overridden at the call site
through `size` and `className`, which `tailwind-merge` resolves in the caller's
favour.

## Nav rows

One `ITEM` class string on every `SidebarMenuButton`, plus `size="lg"`:

| Wireframe | Chosen | Why |
|---|---|---|
| `py-3` → ~48px row | `size="lg"` (`h-12`) | The only generated size at the wireframe's height; `default` is 32px |
| `px-4 gap-3 rounded-lg` | same, literally | Overrides the variant's `p-2 gap-2 rounded-md` |
| `text-label-md font-label-md` | `font-mono text-sm` | `label-md` is JetBrains Mono per `DESIGN.md`; `text-sm` is the closest existing size |
| 24px Material icon | `[&_svg]:size-5` | lucide's strokes are lighter; 20px reads at the same weight 24px Material does |
| idle `text-on-surface-variant` | same | The variant inherits `text-sidebar-foreground`, which is the same token via the bridge — stated explicitly so the row does not depend on the bridge |
| active `bg-primary-container text-on-primary-container` | `data-active:` pair | Unchanged from [[../space-sidebar/design]] |

**Collapsed strip.** The variant forces `group-data-[collapsible=icon]:size-8!`
— a 20px icon in a 32px square is 6px of margin, tighter than the expanded row.
`size-10!` restores the expanded row's proportion inside the 3rem rail;
`justify-center p-0!` keep the icon centred. `tailwind-merge` treats both `!`
declarations as the same group, so the caller's wins.

## Header

`px-6 pt-4 pb-6 gap-6` (wireframe `px-6 pb-6 pt-2`, `mb-6` between identity
and button; `pt-4` because the rail already sits under a 4rem header and the
wireframe's `pt-2` was under a `py-4` aside). Icon box `rounded-xl
bg-primary-container text-primary`; name `font-mono text-sm font-black
text-on-surface`; objective `text-sm text-on-surface-variant`. Collapsed:
`p-2`, identity hidden, trigger centred — unchanged.

## Add Source

`Button variant="secondary"` is already the wireframe's button
(`border-outline-variant bg-surface-container-lowest`), so no new variant.
`w-full justify-center gap-2 font-mono`, a `Plus` icon, label **Add source** —
the codebase's casing, not the wireframe's.

Three rules the wireframe does not state:

1. **Rendered only when `space && space.archivedAt == null`.** Adding answers
   409 on an archived space and REQ-076 already hides the library page's button
   there; the rail follows. Before the space has loaded the rail cannot know, so
   it withholds the button rather than offer an action that may fail — and
   holds the row with a `Skeleton`, as the identity does, so the nav rows do
   not shift when the space arrives.
2. **Hidden while collapsed** (`group-data-[collapsible=icon]:hidden`). No room
   for a labelled button in 3rem, and nothing in the wireframe to copy.
3. **The rail owns its own `AddSourceDialog` instance** (`adding` state in
   `SpaceRail`). The dialog closes itself on success and its mutations
   invalidate the source list, so a source added from the assistant route is in
   the library when the user gets there. The library page keeps its own button
   and instance — two identical accessible names on one page, which is why
   `space-page.test.tsx` now asks `within(main)`.

## Footer

`px-2 py-4` over `border-t border-sidebar-border`; the one row takes `ITEM`
with `h-10` — a step shorter than the nav, the way the wireframe's `py-2`
footer rows are shorter than its `py-3` nav rows.

## Written-vs-built

> [!note]
> Two things the plan did not anticipate, both found by the existing suite:
> `space-page.test.tsx` failed twice — once because "Add source" now matched two
> buttons (fixed by scoping the query to `main`), and once because REQ-076's
> archived page suddenly offered Add source through the rail. The second was a
> real behaviour gap in the plan, not a test artefact; rule 1 above is the fix.
