---
title: Phase 1 — Tasks
kind: plan
status: done
created: 2026-08-11
updated: 2026-08-11
tags: [phase-1, tasks]
---

# Tasks: Phase 1 — Research spaces

Backend first (T1–T3) so the frontend builds against real routes.
Estimated 0.5 week ([[../../README]] §6).

## Backend (`backend/`)

### T1 — Space routes

- [x] `src/routes/spaces.ts` registered in `src/app.ts`; every `:id`
      route gets `[app.requireUser, assertOwnership('space', 'id')]`
- [x] `POST /spaces` — zod: `name` trimmed 1–120 required,
      `objective` optional ≤ 2000. Writes the `Space` and a
      `space.created` `Activity` in one transaction
- [x] `GET /spaces?filter=active|archived` — default `active`;
      order `lastOpenedAt DESC NULLS LAST, createdAt DESC`; includes
      `_count` of sources and notes
- [x] `GET /spaces/:id` — read-only, does **not** touch `lastOpenedAt`
- [x] `PATCH /spaces/:id` — name and/or objective; at least one field
- [x] `POST /spaces/:id/open` — stamps `lastOpenedAt`, returns the space

### T2 — Archive / restore

- [x] `POST /spaces/:id/archive` / `POST /spaces/:id/restore` — set and
      clear `archivedAt`; no cascade, nothing deleted
