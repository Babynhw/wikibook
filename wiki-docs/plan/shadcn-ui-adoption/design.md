---
title: shadcn/ui adoption — Design
kind: plan
status: done
created: 2026-08-14
updated: 2026-08-14
tags: [frontend, ui, shadcn, base-ui, design-tokens, tailwind-v4, design]
---

# Design: shadcn/ui adoption

The whole design is one file's worth of CSS and three rules about what is
allowed to touch it. Everything else follows.

> [!warning] Written-vs-built
> Four decisions below were written from documentation and corrected on
> contact with the CLI: the bridge needed **two** layers rather than one, the
> `inline` rationale was wrong, `dark:` had to be **rebound** rather than left
> alone, and shadcn 4.18 generates against **Base UI, not Radix**. Each is
> marked. The `dialog` pilot was attempted and **reverted** — see the last
> section.

## Decisions

### The bridge is an alias layer, not a palette (decided 2026-08-14)

Two ways to make a generated component render correctly: change the
component to speak our token names, or change the stylesheet to answer
theirs. The second is the only one that survives `shadcn add` being run
again.

So `index.css` gains alias entries whose every value is a `var()` pointing at
an existing token. No colour is *defined* there, which is what makes the claim
"DESIGN.md stays the source of truth" mechanically true rather than a promise:
change a hex in DESIGN.md, propagate it to the `@theme` block as today, and the
shadcn surface follows for free.

**Revised on contact — the bridge needs two layers, not one.** The original
design mapped `--color-*` names only. That is not enough, because generated
components also reach for the *bare* name directly:

```
hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]
                              ^^^^^^^^^^^^^^ not --color-secondary
```

So the bridge mirrors shadcn's own two-layer convention, with our tokens as the
values instead of `oklch` literals:

```css
:root         { --secondary: var(--color-secondary-container); }  /* bare names */
@theme inline { --color-secondary: var(--secondary); }            /* utilities  */
```

**The `inline` rationale was wrong as first written.** It claimed a bare
`@theme` would emit an unresolvable value. It would not — CSS variables resolve
fine. The real reason is that without `inline` the value is resolved once at
`:root`, so a scoped redefinition could never reach it. Correct conclusion,
wrong reason, and the comment in `index.css` now states the right one.

### The mapping, role by role (decided 2026-08-14)

Material 3 and shadcn cut the same space differently — M3 names a surface by
*elevation* (`surface-container-low` … `-highest`), shadcn by *purpose*
(`card`, `popover`, `muted`, `accent`). The mapping is therefore a design
judgement per row:

| shadcn role | WikiBookLM token | Why |
|---|---|---|
| `background` / `foreground` | `surface` / `on-surface` | The page ground, as `body` already sets it. |
| `card` / `card-foreground` | `surface-container-lowest` / `on-surface` | What `card.tsx` and the dialog panel use today. |
| `popover` / `popover-foreground` | `surface-container-lowest` / `on-surface` | A popover is a card that floats; DESIGN.md draws no distinction. |
| `muted` / `muted-foreground` | `surface-container` / `on-surface-variant` | The existing pairing for secondary text on a tinted ground. |
| `accent` / `accent-foreground` | `surface-container-high` / `on-surface` | shadcn spends `accent` on hover/highlight — one elevation step, not a hue change. |
| `primary` | **not aliased** | `--color-primary` already exists at exactly the value shadcn wants, and `bg-primary`/`text-primary` are live in the reader. Aliasing it to `var(--primary)` — which points back at it — would be a self-reference. Only `primary-foreground` → `on-primary` is added. |
| `secondary` / `secondary-foreground` | `secondary-container` / `on-secondary-container` | shadcn's `secondary` is a *filled* low-emphasis surface, so it maps to the container, not to M3's like-named ink. |
| `destructive` / `destructive-foreground` | `error` / `on-error` | Direct; matches `button.tsx`'s `danger`. |
| `border` and `input` | `outline-variant` | One token for both: every existing border in the codebase is `border-outline-variant`. Splitting them would invent a distinction the palette does not make. |
| `ring` | `primary` | The ring `index.css` already draws at `:focus-visible`. |

Two consequences found while building it:

