---
title: Space sidebar — a persistent rail for one space's areas
kind: plan
status: done
created: 2026-08-14
updated: 2026-08-14
tags: [frontend, ui, shadcn, sidebar, navigation, base-ui, design-tokens]
---

# Proposal: a space-scoped sidebar on the space, reader, and assistant routes

## Problem

A space has areas — its source library, its assistant, the reader a citation
opens — and today there is no persistent way to move between them. The space
page is a two-column grid of four cards inside `AppShell`, whose entire chrome
is a brand link, an email, and a sign-out button. Getting from the assistant
back to the library means the browser's back button or a card-local link;
the reader route (`/spaces/:spaceId/sources/:id`) offers only the `?from=`
control Phase 3 built for the citation round-trip. Nothing on screen says
*which space you are in* once you scroll past the `<h1>`.

Two documents already answer this and neither has been implemented:

- `frontend/DESIGN.md` § Layout & Spacing specifies **"a fixed 280px navigation
  or resource panel on the left, using a `surface-subtle` background"**. It is
  the one layout element of the design system with no counterpart in the code.
- The `source_library` wireframe draws it: space identity at the top, a nav
  list below, a divider and secondary items at the bottom, main content inset
  by 280px ([[../../wireframe/index]]).

[[../shadcn-ui-adoption/proposal]] put `sidebar` explicitly out of scope with a
reason that has now expired — *"no consumer, and the sidebar alone would pull a
dozen tokens the palette has no opinion on."* This proposal is the consumer,
and the palette turns out to have an opinion on all six tokens the component
actually reads. It is also the first real exercise of the token bridge, which
that proposal shipped unproven in the app after its `dialog` pilot reverted.

## Goal

`/spaces/:id`, `/spaces/:id/sources/:sourceId`, and
`/spaces/:id/assistant/:conversationId?` render inside a persistent 280px rail
that names the space and links its areas — built from a **generated, unedited**
`shadcn` `sidebar`, painted entirely by bridge tokens, adding no capability the
PRD does not already describe.

```
  AppShell rail={<SpaceRail/>}        ← brand, email, sign out (now sticky, h-16)
    └── SidebarProvider
          ├── SpaceRail               ← space name / objective · Sources · Assistant
          └── SidebarInset            ← today's page bodies, unchanged
```

*(As built. The design drew a `SpaceShell` nested inside an untouched
`AppShell`; that could not work — see [[design]].)*

## Scope

1. **Generate `sidebar`** and the registry dependencies it declares — `input`,
   `separator`, `sheet`, `skeleton`, `tooltip`, and the `use-mobile` hook —
   committed byte-for-byte. `lucide-react` enters as a dependency; the CLI
   substitutes it for the registry's `IconPlaceholder` because
   `components.json` already says `"iconLibrary": "lucide"`.
2. **The `--sidebar-*` bridge rows**, six of them, each a `var()` redirect to an
   existing DESIGN.md token exactly as the rest of the bridge is. No colour is
   defined; `sidebar-primary` and `sidebar-primary-foreground` stay absent
   because the generated file never reads them.
3. **`src/components/space-shell.tsx`** — built as `SpaceRail`, the rail alone;
   the provider and inset live in `AppShell`. Applied to the three space-scoped
   routes.
4. **The nav list**: *Sources* and *Assistant*. Both are routes that exist.
5. **The mobile presentation** the component ships: below `md`, the rail
   becomes a `Sheet` behind a `SidebarTrigger`, so §18's 320px floor keeps the
   full page width for content.
6. **Test infrastructure for Base UI in jsdom** — `matchMedia`,
   `ResizeObserver`, `scrollIntoView`, `hasPointerCapture` — the stubs
   [[../shadcn-ui-adoption/design]] predicted would be needed "once, when the
   first such component lands". This is that component.
7. **One edit to the hand-written `button.tsx`**: the `icon-sm` size
   `SidebarTrigger` asks for. See [[design]] — it is the only file this
   proposal edits that it did not create.

## Out of scope

- **Every other nav item the wireframe draws.** *Citations*, *Drafts*, *Trash*,
  *Help* — §20 exclusions or items with no PRD §2 counterpart
  ([[../../wireframe/index]] "Not in scope"). A mockup is not authorization.
- **Notes and Notebook nav entries.** Their routes arrive in Phases 5 and 6; a
  link to a route that does not exist is worse than no link. They join the list
  in their own phase, which is a one-line change by then.
- **Moving "Add source" into the rail.** The wireframe puts it there. Doing so
  lifts `AddSourceDialog`'s open state out of `SourceLibrary` and past the
  archived-space guard that currently hides it — a behaviour change dressed as
  a layout one. See [[design]] "Open questions".
- ~~**Changing `AppShell`**~~ — *not held.* It gained an optional `rail` slot
  and a `sticky`, fixed-height header, because the generated `Sidebar` is
  `fixed` and `SidebarInset` is a `<main>`; see [[design]]'s `Written-vs-built`.
  What *did* hold: the home page and every non-space route render exactly the
  markup they did before, and no account menu, notifications, settings, avatar,
  or cross-space search was added.
- **Re-laying-out the space page's four cards.** They keep their grid inside
  the inset. Sort controls, grid/list toggle, and the category counts the
  wireframe shows are not part of this.
- **Dark mode.** The generated file is full of `dark:` classes; they stay inert
  under the `.dark` rebinding already in `index.css`.
- **A spec entry.** Nothing user-observable changes about *behaviour* —
  navigation targets that already existed become reachable in one click. If the
  §18 review turns up a requirement worth naming, it belongs in
  [[../../specs/spaces/spec]], not a new capability.

## Acceptance criteria

- `src/components/ui/sidebar.tsx` and its five generated siblings are committed
  **exactly as generated**; the only hand-written line in the whole feature is
  in `space-shell.tsx` and `button.tsx`.
- No literal hex value appears in any component file. **The 280px measurement
  is unverified** — the rendered app was never opened; see [[tasks]] F6.
- `index.css` gains only redirects: the existing `@theme` block keeps every
  token it has at the value it has, verified the way
  [[../shadcn-ui-adoption/tasks]] verified it — a build diffed against
  `master`, not by eye.
- **`button.tsx` keeps its four variants and both existing sizes**, and every
  one of its 22 call sites is untouched.
- Every existing frontend test passes, none edited: 122 → 128, the six new ones
  covering the rail's §18 contract. `space-page.test.tsx`,
  `source-list.test.tsx`, and `assistant-pane.test.tsx` render through the new
  shell, so the jsdom stubs are load-bearing, not decorative.
- §18: the rail is a `<nav>` landmark, the current area carries
  `aria-current="page"`, every item is reachable and operable by keyboard, and
  the focus ring is `--color-primary` at 2px.
- At 320px the rail is off-canvas and the trigger is the first focusable
  control. **Unverified in a browser** — jsdom has no layout.
- `pnpm lint` (`tsc -b --noEmit`) clean under React 18 types.

## Cross-references

- [[design]] — the six-token mapping and why it is derived rather than guessed,
  where the shell sits, the `button` collision, and the Cmd+B collision with
  Phase 6's editor.
- [[tasks]] — work breakdown. Frontend only.
- [[../shadcn-ui-adoption/proposal]] — the bridge this extends, and the
  out-of-scope line this proposal retires.
- [[../../wireframe/index]] — the layout, and the list of what must not be
  copied from it.
- `../../../frontend/DESIGN.md` — § Layout & Spacing, the 280px rail.
- PRD §4 (the space view), §18 (keyboard and screen-reader operability),
  §20 (exclusions).
