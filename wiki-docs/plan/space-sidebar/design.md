---
title: Space sidebar — Design
kind: plan
status: done
created: 2026-08-14
updated: 2026-08-14
tags: [frontend, ui, shadcn, sidebar, base-ui, design-tokens, a11y, design]
---

# Design: space sidebar

Six token rows, one new shell component, and four collisions that are the
actual work. The collisions are listed with the decision each one forces,
because every one of them is a place where "just run `shadcn add`" produces
something wrong in a way that compiles.

> [!warning] Written-vs-built
> The four collisions this design was written around were all real and all
> decided correctly. What it got wrong was the *structure* — the one section
> that was not written from the registry file. Two corrections, both in the
> first section below, and the second was a live bug rather than a tidiness
> problem:
>
> 1. **`AppShell` could not stay untouched, and `SpaceShell` does not exist.**
>    The generated desktop `Sidebar` positions itself `fixed`, so it cannot be a
>    descendant of the `<main>` it sits beside — and `SidebarInset` *is* a
>    `<main>`, so nesting one inside `AppShell`'s would have produced two.
>    `AppShell` gained an optional `rail` slot instead, and the hand-written file
>    exports `SpaceRail` — the rail only, with the provider and inset in
>    `AppShell`. Its header also became `sticky` at a fixed `h-16`, which is what
>    gives the rail a height to start below.
> 2. **The rail must render before the space loads.** The design said the
>    loading branches keep a bare `AppShell` and the rail appears with the
>    space. Doing that makes `AppShell` swap between two different element
>    trees, and React responds by unmounting everything under it: the reader
>    threw away its loaded blocks and reading position the moment the space
>    query answered. Found by five `source-reader.test.tsx` failures whose
>    symptom was a *detached* element — `findByRole` resolving with a node that
>    had already been replaced. `SpaceRail` now takes a required `spaceId` from
>    the URL and an optional `space`, showing a `Skeleton` until the name
>    arrives. The suite caught a behaviour regression the design had reasoned
>    its way into, which is what the suite is for.
>
> Everything else held: the six-token mapping, the wrapper class for the active
> item, the style-prop width, declining the `button` overwrite plus one added
> size, and the `matchMedia`-during-render prediction.

## Decisions

### The sidebar is space-scoped, so it is a slot on `AppShell` (decided 2026-08-14, corrected on contact)

Every item in the rail needs a `spaceId`: `/spaces/:id`,
`/spaces/:id/assistant`. The home page has no space, and the auth routes are
not inside `AppShell` at all. Putting the rail in `AppShell` would mean the
component that frames *every* authenticated screen taking a prop that only
three of them can supply.

The design as written nested a `SpaceShell` inside an untouched `AppShell`.
That does not work, for a reason only the generated file reveals: its desktop
container is `fixed`, and `SidebarInset` is itself a `<main>`. Nesting the pair
inside `AppShell`'s `<main>` would have produced two `<main>` landmarks and a
rail positioned against the viewport rather than the layout it appears to
belong to.

So `AppShell` takes an optional `rail`, and the three space routes pass one:

```tsx
<AppShell rail={<SpaceRail spaceId={spaceId} space={space.data} />}>
  …today's page body, unchanged…
</AppShell>
```

`AppShell` renders one of two layouts — its original `header + main` when there
is no rail, and `SidebarProvider > header + (rail + SidebarInset)` when there
is. Exactly one `<main>` either way. Its header became `sticky top-0 h-16`,
because a `fixed` rail needs a header height it can start below; `SpaceRail`
passes `top-16 h-[calc(100svh-4rem)]` through `className`, which is the same
offset the wireframe's `<aside>` uses.

**Which route passes a rail is fixed per route, never per loading state.** A
route that passes `rail` sometimes makes `AppShell` swap trees, and React
unmounts the whole page to do it — on the reader, that discards loaded blocks
and the reading position (see the callout above). So `SpaceRail` takes the
`spaceId` from the URL, which is available immediately, and treats `space` as
decoration that arrives late. Only `space-page.tsx` differs, and legitimately:
its pending and error branches are different *pages*, not a different chrome
around the same one.

