---
title: Space sidebar — Tasks
kind: plan
status: done
created: 2026-08-14
updated: 2026-08-14
tags: [frontend, ui, shadcn, sidebar, tasks]
---

# Tasks: space sidebar

Frontend only. The order is: make the suite survive Base UI, then make the
tokens exist, then generate, then compose. Generating first would leave the
whole test suite red for reasons unrelated to the change being made.

## Backend

None. This proposal does not touch `../../../backend/` — no route, no schema,
no migration.

## Frontend

### F1 — jsdom stubs, before anything is generated

- [x] Add `window.matchMedia` to `src/test/setup.ts`, defaulting to
      **desktop** (`matches: false`), with `addEventListener`/`removeEventListener`
- [x] Add `ResizeObserver`, `Element.prototype.scrollIntoView`, and
      `Element.prototype.hasPointerCapture` stubs alongside it
- [x] **Gate: `pnpm test` passes with zero source changes** — the stubs are
      inert until something uses them

### F2 — The six bridge rows

- [x] Add `--sidebar`, `--sidebar-foreground`, `--sidebar-accent`,
      `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring` to
      `:root` in `index.css`, each a `var()` redirect per [[design]]'s table
- [x] Mirror them in `@theme inline` as `--color-sidebar-*`
- [x] Do **not** add `--sidebar-primary` / `--sidebar-primary-foreground` — the
      generated file never reads them
- [x] Replace the "deliberately absent: … every `--sidebar-*`" comment with one
      saying which two are still absent and why
- [x] **Gate: build diffed against `master` — existing tokens 0 changed,
      0 removed**

### F3 — Generate, declining the overwrites

- [x] `pnpm dlx shadcn@latest add sidebar` — accept `input`, `separator`,
      `sheet`, `skeleton`, `tooltip`, `use-mobile`
- [x] **Decline the `button` overwrite**; verify `button.tsx` is byte-identical
      afterwards (`git diff --stat src/components/ui/button.tsx` empty)
- [x] Confirm the CLI resolved `IconPlaceholder` into `lucide-react` imports
      and installed the package; no registry paths (`@/registry/...`) survive
      in any generated file
- [x] Commit every generated file unedited
- [x] Add `icon-sm` to `button.tsx`'s `size` variants — the one row
      `SidebarTrigger` needs; four variants and `sm`/`md` unchanged
- [x] **Gate: `pnpm lint` clean, `pnpm test` (122+) passes**

### F4 — `SpaceShell`

- [x] `src/components/space-shell.tsx`: `SidebarProvider` with
      `--sidebar-width: 17.5rem`, `Sidebar`, `SidebarInset`
- [x] Header: space name and objective, per the wireframe's identity block —
      translated to domain vocabulary, no "Project Alpha", no English/Vietnamese
      mixing
- [x] Nav: **Sources** → `/spaces/:id`, **Assistant** → `/spaces/:id/assistant`.
      Nothing else. Active state via `isActive` plus the
      `data-[active=true]:bg-primary-container` wrapper class
- [x] `aria-current="page"` on the active item; the rail is a `<nav>` landmark
- [x] `SidebarTrigger` rendered for the mobile presentation, first in tab order
- [x] Comment naming the Cmd+B / Tiptap collision and pointing at Phase 6 — **resolved 2026-08-27** by [[../phase-6-notebook-export/design]]: the editor stops the chord's propagation, `sidebar.tsx` untouched (REQ-249)
- [x] **Gate: `pnpm lint` clean**

### F5 — Adopt it on the three routes

- [x] `space-page.tsx` — wrap the success branch only; loading and error
      branches keep bare `AppShell`
- [x] `assistant-page.tsx` — same, and check the two-pane layout still fits
      beside a 280px rail at the width it was designed for
- [x] `source-page.tsx` — same; decide the reader question in [[design]]'s open
      questions by looking at it
- [x] **Gate: `space-page.test.tsx`, `source-list.test.tsx`,
      `assistant-pane.test.tsx` pass unchanged** — if one needs editing, say why
      in the notes below rather than editing it quietly

### F6 — §18 and the visual check