- [x] Archived spaces are frozen: `PATCH` and `/open` answer `409`
      with a plain-language message ([[design]] "Archived spaces are
      frozen"); reads and `/restore` stay allowed
- [x] Re-archiving an archived space (or restoring an active one) is
      idempotent, not an error

### T3 — Backend verification (`backend/test/spaces.test.ts`)

- [x] Create: name required/trimmed, objective optional, activity row written
- [x] Ownership: another user's space → 404 on every route;
      unauthenticated → 401
- [x] Archive removes from the active list, appears under `filter=archived`
- [x] Restore returns content unchanged — seed a `Source` and a `Note`
      via Prisma before archiving, assert both survive
- [x] Frozen: `PATCH`/`open` on an archived space → 409
- [x] Ordering: `open` moves a space to the head of the active list;
      `GET /spaces/:id` does not
- [x] Verify: `pnpm --filter backend test` green, `pnpm lint` clean

## Frontend (`frontend/`)

### T4 — Space list and mutations

- [x] `src/features/spaces/use-spaces.ts` — TanStack Query hooks
      (list by filter, one, create / patch / open / archive / restore),
      all through `src/lib/api.ts`
- [x] Home (`src/routes/home-page.tsx`) becomes the space list:
      resume card for the most recently opened space, active/archived
      toggle, create action
- [x] Create and rename dialogs — real `<label>`s, focus trap, Escape to
      close; a failed submit keeps the typed values and shows the error
      next to the field (PRD §16/§18)
- [x] Archive / restore controls with confirmation copy that says
      nothing is deleted
- [x] Empty state: no spaces yet → explanation + create action (PRD §16)

### T5 — Workspace shell

- [x] Route `/spaces/:id` inside `RequireAuth` (`src/app.tsx`); calls
      `POST /spaces/:id/open` once on entry
- [x] New-space state (PRD §4): empty source library, empty conversation
      area, empty note collection, blank notebook, Add Source action,
      and the prompt that evidence sources are required before the
      assistant can answer
- [x] Add Source rendered **disabled with a hint** — present per §4,
      inert until Phase 2 ([[design]])
- [x] Unknown / foreign space id (404) renders a plain "space not
      found" state, no redirect loop
- [x] Archived space opened directly → read-only banner with Restore
- [x] Layout from the `source_library` mockup frame, tokens from
      `src/index.css`; none of its §20 extras ([[../../wireframe/index]])

### T6 — Frontend verification

- [x] Tests: create dialog preserves input on failure; §4 empty regions
      all render; archived toggle; resume card picks the most recently
      opened space
- [x] Verify: `pnpm --filter frontend test` green, `pnpm lint` clean

## Exit criteria

All acceptance criteria in [[proposal]] pass, verified by hand once
through the running app in addition to the automated tests. On
completion: mark tasks `[x]`, set frontmatter `status: done`, write
`specs/spaces/spec.md` from the behavior that was actually verified,
update [[../../index]], and append to [[../../log]].

## Implementation notes (2026-08-11)

Deviations from [[design]] and details worth carrying forward; the spec is
[[../../specs/spaces/spec]].

- **Authentication moved to `onRequest`** for these routes. Fastify validates
  the body *before* `preHandler`, so an anonymous `PATCH` with an empty body
  answered 400 (describing the schema) instead of 401. `assertOwnership` stays
  in `preHandler` — it needs the validated route params. Found by the test that
  asserts 401 on every route; auth routes still use `preHandler` and are
  unaffected because their bodies are always sent.
- **One `space-dialog.tsx`, not `create-space-dialog` + `rename-space-dialog`.**
  PRD §4 gives create and edit the same two fields, so they share a dialog that
  the parent mounts conditionally (mounting, not an `open` prop, is what resets
  the form). `archive-controls.tsx` likewise folded into `space-list.tsx`.
- **Two new primitives**: `components/ui/dialog.tsx` (hand-written focus trap,
  Escape, backdrop, focus restore — the native `<dialog>` is not implemented
  consistently in jsdom, and every one of those behaviors is asserted) and
  `TextareaField` in `components/ui/field.tsx`, which was refactored around a
  shared `FieldFrame`. `buttonVariants` is now exported so a `<Link>` can look
  like a button instead of being nested inside one.
- **`components/app-shell.tsx`** holds the header both authed screens share.
  The Phase 0 health card came off the home screen with it — it was scaffolding,
  and `GET /health` remains available.
- **Mutations invalidate `['spaces','list']`, not `['spaces']`** — the detail
  cache is written from the mutation response, so invalidating it too would
  cause a redundant refetch on every archive.
- Ports and commands unchanged from Phase 0: API `4000`, SPA `5173`.

## Review fixes (2026-08-11)

A code review of the phase before commit; everything below is in the spec as an
amended or appended REQ.

- **The `Dialog` focus effect depended on `onClose`**, which every caller passes
  as an inline arrow. Any parent re-render while a dialog was open re-ran the
  effect and pulled focus back to the first field — typing in the objective
  textarea after a list refetch put the caret back in Name. Split into two
  effects: focus keyed on `open` alone, the keydown listener reading `onClose`
  through a ref (REQ-074).
- **`components/ui/dialog.test.tsx` now exists.** The primitive's docstring
  claimed every behavior was asserted, which justified not using the native
  `<dialog>`; only Escape and focus-restore actually were. Tab wrapping both
  ways, backdrop-versus-panel press, and the focus rule above are covered now.
- **Restore reported nothing on failure** on either the card or the archived
  banner — the one action with no dialog to report into (REQ-073).
- **Archived guards moved into the write.** `PATCH` and `/open` read the space,
  checked `archivedAt`, then wrote; the write now carries `archivedAt: null` in
  its own filter and P2025 becomes the 409. Archive and restore use the same
  helper, which also makes their idempotent no-op the missed-guard branch
  (REQ-065). Costs one query less per edit, and closes the read-then-write race.
- **Space writes are rate-limited** at 60/minute. `rateLimit` is registered
  `global: false`, so these routes had no ceiling (REQ-078). Still no cap on how
  many spaces a user may own — that stays an `AppConfig` decision (REQ-058).
- **The change-nothing `PATCH` refine got a `path`.** Without one the issue is
  object-level, and the error handler builds `fields` from `instancePath`, so
  the message was dropped and the client got a 400 naming nothing (REQ-057).
- **The filter tabs became a real tablist**: roving `tabIndex`, arrow keys with
  wrap, `aria-controls` onto a `role="tabpanel"` (REQ-079).
- **`useOpenSpace` retries once.** It fires unattended on entering a space and
  is the only mutation with no error UI, deliberately — the stamp only affects
  list order.
- **`registerUser` now throws when registration returns no session cookie.**
  `/auth/register` allows 10 per minute and the limiter is in-memory per app
  instance, so the eleventh user in a file used to surface as an unrelated 401
  several requests later. Found by adding tests to this suite; the new
  assertions were folded into existing tests rather than registering more users.

> [!note] The visual pass was the user's, not the agent's
> The Chrome extension was not connected in this session, so the agent verified
> the screens through jsdom tests and the API by hand. The rendered pages were
> reviewed by the user on 2026-08-11 and accepted. No automated visual or
> token-adherence check exists — a token regression would still pass CI.

## Cross-references

- [[proposal]] · [[design]] · [[../../specs/spaces/spec]] · [[../phase-0-foundation/tasks]]
- [[../../specs/auth/spec]] — ownership rules these routes apply.
