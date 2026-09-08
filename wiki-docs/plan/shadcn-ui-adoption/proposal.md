---
title: shadcn/ui adoption — a token bridge, not a re-skin
kind: plan
status: done
created: 2026-08-14
updated: 2026-08-14
tags: [frontend, ui, shadcn, base-ui, design-tokens, tailwind-v4]
---

# Proposal: adopt shadcn/ui behind the existing design tokens

## Problem

[[../../AGENTS]] names "Tailwind CSS + shadcn/ui" as the frontend stack, and
the frontend already carries every dependency shadcn generates against —
`class-variance-authority`, `clsx`, `tailwind-merge`, a `cn()` at
`frontend/src/lib/utils.ts`, the `@` alias, and a `src/components/ui/`
folder. What is missing is the part that makes those dependencies mean
something: `components.json`, a primitives package, and a decision about
tokens.

Nothing has needed it yet. Phases 1–4 shipped with five hand-written
primitives — `button`, `card`, `dialog`, `field`, `alert` — and that was the
right call for five. Phases 5 and 6 are not five: notes and the Tiptap
notebook bring menus, popovers, toolbars, tabs, and toasts, and every one of
those is a focus-management problem that a hand-written version gets subtly
wrong. `dialog.tsx` is the evidence in both directions — 110 lines of focus
trap, Escape handling, and backdrop discipline, with a test suite whose
existence is the comment's own justification for not using the platform.
Writing that again per component is the cost this proposal avoids.

The obstacle is not the CLI. It is that a generated shadcn component is
written against a token vocabulary this project does not have. shadcn emits
`bg-background`, `text-foreground`, `border-input`, `ring-ring`,
`bg-muted`, `text-destructive`; `frontend/src/index.css` defines the
Material-3 vocabulary of `frontend/DESIGN.md` — `surface`,
`surface-container-*`, `on-surface`, `on-surface-variant`, `outline`,
`outline-variant`, `primary-container`, `error`. Add a component today and
it renders unstyled-but-not-broken: transparent backgrounds, invisible
borders, no focus ring. The naive fixes are both bad — hand-editing every
generated file (which forfeits the reason to generate it) or replacing
DESIGN.md's palette with shadcn's (which discards the design system for a
default).

## Goal

`pnpm dlx shadcn@latest add <component>` produces a component that renders
in WikiBookLM's palette **with no edit to the generated file**, and
`frontend/DESIGN.md` remains the single source of truth for what a colour is.

```
  frontend/DESIGN.md            ← the palette. Unchanged by this proposal.
        │
        ▼
  @theme  in index.css          ← --color-surface, --color-on-surface, …
        │                          (already exists, unchanged)
        ▼
  :root + @theme inline (new)   ← --background: var(--color-surface)
        │                          --border:     var(--color-outline-variant)
        │                          … one alias per shadcn role, in two layers
        ▼                            (bare names and --color-* names)
  generated shadcn component    ← bg-background, border-border, ring-ring
        │                          committed verbatim, never hand-edited
        ▼
  the same pixels DESIGN.md specifies
```

The bridge is one direction only. Existing code keeps writing
`bg-surface-container-lowest`; the aliases exist so that *generated* code
does not have to.

## Scope

1. **`components.json`** — pointed at `src/index.css`, `@/components/ui`,
   `@/lib/utils`, CSS variables on, so the CLI writes where the project
   already keeps things.
2. **The token bridge** — alias entries mapping every shadcn colour role to
   an existing DESIGN.md token. Documented inline, role by role, because the
   mapping is a design judgement and not a mechanical rename. *(Built as two
   layers rather than one, and no radius bridge turned out to be needed — see
   [[design]].)*
3. **`tw-animate-css`** — the enter/exit animations shadcn's v4 output
   assumes. Without it, overlays and popovers pop rather than fade.
4. **A named add-on-demand rule**: a component is generated when a screen
   needs it, and nothing lands in `src/components/ui/` unused.
5. **A pilot that proves the bridge on real call sites** — `dialog` moves to
   the primitives library behind its current props, with `dialog.test.tsx`
   unchanged as the gate. Seven call sites, no visible change, and the
   hand-written focus trap retires. *(Attempted; the gate failed it and it was
   reverted — see [[tasks]] P4.)*

## Out of scope

- **Re-skinning.** No screen changes appearance. If a pixel moves, the
  bridge is wrong.
- **Replacing `button`, `card`, `field`, `alert`** — and, as it turned out,
  `dialog` too. `field` and `alert` encode PRD §16's keep-what-was-typed, error-next-to-the-field contract and
  have no shadcn equivalent; `button` and `card` are thin and already
  cva-shaped. Nothing is gained by regenerating them, and 22 and 8 call
  sites respectively would be churned for it.
- **Dark mode.** DESIGN.md defines one light palette, so generated `dark:`
  classes must stay inert. *Achieving* that took rebinding the variant to a
  `.dark` class that is never set — leaving it alone would have let Tailwind
  v4's stock `prefers-color-scheme` variant fire them ([[design]] "`dark:` is
  rebound"). Adding a real dark palette is a DESIGN.md change and its own
  proposal.
- **The `sidebar` component and chart tokens.** No consumer; the sidebar
  alone would pull a dozen tokens the palette has no opinion on.
- **Replacing the native `<select>`s.** `source-filters.tsx` chose the
  platform control on purpose and says why; a shadcn `select` would reverse a
  decision this proposal has no evidence against.
- **New UI features.** No account menu, no toasts, no tabs land here. Those
  arrive with the screens that need them, under their own phase.

## Acceptance criteria

- `pnpm dlx shadcn@latest add <any in-scope component>` writes a file that
  compiles, renders in WikiBookLM's palette, and is committed **byte-for-byte
  as generated**.
- Every existing frontend test passes unchanged, including
  `dialog.test.tsx`, `field.test.tsx`, and `alert.test.tsx`.
- `index.css`'s existing `@theme` block keeps every token it has today at the
  value it has today. Verified by diffing a build against `master`:
  **0 variables changed, 0 removed, 45 added**. `DESIGN.md`'s palette is
  likewise untouched — it gained only a section *documenting* the bridge,
  which the original wording ("is not edited") did not anticipate.
- No literal hex value enters a component file — the `frontend/CLAUDE.md`
  rule holds for generated code too, which is exactly what the bridge buys.
- A focus ring is visible on every shadcn control, and it is
  `--color-primary` at 2px — the ring PRD §18 already requires and
  `index.css` already draws for `:focus-visible`.
- After the pilot, `Dialog`'s public props are unchanged, the seven call
  sites are untouched, and focus still returns to the trigger on close.
  *(Met by reverting: the swap could not satisfy the suite as written, so
  `dialog.tsx` is byte-identical to before this proposal.)*
- `pnpm lint` (`tsc -b --noEmit`) is clean with React 18 types.

## Cross-references

- [[design]] — the role-by-role mapping, why `@theme inline`, what
  `shadcn init` is not allowed to overwrite, and the primitives-in-jsdom cost.
  Carries a `Written-vs-built` callout: four decisions were corrected on
  contact with the CLI.
- [[tasks]] — work breakdown. Frontend only.
- [[../../AGENTS]] — names shadcn/ui as the intended stack.
- `../../../frontend/DESIGN.md` — the palette this bridge preserves.
- `../../../frontend/CLAUDE.md` — tokens not hex; §16 and §18 form rules.
- PRD §16 (form errors), §18 (keyboard and screen-reader operability),
  §20 (what the MVP must not grow).