- [x] Keyboard walk **in jsdom**: Tab reaches Sources, Assistant, and All
      spaces in order — asserted in `space-shell.test.tsx`, not eyeballed
- [x] Landmark and current page: the rail's menu is labelled and the open area
      carries `aria-current="page"`, including on the reader route — asserted
- [x] Grep the whole feature for a literal hex value; none
- [x] Verified in the **compiled stylesheet** rather than by eye: `.top-16` is
      emitted after `.inset-y-0`, so the rail starts below the header;
      `h-[calc(100svh-4rem)]` compiles; `bg-sidebar` resolves to
      `var(--sidebar)` → `--color-surface-container-low` (#f2f3ff)
- [ ] **Not done — the rendered check.** The Chrome extension was not connected
      in the implementing session, so nobody looked at the running app: the
      280px measurement, the focus ring against `surface-container-low`, the
      320px off-canvas behaviour, and the two-pane assistant beside the rail are
      all *unverified in a browser*. jsdom cannot answer any of them — it has no
      layout. This is the one outstanding item.
- [x] **Gate: `pnpm test` (128, six new) and `pnpm lint` pass**

### F7 — Wiki

- [x] Tick this file, set `status: done` on all three plan documents
- [x] Record the `Written-vs-built` corrections in [[design]] — there will be
      some; the last proposal had four
- [x] Update [[../../wireframe/index]]: the icon question is settled (lucide),
      and the `source_library` sidebar is now partly implemented
- [x] Add a line to `../../../frontend/DESIGN.md` if the rail's tokens differ
      from what § Layout & Spacing says today
- [x] Append to [[../../log]]. **No spec entry** unless §18 turned up a
      requirement worth naming, in which case it goes in
      [[../../specs/spaces/spec]]

## Implementation notes

**What the CLI actually did.** `add sidebar` created seven files —
`sidebar.tsx`, `input.tsx`, `separator.tsx`, `sheet.tsx`, `skeleton.tsx`,
`tooltip.tsx`, and `src/hooks/use-mobile.ts` — rewrote every `@/registry/...`
import to this project's aliases, and resolved `IconPlaceholder` to
`lucide-react`'s `PanelLeftIcon`, exactly as the design predicted. It prompted
on `button.tsx`; answering *no* left the file byte-identical (md5 checked before
and after).

**But it installed nothing.** `@base-ui/react` and `lucide-react` were imported
by the generated files and absent from `package.json` — added by hand. The task
list assumed the CLI would handle it, and nothing in the run said otherwise; the
failure mode would have been a red build, not a silent one.

**The design's structure was wrong, and it took two rounds to find out.** See
the `Written-vs-built` callout in [[design]] — `AppShell` could not stay
untouched, and the rail could not wait for the space to load.

**`--color-sidebar-*` never appear in the built CSS**, and that is correct:
`@theme inline` means Tailwind inlines them, so `bg-sidebar` compiles straight
to `background-color: var(--sidebar)`. The F2 gate looked for the wrong name
before this was understood; the right check is that the *utility* resolves.

**The suite grew rather than changed.** 122 → 128, all six new, none of the
existing ones edited — which is the evidence the gate was asking for.

### F8 — Review fix: the rail's border colour

- [x] Diagnosed: the rail edge painted `currentColor` (the nav ink), because
      `group-data-[side=left]:border-r` names no colour and Tailwind v4 has no
      default one. Not a mapping error — `--sidebar-border` was right and unused
      for that edge
- [x] Audited `src/` for a border width with no colour: exactly two, both
      generated (`sidebar.tsx` rail edge, `sheet.tsx` drawer edges)
- [x] Restored the border half of the reset [[../shadcn-ui-adoption/design]]
      reverted, in `@layer base` — root cause rather than two patches
- [x] `outline-ring/50` deliberately not restored (§18 owns the focus ring)
- [x] **Gate: the reset is emitted before the utilities layer in the built CSS,
      so explicit `border-<colour>` still wins; `pnpm test` (128) and
      `pnpm lint` pass**

## Cross-references

- [[proposal]] · [[design]]
- [[../shadcn-ui-adoption/tasks]] — the phase-and-gate shape this follows, and
  the reverted pilot that is the reason each gate is the existing suite.