### The six `--sidebar-*` tokens are derived from DESIGN.md, not guessed (decided 2026-08-14)

[[../shadcn-ui-adoption/design]]'s rule — *a missing token fails visibly once,
a guessed one fails plausibly forever* — is why `sidebar-*` was omitted then.
It is satisfiable now: DESIGN.md § Layout & Spacing names the panel and its
background, and the wireframe shows the rest. Grepping the generated file for
what it actually reads yields exactly six names (`bg-sidebar`,
`text-sidebar-foreground`, `bg-sidebar-accent`, `text-sidebar-accent-foreground`,
`bg-sidebar-border` / `border-sidebar-border` / `ring-sidebar-border`,
`ring-sidebar-ring`):

| shadcn role | WikiBookLM token | Why |
|---|---|---|
| `sidebar` | `surface-container-low` | DESIGN.md says `surface-subtle`; `surface-container-low` (#f2f3ff) is that role's token, and it is what the wireframe's `<aside>` uses. |
| `sidebar-foreground` | `on-surface-variant` | Nav ink at rest — the wireframe's inactive items, and the pairing every secondary label in the app already uses. |
| `sidebar-accent` | `surface-container-highest` | One elevation step for hover, matching the bridge's existing `accent` reasoning and the wireframe's `hover:bg-surface-container-highest`. |
| `sidebar-accent-foreground` | `on-surface` | Ink darkens on hover; the hue does not change. |
| `sidebar-border` | `outline-variant` | Every border in this codebase is `outline-variant`. Splitting the rail off would invent a distinction the palette has not made. |
| `sidebar-ring` | `primary` | The §18 ring, same as `--ring`. |

`--sidebar-primary` and `--sidebar-primary-foreground` are **not** added. shadcn
ships them in its own stylesheet, but this generated file never reads them, and
the rule that kept `chart-*` out keeps them out.

### The active item is a wrapper class, not a re-pointed token (decided 2026-08-14)

The generated `SidebarMenuButton` spends **one** token on two states:
`hover:bg-sidebar-accent` and `data-active:bg-sidebar-accent`, distinguishing
them only by `font-medium`. The wireframe wants the current area to be a filled
blue pill (`bg-primary-container` / `text-on-primary-container`), which is a
different token entirely.

Both cannot come from `--sidebar-accent`. Re-pointing it at
`primary-container` would paint every hover blue; leaving it means the current
area is distinguished by weight alone, which is thin and which `aria-current`
carries better anyway.

So the token stays on the hover value, and the shell passes the active styling
as `className` on its own nav item — a documented prop, not an edit to the
generated file:

```tsx
<SidebarMenuButton
  isActive={active}
  className="data-active:bg-primary-container data-active:text-on-primary-container"
/>
```

`data-active:` — not `data-[active=true]:` — because Base UI's `state` prop emits
a bare boolean attribute and `shadcn/tailwind.css` already ships the variant for
it. `cn()` puts `className` last, so tailwind-merge drops the generated
`data-active:bg-sidebar-accent` rather than stacking on it.

This is the wrapper escape hatch `frontend/CLAUDE.md` already prescribes
("a needed variation goes in a wrapper"), used for the first time.

### 280px comes from the provider's style prop (decided 2026-08-14)

The generated file hard-codes `SIDEBAR_WIDTH = "16rem"` (256px) and reads it
from `--sidebar-width` set inline by `SidebarProvider`. DESIGN.md says 280px.
The prop is the supported override:

```tsx
<SidebarProvider style={{ '--sidebar-width': '17.5rem' } as React.CSSProperties}>
```

`--sidebar-width-mobile` (18rem) and `--sidebar-width-icon` (3rem) stay at
their defaults; neither has a DESIGN.md opinion to honour.

### The `button` collision: decline the overwrite, add one size (decided 2026-08-14)

`sidebar`'s registry dependencies include `button`, and
`frontend/CLAUDE.md` says `button` is hand-written and stays that way. The CLI
will offer to overwrite `src/components/ui/button.tsx`; it must be declined,
and the file verified byte-identical afterwards. (Same for `card` and `dialog`
if any transitive dependency reaches them.)

That leaves a real mismatch. `SidebarTrigger` renders
`<Button variant="ghost" size="icon-sm">`, and the hand-written `cva` has
`sm | md` only. An unknown variant key is not an error in `cva` — it silently
falls through to `defaultVariants`, so the trigger would render as a 40px
text-sized button with an icon in it. `tsc` catches it, which is the gate
working, but the fix is a decision:

**Add `icon-sm` to `button.tsx`.** It is a hand-written file, ours to extend,
and a square icon button is a shape the design system will need again (the
reader's controls, Phase 6's toolbar). One row: `'icon-sm': 'size-8 p-0'`.
Nothing else about the file moves, and its 22 call sites are untouched because
the variant is additive.

The rejected alternative — skipping `SidebarTrigger` and hand-writing a toggle
— trades one line of `button.tsx` for a component that duplicates
`useSidebar()`'s contract and drifts from it.

### Cmd/Ctrl+B is a collision with Phase 6, and it is disabled now (decided 2026-08-14)

The generated provider installs a **global** `keydown` listener on
`SIDEBAR_KEYBOARD_SHORTCUT = "b"` with meta/ctrl. Tiptap's default bold binding
is Cmd+B. Phase 6 puts a Tiptap editor on the notebook route, and Phase 5 puts
one in the note editor — at which point typing bold text also toggles the
navigation.

The listener is inside the generated file, so it cannot be edited away. Two
options: accept it now and untangle it in Phase 6 (when the person hitting it
is the user, not us), or keep the provider and simply never document the
shortcut. Neither removes the listener.

**Decision: flag it in `space-shell.tsx` with a comment naming Phase 6, and
resolve it there** — the resolution is a wrapper that stops propagation inside
the editor, which cannot be written before the editor exists. It is recorded
here so it is found by grep and not by a bug report.

### The cookie is not the session cookie (decided 2026-08-14)

`SidebarProvider` writes `sidebar_state=true|false; path=/; max-age=7d`,
readable by script. The auth session cookie is HttpOnly and set by the API
([[../../specs/auth/spec]]). They share nothing but the word "cookie", and this
one carries no identity — but the name will appear in DevTools next to one that
does, so it is written down here. There is no SSR in this SPA, so the
open-by-default state simply flashes to the stored value on mount; on a rail
that is inert until hovered this is not perceptible, and it is not worth a
blocking read.

### Base UI in jsdom is now unavoidable (decided 2026-08-14)

`sidebar` pulls `sheet` and `tooltip`, both Base UI floating components, plus
`use-mobile`, which calls `window.matchMedia`. jsdom implements none of
`matchMedia`, `ResizeObserver`, `scrollIntoView`, or `hasPointerCapture`.

`matchMedia` is the sharp one: it is called during **render**, so every
existing test that mounts a space route — `space-page.test.tsx`,
`source-list.test.tsx`, `source-search.test.tsx`, `assistant-pane.test.tsx` —
throws before it asserts anything. The stubs go in `src/test/setup.ts`, once,
where `jest-dom` already is, and they are a prerequisite of the first task
rather than cleanup after the last.

The stub must default to **desktop** (`matches: false` for the mobile query),
or the whole suite would suddenly be testing the `Sheet` presentation.

### Icons: lucide, which settles an open question the wireframes left (decided 2026-08-14)

`components.json` already carries `"iconLibrary": "lucide"`, so the CLI
resolves the registry's `IconPlaceholder` into `lucide-react` imports and
installs it. That makes lucide the project's icon set by consequence rather
than by argument — worth stating plainly, because
[[../../wireframe/index]] records "the mockups use Material Symbols and the SPA
has no icon dependency yet; picking one is an open decision".

This decides it: **lucide-react**, tree-shaken per icon, no webfont, no CDN
request — the same reason `index.css` self-hosts its fonts. Material Symbols is
not adopted; the wireframes' icon names are translated at the call site. The
wireframe index gets a line saying so once this ships.

### The border-colour reset had to come back (found in review 2026-08-14)

The rail's right edge rendered as the nav *ink* (#434654), not a border. Nothing
about the six-token mapping was wrong — `--sidebar-border` was correct and
unused for that edge:

```
group-data-[side=left]:border-r     ← width and style, no colour
```

Tailwind v4 dropped v3's default border colour, so a bare border utility paints
`currentColor`, and the container carries `text-sidebar-foreground`. Generated
shadcn components are written against the reset `shadcn init` adds —
`* { @apply border-border outline-ring/50 }` — and
[[../shadcn-ui-adoption/design]] reverted the init diff **in full**, that line
included. Reverting the palette was right; reverting this was collateral, and it
stayed invisible until a generated component with a coloured `text-*` ancestor
finally had a border.

So `index.css` restores the border half in `@layer base`:

```css
*, ::before, ::after, ::backdrop { border-color: var(--color-outline-variant); }
```

Why this and not a class on the call site: an audit of `src/` found **exactly
two** places with a border width and no colour, and both are generated
(`sidebar.tsx`'s rail edge, `sheet.tsx`'s four drawer edges). Patching them from
the outside would fix two symptoms and leave the next generated component to
rediscover the cause. Because it is `base`, every explicit `border-<colour>`
utility still wins — confirmed in the built stylesheet, where the reset is
emitted 6.5 kB before `.border-outline-variant`.

The reset's `outline-ring/50` half is deliberately **not** restored: §18's focus
ring is the one `:focus-visible` already draws.

## Consequences

- The token bridge finally has a consumer in the app. Until now it was verified
  only by a `separator` that was generated, inspected, and deleted.
- `src/components/ui/` roughly doubles, and all of the growth is generated. The
  hand-written five stay five (`button` gains a row; it does not become
  generated).
- Three routes gain a wrapper component; none of their bodies change.
- Phases 5 and 6 inherit `sheet`, `tooltip`, and `skeleton` for free — three
  components they were going to need anyway — and inherit the Cmd+B problem,
  which they were not.

## Open questions

- **The rendered app has not been looked at.** Every §18 and geometry claim
  above is verified in the compiled stylesheet and in jsdom, neither of which
  has layout. The 280px measurement, the focus ring against
  `surface-container-low`, the 320px off-canvas behaviour, and the assistant's
  two-pane layout beside the rail are outstanding — see [[tasks]] F6.

- **Does "Add source" belong in the rail?** The wireframe says yes. It means
  lifting dialog state out of `SourceLibrary`, past the `readOnly` guard that
  hides the button on an archived space (REQ-100). Worth doing, worth doing
  deliberately, not worth doing inside a layout change.
- ~~**Should the reader route show the rail at all?**~~ **Answered: yes.** The
  reader's own text is `max-w-prose`, so the rail costs it nothing, and a
  citation deep-link otherwise leaves the user in a source whose only exit is
  the `?from=` control — which exists only when a citation put them there. The
  rail also treats the reader as part of *Sources*, so the current-area marker
  does not read as having left the space.
- **What does the rail show for an archived space?** The page already carries
  an archived banner. Duplicating the state in the rail may be noise; omitting
  it may be a surprise on the reader route where the banner is not rendered.
- **`SidebarMenuBadge` for source counts.** The wireframe shows counts per
  category; categories are a §20 exclusion, but a total source count is not.
  Deferred — it needs a number the rail does not currently fetch.

## Cross-references

- [[proposal]] — problem, scope, acceptance criteria.
- [[tasks]] — work breakdown and gates.
- [[../shadcn-ui-adoption/design]] — the bridge's two layers, the `.dark`
  rebinding, and the jsdom cost this design pays.
- [[../../wireframe/index]] — the layout, the vocabulary table, the exclusions.
- `../../../frontend/DESIGN.md` — § Layout & Spacing (280px, `surface-subtle`).
- `../../../frontend/src/index.css` — where the six rows land.
- `../../../frontend/CLAUDE.md` — generated files are not hand-edited; `button`
  stays hand-written.
