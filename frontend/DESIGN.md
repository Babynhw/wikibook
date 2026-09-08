---
name: WikiBookLM
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#434654'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#737686'
  outline-variant: '#c3c5d7'
  surface-tint: '#1353d8'
  primary: '#003fb1'
  on-primary: '#ffffff'
  primary-container: '#1a56db'
  on-primary-container: '#d4dcff'
  inverse-primary: '#b5c4ff'
  secondary: '#515f74'
  on-secondary: '#ffffff'
  secondary-container: '#d5e3fc'
  on-secondary-container: '#57657a'
  tertiary: '#474a4c'
  on-tertiary: '#ffffff'
  tertiary-container: '#5f6264'
  on-tertiary-container: '#dbdee0'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b5c4ff'
  on-primary-fixed: '#00174d'
  on-primary-fixed-variant: '#003dab'
  secondary-fixed: '#d5e3fc'
  secondary-fixed-dim: '#b9c7df'
  on-secondary-fixed: '#0d1c2e'
  on-secondary-fixed-variant: '#3a485b'
  tertiary-fixed: '#e0e3e5'
  tertiary-fixed-dim: '#c4c7c9'
  on-tertiary-fixed: '#191c1e'
  on-tertiary-fixed-variant: '#444749'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  display:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 8px
  gutter: 24px
  margin-desktop: 64px
  margin-tablet: 32px
  margin-mobile: 16px
  container-max-width: 1280px
---

## Brand & Style
The design system is built upon the "Academic Modern" aesthetic—a philosophy that prioritizes cognitive ease, long-form legibility, and structural integrity. The target audience includes researchers, analysts, and students who engage in "deep work." The UI must feel like a quiet, high-end library: organized, expansive, and focused.

The style is a blend of **Corporate Modern** and **Minimalism**. It avoids unnecessary ornamentation, using generous whitespace and precise alignment to signal professionalism and trust. The emotional response should be one of "calm productivity"—reducing visual noise to allow the user's content to remain the focal point.

## Colors
The palette is rooted in high-contrast utility. 
- **WikiBookLM Blue (Primary):** A disciplined blue used exclusively for primary actions, progress indicators, and active states.
- **Deep Slate (Secondary):** Used for iconography, secondary text, and structural accents to provide depth without the harshness of pure black.
- **Soft Gray (Tertiary):** Applied to backgrounds and large containers to reduce eye strain during prolonged research sessions.
- **Slate Navy (Neutral):** Reserved for primary headings and critical UI text to ensure maximum readability.

