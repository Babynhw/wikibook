---
title: Space sidebar wireframe parity — Tasks
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, ui, sidebar, wireframe, tasks]
---

# Tasks: space sidebar wireframe parity

## Backend

None.

## Frontend

### F1 — Visual parity in `space-shell.tsx`

- [x] `ITEM` class string + `size="lg"` on every nav `SidebarMenuButton`
      (`gap-3 rounded-lg px-4 font-mono text-sm`, `[&_svg]:size-5`, active pair)
- [x] Collapsed override `size-10! justify-center p-0!` so icons sit centred in
      the 3rem strip
- [x] `SidebarGroup p-0 py-2`, `SidebarMenu gap-1 px-2` — wireframe `nav px-2 space-y-1`
- [x] Header `px-6 pt-4 pb-6 gap-6`; icon box `rounded-xl text-primary`; name
      `font-mono font-black`; objective `text-sm`
- [x] Footer `px-2 py-4`, row `h-10`
- [x] No literal colour anywhere (grep `#[0-9a-f]{3,6}` in the file: none)

### F2 — Add Source in the rail

- [x] `Button variant="secondary"` under the identity; `AddSourceDialog` owned by
      `SpaceRail` via `adding` state
- [x] Withheld for an archived space and before the space loads (REQ-076/237);
      a `Skeleton` holds the row while loading so the nav does not jump
- [x] Hidden while collapsed
- [x] Library page keeps its own button — `routes/space-page.tsx` untouched

### F3 — Tests

- [x] `space-shell.test.tsx`: opens the dialog from the assistant route and
      closes it with Escape; withheld for archived / for unloaded space (two
      cases); the list query is invalidated after a source is added from the
      rail; button carries the collapsed-hidden utility; keyboard order gains
      the new stop
- [x] `space-page.test.tsx`: `within(main)` for the library's own button, and
      exactly two Add source buttons on the library page
- [x] **Gate: `pnpm test` 171 (was 167, +4), `pnpm lint`, `pnpm build` clean**
- [x] Review pass (`/review-code`): skeleton placeholder, split test, two test
      gaps closed; the class-name assertion for the collapsed state kept as the
      documented jsdom trade-off

### F4 — Wiki

- [x] This folder, `status: done`
- [x] [[../../specs/spaces/spec]] REQ-237
- [x] [[../../wireframe/index]] source_library row
- [x] [[../../index]] plan table row; [[../../log]] entry

## Implementation notes

**Verified in jsdom and the compiled stylesheet, not in a browser.** The Chrome
extension was not connected in the implementing session — the same gap
[[../space-sidebar/tasks]] recorded. What jsdom cannot answer: that `size="lg"`
rows read as the wireframe's 48px, that `size-10!` beats the variant's
`size-8!` at runtime (it does in `tailwind-merge`'s output, and the build
emits both utilities), and how the outlined button sits against
`surface-container-low`. The dev servers were running on `:5173` / `:4000` for
a manual look.