- **`on-secondary-container` had to be added to `@theme`.** DESIGN.md defines
  it (#57657a) but `index.css` had never needed it. It is a pure addition of a
  value the design system already published, and it measures 4.57:1 on its
  container — clearing AA for body text, which is why it was preferred over
  substituting `on-surface`.
- **`secondary` is the one name where the two vocabularies genuinely collide,
  and shadcn wins.** After the bridge, `bg-secondary` means #D5E3FC, not M3's
  #515F74 ink. Safe today — a grep found zero call sites for the M3 spelling —
  but it does mean that ink is now reachable only as `on-secondary-container`,
  and DESIGN.md says so.

Deliberately absent: `chart-1…5` and every `sidebar-*` token. They have no
consumer and no DESIGN.md value, and a guessed value is worse than a
missing one — a missing token renders visibly wrong the first time it is
used, a guessed one renders plausibly wrong forever.

### No radius bridge is needed (revised 2026-08-14)

The original design specified deriving a four-step radius scale from
`--radius`. Unnecessary: Tailwind v4 ships `--radius-sm|md|lg|xl` defaults, and
DESIGN.md's own 4px base and 8px card radius are already what `--radius` and
`--radius-lg` say. shadcn's components reach for `rounded-lg`; that resolves to
DESIGN.md's 8px, which is the right value for the floating surfaces they are.
The two scales happen to agree, so nothing is translated.

The rule that decides collisions of this kind stands: **where DESIGN.md has an
opinion, DESIGN.md wins; the bridge only fills gaps.**

### `shadcn init` is run for `components.json` and reviewed line by line (decided 2026-08-14)

The CLI does more than write a config. Against a Tailwind v4 project it also
injected into `index.css`: a full `:root` palette in `oklch`, a `.dark` block,
`@custom-variant dark`, `@theme inline` wiring, a global
`* { @apply border-border outline-ring/50 }`, and — not anticipated —
`--font-sans: 'Geist Variable'`, `--radius: 0.625rem`, and
`--color-primary: var(--primary)`, which would have turned WikiBookLM Blue into
near-black.

So init runs, and its diff to `index.css` is **reverted in full**;
`components.json` is the only artefact kept, and the bridge is hand-written.

> [!warning] Reverting in full was one line too many
> Found 2026-08-14 while building [[../space-sidebar/design]]: the global
> `* { @apply border-border … }` in that diff is **not** part of the palette —
> generated components depend on it, because Tailwind v4 has no default border
> colour and their bare `border-r` / `border-l` utilities paint `currentColor`.
> The rail's right edge rendered as the nav ink until the border half of the
> reset was restored in `@layer base`. The `outline-ring/50` half stays
> reverted; §18's ring is `:focus-visible`'s.

**Two things the design did not anticipate:**

- **It wrote components to a literal `frontend/@/` folder.** The CLI resolves
  aliases through `tsconfig.json`, which here is a solution file (`files: []`,
  references only) with no `paths`. It found none and took `@` literally. The
  real `button.tsx` and `utils.ts` were never touched. Fixed by adding `paths`
  to `tsconfig.json` with a comment saying why it is duplicated from
  `tsconfig.app.json` — after which `add` lands in `src/components/ui/`.
- **It installs more than it needs.** `@fontsource-variable/geist` (the style's
  font, against DESIGN.md) was removed, and `shadcn` moved to
  `devDependencies` — it is a runtime dependency only in the sense that
  `index.css` imports one stylesheet from it.

### `dark:` is rebound, not left alone (revised 2026-08-14)

The original decision — "do not add `@custom-variant dark`, generated `dark:`
classes stay inert" — was wrong, and wrong in the direction that breaks things.
Tailwind v4's stock `dark:` variant is `prefers-color-scheme`. Left alone,
every `dark:` class shadcn generates would fire on any machine set to dark and
paint half the UI against a palette DESIGN.md does not have.

Inert is still the goal; achieving it takes the line shadcn's init adds:

```css
@custom-variant dark (&:is(.dark *));
```

with `.dark` never set on any element. Confirmed harmless for existing code —
nothing in `src/` uses a `dark:` utility. Adding a real dark mode still means
authoring a second palette in DESIGN.md first.

### The pilot was `dialog`, and its existing tests were the contract — which they enforced (attempted, reverted 2026-08-14)

The bridge is only proven by a component that renders in the app, and
add-on-demand means no *new* component has a consumer yet. `dialog` did: seven
call sites, and `dialog.test.tsx` already asserting every behaviour a library
would take over.

The migration was written and it failed the gate — **six of seven tests**. Two
failures are not fixable without editing the suite:

- **The page behind goes `inert`.** Base UI marks the rest of the document
  `aria-hidden` / `data-base-ui-inert`, so
  `getByRole('button', { name: 'refetch' })` can no longer find a control
  outside the dialog. The test that asserts a parent re-render leaves focus
  alone depends on reaching that button.
- **The backdrop is a sibling, not a parent.** `Portal` renders `Backdrop` and
  `Popup` side by side, so `getByRole('dialog').parentElement` is the portal
  container rather than the backdrop the test presses.

Neither is a defect. Both are arguably *better* than the hand-written version —
`inert` is a stronger guarantee than a manual Tab trap, and Base UI omits
`aria-modal` precisely because containment supersedes it. But validating that
means rewriting the §18 suite, and that suite is the accumulated evidence for
PRD §18 on this project. Rewriting the test that judges the change, in the same
step as the change, is how a regression gets ratified.

So the gate held and `dialog.tsx` was reverted, unchanged. Migrating it is a
real proposal — one whose first task is agreeing what the §18 assertions should
say when containment replaces a focus trap — and not a footnote to a token
bridge.

### Base UI, not Radix (revised 2026-08-14)

The proposal assumed Radix. shadcn 4.18 generates against **Base UI**
(`@base-ui/react`, style `base-nova`); Radix is now the legacy `new-york`
registry. The operator chose Base UI: it is the default, it is where new
components will land, and its peer range (`^17 || ^18 || ^19`) covers this
project's React 18.

The cost is two extra stylesheet imports, both verified colour-free:
`tw-animate-css` for the enter/exit keyframes, and `shadcn/tailwind.css` for
the Base UI state variants generated components are written against
(`data-open:`, `data-closed:`, `data-checked:`). Together they add ~3.4 kB to
the built CSS.

The jsdom cost the design predicted for Radix applies unchanged to Base UI:
floating components (`popover`, `select`, `menu`, `tooltip`) touch
`ResizeObserver`, `scrollIntoView`, and `hasPointerCapture`, none implemented
in jsdom. Those stubs belong in `src/test/` once, when the first such component
lands.

## Consequences

- `src/components/ui/` will acquire two kinds of file: hand-written primitives
  (`field`, `alert`, `button`, `card`, `dialog`) and generated ones. Generated
  files are not hand-edited; a needed variation goes in a wrapper.
- Adding a component is a one-line command and a token-free diff, which is
  the whole point — Phases 5 and 6 stop paying for focus management.
- The bridge is dead weight until something uses it. That is accepted: it is
  ~30 lines of CSS, and the alternative is discovering the mapping problem
  mid-phase when a notebook toolbar is due.
- Because the pilot reverted, **nothing in the app exercises the bridge yet**.
  It was verified directly instead: `shadcn add separator` produced a file
  whose `bg-border` compiled to `background-color: var(--border)` and whose
  `data-horizontal:` variant resolved, with no edit to the generated file. The
  component was then removed, having no consumer.

## Open questions

- Whether `field` should eventually be expressed through shadcn's
  `Label`/`FormMessage` pair. Not now — §16's contract is more specific than
  shadcn's, and the wrapper would be larger than the thing it wraps.
- What the §18 dialog assertions should say when page-level `inert` replaces a
  focus trap. This is the blocking question for any future `dialog` migration.
- Whether the wireframes' popovers and menus (see [[../../wireframe/index]])
  imply components that PRD §20 excludes. Read the index before adding
  anything a mockup shows.

## Cross-references

- [[proposal]] — problem, scope, acceptance criteria.
- [[tasks]] — work breakdown and what was actually built.
- `../../../frontend/DESIGN.md` — the palette every row of the mapping table
  points at, and where the bridge is documented for designers.
- `../../../frontend/src/index.css` — the file this design edits.