Maintain a "Paper & Ink" contrast ratio for all content areas, ensuring the background is never pure white (#FFFFFF), but rather a slightly softened off-white to prevent glare.

## Typography
This design system utilizes **Inter** for all primary communication due to its exceptional legibility and systematic neutral tone. For technical metadata, citations, and system labels, **JetBrains Mono** is introduced to provide a subtle "archival" or "data-driven" texture.

- Use `display` and `headline-lg` sparingly to maintain a scholarly hierarchy.
- `body-lg` is the default for reading modes; `body-md` is the default for UI labels and dashboard content.
- All caps should be reserved for `label-sm` metadata to distinguish it from narrative content.

**Reading face.** Extracted source text inside the reader — and only there — is
set in **Lora** (`--font-serif`, `font-serif`), 18px on a 32px line, in a centred
column of about 65 characters. It marks the boundary between the workspace and
the document being read: chrome, metadata, and every control around it stay in
Inter and JetBrains Mono. Headings inside a source revert to Inter, so the
document's own hierarchy reads in the workspace's voice.

## Layout & Spacing
The layout follows a **Fixed Grid** philosophy for the central workspace to ensure line lengths remain optimal for reading (60-75 characters). 

- **Desktop:** 12-column grid with a max-width of 1280px. Use 64px outer margins to create a "frame" effect around the work.
- **Sidebar:** A fixed 280px navigation or resource panel on the left, using a `surface-subtle` background.
- **Rhythm:** Spacing follows an 8px linear scale. For content-heavy areas, prioritize vertical "breathing room" (32px - 48px) between sections to prevent visual fatigue.

## Elevation & Depth
Elevation in this design system is conveyed through **Low-contrast outlines** and **Tonal layers** rather than heavy shadows.

- **Level 0 (Base):** Soft Gray (#F8FAFC) background.
- **Level 1 (Card/Container):** Pure White (#FFFFFF) with a 1px border in #E2E8F0. No shadow.
- **Level 2 (Active/Hover):** Pure White (#FFFFFF) with a very soft, highly diffused 10% opacity slate shadow (0px 4px 12px).
- **Level 3 (Modals/Popovers):** Standard elevation with a 1px border and a medium 15% opacity shadow to clearly separate the element from the workspace.

This "flat-plus" approach maintains the academic, structured feel without looking dated.

## Shapes
The shape language is **Soft** and precise. A 0.25rem (4px) base radius is applied to buttons and input fields to feel modern but stay disciplined. 

- `rounded-md` (default): 4px.
- `rounded-lg`: 8px for larger cards and containers.
- Avoid pill-shaped elements; they are considered too informal for this design system. All interactive elements should maintain a structural, rectangular foundation with subtly softened corners.

## Components
- **Buttons:** Primary buttons use WikiBookLM Blue with white text. Secondary buttons use a white background with a 1px Slate border. 
- **Input Fields:** Use a 1px border in a mid-tone gray (#CBD5E1). On focus, the border changes to WikiBookLM Blue and adds a 2px soft blue outer glow (ring).
- **Cards:** White background, 1px border (#E2E8F0), and 24px internal padding. Title text should always be Deep Slate.
- **Chips/Tags:** Small-scale elements using JetBrains Mono. Use a light gray fill (#F1F5F9) and no border for a subtle, archival look.
- **Research-Specific Components:**
    - *Citation Block:* A specialized list item with a vertical accent bar in WikiBookLM Blue on the left.
    - *Annotated Scrollbar:* A custom scrollbar that includes small "markers" or highlights representing search results or notes within a document.
    - *Progress Trackers:* Minimalist 2px lines at the top of cards to indicate reading or research completion.
## Generated components (the shadcn bridge)
Components added with `pnpm dlx shadcn@latest add <name>` are written against a
different vocabulary — `bg-background`, `border-input`, `ring-ring` — and are
committed **exactly as generated**, never hand-edited. `src/index.css` carries a
bridge that maps each of those roles to a token on this page, so a generated
component renders in the palette above with no edit. Two consequences worth
knowing here:

- **A colour fix goes in the bridge, not in the component.** If something
  generated looks wrong, the mapping is usually wrong — but check first whether
  the utility names a colour at all. Tailwind v4 has no default border colour,
  so `index.css` carries a `@layer base` reset putting every uncoloured border
  on `outline-variant`; generated components rely on it.
- **`secondary` means the container, not the ink.** shadcn's `secondary` is a
  filled low-emphasis surface, so the bridge points it at
  `secondary-container` (#D5E3FC). M3's `secondary` ink (#515F74) is no longer
  reachable as a `secondary` utility; use `on-secondary-container` for text on
  that surface (4.57:1, clears AA).

There is no dark palette on this page, so the bridge deliberately rebinds
Tailwind's `dark:` variant to a class that is never set — generated `dark:`
styles stay inert rather than firing on a machine set to dark.

- **The sidebar family is bridged, minus two.** The rail below reads six
  `--sidebar-*` roles, mapped here as: the panel is `surface-container-low`
  (the `surface-subtle` § Layout & Spacing asks for), its ink
  `on-surface-variant`, its hover `surface-container-highest` on `on-surface`,
  its border `outline-variant`, its ring `primary`. `sidebar-primary` and
  `sidebar-primary-foreground` are deliberately absent — nothing reads them.
  The current nav item is *not* one of these: shadcn spends one token on both
  hover and active, so the filled blue pill comes from a wrapper class in
  `space-shell.tsx` (`primary-container` / `on-primary-container`).
