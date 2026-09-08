# CLAUDE.md — frontend

Conventions, layout, and scripts: [README.md](README.md).
Design tokens and visual language: [DESIGN.md](DESIGN.md).
Screen layouts: [`wiki-docs/wireframe/index.md`](../wiki-docs/wireframe/index.md)
— sample designs per screen. Layout reference only; the index lists which parts
are out of MVP scope, and its markup must not be copied (it is Tailwind v3 CDN).

The non-negotiables:

- All API access goes through `src/lib/api.ts`; handle failures as `ApiError`.
- A failed submit keeps what the user typed, and errors render next to their field (PRD §16).
- Labels are real `<label>` elements; forms stay keyboard- and screen-reader-usable (PRD §18).
- Use theme tokens from `src/index.css`, never literal hex values.
- shadcn components are **added on demand** (`pnpm dlx shadcn@latest add <name>`)
  and committed exactly as generated. Never hand-edit a generated file: if it
  renders in the wrong colour, the bridge in `src/index.css` is what to fix.
  Nothing unused lands in `src/components/ui/`. `button`, `card`, `field`,
  `alert`, and `dialog` are hand-written and stay that way.
- Session, form, and `api.ts` behavior is specced in
  [`wiki-docs/specs/auth/spec.md`](../wiki-docs/specs/auth/spec.md); changes there
  come with a test naming the REQ. `pnpm test` needs no backend.
