---
title: shadcn/ui adoption — Tasks
kind: plan
status: done
created: 2026-08-14
updated: 2026-08-14
tags: [frontend, ui, shadcn, base-ui, tasks]
---

# Tasks: shadcn/ui adoption

Frontend only — no backend, no schema, no route. The order is: make the CLI
land in the right place, make what it emits render correctly, then prove
both on real call sites. Each phase has a gate, and the gate is always the
existing test suite, because "nothing changes" is the deliverable.

## Backend

None. This proposal did not touch `../../../backend/`.

## Frontend

### P1 — Config, without letting the CLI rewrite the stylesheet

- [x] Run `pnpm dlx shadcn@latest init` — style `base-nova`, CSS variables on,
      `tailwind.css` → `src/index.css`, aliases `@/components`, `@/lib/utils`
- [x] **Revert the CLI's entire diff to `src/index.css`** — the `oklch` `:root`
      palette, the `.dark` block, its `@theme inline`, the global
      `* { @apply border-border outline-ring/50 }`, plus three the design did
      not anticipate: `--font-sans: 'Geist Variable'`, `--radius: 0.625rem`,
      and `--color-primary: var(--primary)`, which would have made WikiBookLM
      Blue near-black
- [x] Fix the cause of the literal `frontend/@/` folder: `tsconfig.json` is a
      solution file with no `paths`, so the CLI took `@` literally. Added
      `paths` there with a comment on why it duplicates `tsconfig.app.json`
- [x] Delete the stray `frontend/@/` tree (it never overwrote the real
      `button.tsx` / `utils.ts` — both were untouched)
- [x] Trim what init installed: drop `@fontsource-variable/geist` (against
      DESIGN.md), move `shadcn` to `devDependencies`
- [x] Add `tw-animate-css` and `shadcn/tailwind.css` imports in `index.css`,
      both verified to define no colour
- [x] **Gate: `pnpm test` (122) and `pnpm lint` pass with zero source changes**

### P2 — The token bridge

- [x] Hand-write the bridge in `src/index.css`, one entry per row of
      [[design]]'s mapping table, each with its rationale as a comment
- [x] Two layers, not one: bare names in `:root` (generated code reaches for
      `var(--secondary)` inside `color-mix()`) and `--color-*` in
      `@theme inline`
- [x] Leave `--color-primary` un-aliased — it already holds the value shadcn
      wants, and aliasing it to `var(--primary)` self-references
- [x] Add `--color-on-secondary-container: #57657a` to `@theme` — DESIGN.md's
      own value, needed for `secondary-foreground`, 4.57:1 on its container
- [x] Rebind `dark:` to `.dark` — **not** skip it, or Tailwind v4's stock
      `prefers-color-scheme` variant would fire generated dark styles on any
      machine set to dark
- [x] No radius bridge: Tailwind's defaults already match DESIGN.md's 4/8px
- [x] No `chart-*`, no `sidebar-*`
- [x] **Gate: verified against a build of `master`, not by eye** —
      `0 variables changed value, 0 removed, 45 added`. `pnpm test` (122) and
      `pnpm build` clean

### P3 — Prove it: one generated component, unedited

- [x] `pnpm dlx shadcn@latest add separator` — landed in
      `src/components/ui/separator.tsx` with the correct `@/lib/utils` import,
      overwriting nothing
- [x] Verified in the built CSS, with the file unedited:
      `.bg-border{background-color:var(--border)}` → `--color-outline-variant`
      → `#c3c5d7`, and `data-horizontal:h-px` resolved from
      `shadcn/tailwind.css`
- [x] Removed again — the four `border-t` / `border-b` in `src/` are borders
      attached to elements, not standalone dividers, so `separator` had no
      honest consumer. The add-on-demand rule applies to the proof too
- [x] Dropped `@base-ui/react` and `lucide-react` with it; the first real
      component re-installs them

### P4 — Pilot: `dialog` onto Base UI, behind its current props — ATTEMPTED, REVERTED

- [x] Written: `Root` / `Portal` / `Backdrop` / `Popup` / `Title` /
      `Description`, exported signature byte-identical, `initialFocus`
      returning the first focusable, `aria-modal` set by hand (Base UI omits it)
- [x] **Gate fired: 6 of 7 tests failed, two of them unfixable without editing
      the suite** — the page behind goes `inert` so a control outside the
      dialog is unreachable to `getByRole`, and `Backdrop` is a sibling of
      `Popup` so `getByRole('dialog').parentElement` is not the backdrop
- [x] Reverted per the plan's own rule. `dialog.tsx` is byte-identical to
      before this proposal; `dialog.test.tsx` passes 7/7 with nothing relaxed
- [x] Recorded as a follow-up, not a failure: the differences are arguably
      improvements, but ratifying them means rewriting the §18 suite, which is
      its own proposal ([[design]] "The pilot was `dialog`")

### P5 — Write it down

- [x] `frontend/CLAUDE.md`: add-on-demand, generated files never hand-edited,
      colour fixes go in the bridge, and which primitives stay hand-written
- [x] `frontend/DESIGN.md`: a "Generated components" section — the bridge, the
      `secondary` collision, and why `dark:` is rebound
- [x] Tick this file, `status: done` on all three, update `../../index.md`,
      append to `../../log.md`
- [x] No `specs/` entry: nothing user-observable changed, and the one change
      that would have been (the dialog swap) was reverted

## Implementation notes

**What the plan got wrong, and what it cost.** Four of the design's decisions
were written from documentation and did not survive contact:

1. **Radix → Base UI.** shadcn 4.18 defaults to Base UI; Radix is the legacy
   `new-york` registry. Put to the operator, who chose Base UI.
2. **One bridge layer → two.** Generated code uses bare `var(--secondary)`
   inside `color-mix()`, which a `--color-*`-only mapping does not answer.
3. **`dark:` skipped → `dark:` rebound.** The original decision would have let
   generated dark styles fire via `prefers-color-scheme` on a light-only
   palette. This was the one mistake that would have shipped a visible bug.
4. **A radius bridge → none needed.** Tailwind's defaults already agree with
   DESIGN.md.

**What the CLI did that no amount of reading would have predicted:** it wrote
components into a literal `frontend/@/` directory, because it resolves aliases
through `tsconfig.json` — a solution file here, with no `paths`. Worth knowing
before the next agent assumes `add` is safe by default.

**The P2 gate is the part worth reusing.** "No visual change" was not asserted
by looking at screens; the built CSS was diffed variable-by-variable against a
build of `master`: 0 changed, 0 removed, 45 added. A claim of that shape should
always be checked that way — it is cheap, and it is the difference between
knowing and hoping.

**Outstanding.** Nothing in the app exercises the bridge yet, since the pilot
reverted and the proof component was removed. The first real consumer arrives
with Phase 5 or 6; if the mapping is wrong anywhere, that is when it shows.

## Deferred, on purpose

- `button`, `card`, `field`, `alert` stay hand-written ([[proposal]] "Out of
  scope"), and `dialog` joins them until the §18 question is settled.
- The jsdom stubs for `ResizeObserver` / `scrollIntoView` /
  `hasPointerCapture` land in `src/test/` with the **first** floating
  component (`popover`, `select`, `menu`, `tooltip`) — not before, and once,
  not per test file ([[design]] "Base UI, not Radix").
- Every other component arrives with the screen that needs it, under Phase 5
  or Phase 6.
