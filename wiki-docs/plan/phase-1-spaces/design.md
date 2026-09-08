---
title: Phase 1 — Design
kind: plan
status: done
created: 2026-08-11
updated: 2026-08-11
tags: [phase-1, design, spaces]
---

# Design: Phase 1 — Research spaces

The `Space` model already exists from Phase 0 and needs no migration:

```prisma
model Space {
  id           String    @id @default(cuid())
  ownerId      String
  name         String
  objective    String?
  archivedAt   DateTime?
  lastOpenedAt DateTime?
  ...
  notebook      Notebook?   // optional — see "Notebook is lazy-created"
  @@index([ownerId])
}
```

`backend/prisma/schema.prisma:86`. Phase 1 is therefore a behavior
change, not a schema change — as intended when the whole domain model
was defined up front ([[../phase-0-foundation/design]]).

## API surface

All routes sit behind `requireUser`; every `:id` route also registers
`assertOwnership('space', 'id')`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/spaces?filter=active\|archived` | List, default `active` |
| `POST` | `/spaces` | Create (`name` required, `objective` optional) |
| `GET` | `/spaces/:id` | One space |
| `PATCH` | `/spaces/:id` | Rename and/or edit objective |
| `POST` | `/spaces/:id/open` | Stamp `lastOpenedAt`, return the space |
| `POST` | `/spaces/:id/archive` | Set `archivedAt` |
| `POST` | `/spaces/:id/restore` | Clear `archivedAt` |

No `DELETE` — see the proposal's out-of-scope list.

Responses carry `sourceCount` and `noteCount` from Prisma `_count`. Both
are zero for the whole phase, but §15's home screen needs them and
adding a field later means touching every client caller; the query cost
is one join on a list that is small by construction.

### Why `POST /:id/open` and not a side effect of `GET /:id`

`GET` must stay safe and idempotent: the frontend refetches a space on
focus, on cache invalidation, and on navigation, and every one of those
would reorder the user's space list if the read stamped
`lastOpenedAt`. The stamp is an explicit user act — it fires once when a
space is actually opened.

## Decisions

### Notebook is lazy-created (decided 2026-08-11)

PRD §2 says each space has exactly one notebook, and §4's new-space
state requires a *blank notebook document*. Two ways to honor that:
create the `Notebook` row inside the create-space transaction, or create
it on first access.

**Chosen: lazy.** `POST /spaces` writes only the `Space`. The notebook
row appears on the first `GET /spaces/:id/notebook` (Phase 6), via an
`upsert` on the unique `spaceId`, which is idempotent under concurrency.

Rationale:

- The schema already models the relation as optional (`Notebook?`), so
  absence is a representable, legal state — nothing to migrate.
- "Blank notebook" is a *rendering* requirement, not a storage one. A
  space with no notebook row renders exactly the same empty document as
  one with an empty row; a user who never opens the notebook never
  needs the row.
- Eager creation would make Phase 1 write a `contentRich` document
  shape that Phase 6's Tiptap schema has not been designed yet. Writing
  rows in a format we would then have to migrate is worse than not
  writing them.
- The one-notebook-per-space invariant is enforced by the
  `@unique` on `Notebook.spaceId`, not by creation timing.

The cost: any code reading a notebook must handle `null`. That is one
`upsert` in one Phase 6 route, and it is written down here so it is not
rediscovered as a bug.

### Archived spaces are frozen

PRD §4 requires only that archived spaces leave the active list and that
restore returns content unchanged. It does not say whether an archived
space accepts writes. Phase 1 decides: **an archived space is read-only
until restored.** `PATCH`, `/open`, and (in later phases) any write to a
space's sources, conversations, notes, or notebook answer `409` with a
plain-language "This space is archived. Restore it to make changes."

Rationale: archived is the space-level analogue of the retrieval
invariant — archived sources never reach retrieval (PRD §6/§9/§17), so
an archived *space* must not accumulate new evidence or answers either.
Deciding it now means later phases inherit one rule instead of each
inventing its own. `/restore` and reads are always allowed, so the state
is never a trap.

### Last-opened resume: sort, don't redirect

PRD §3 requires that a returning user *can* resume their most recently
opened space. Auto-redirecting `/` to that space would make the space
list unreachable for anyone with one space and hide the create action.

Instead: `GET /spaces` orders by `lastOpenedAt DESC NULLS LAST,
createdAt DESC`, the home screen shows the top entry as a primary
**Resume** card, and no separate `User.lastOpenedSpaceId` column is
introduced — the ordering already carries the information, and a
denormalized pointer would be a second source of truth to keep in sync
on archive.

### Validation belongs to the route, not to `AppConfig`

`name` is trimmed, required, 1–120 chars; `objective` is optional,
≤ 2000 chars. These are input-shape constraints, not the
operator-tunable limits of PRD §5 (`pdf_max_bytes`, `pdf_max_pages`,
`manual_max_chars`, `sources_per_space`) — they exist to keep a UI from
being broken by a 10 MB title, and there is no product requirement to
tune them per deployment. They live in the zod schema. Phase 1
introduces **no** new `AppConfig` key; if a spaces-per-user cap is ever
wanted, it becomes an `AppConfig` key and is read via `loadLimits()`,
never a constant.

### Activity rows are written now, the feed comes in Phase 7

`POST /spaces` also writes `Activity { kind: 'space.created', spaceId,
userId }` in the same transaction as the space. §15's feed is Phase 7
work, but a feed that only knows about events since Phase 7 shipped is
a feed with a hole in it. Kind strings are namespaced `<entity>.<verb>`
so later phases extend the vocabulary without renaming.

Archive and restore do **not** write activity rows: §15's list is
explicit about which events belong in the feed, and neither is on it.

## Frontend

### Routes

```
/                      home — space list (active + archived toggle), create
/spaces/:id            workspace shell (new-space empty states)
```

`frontend/src/app.tsx:18` currently mounts only `/` behind
`RequireAuth`; `/spaces/:id` joins it inside the same guard. An unknown
space id renders the 404 state rather than redirecting, so a stale
bookmark explains itself.

### Structure

Following `frontend/README.md`'s feature-folder convention:

```
src/features/spaces/
  use-spaces.ts        TanStack Query hooks (list, one, mutations)
  space-list.tsx       cards + resume card + archived toggle
  create-space-dialog.tsx
  rename-space-dialog.tsx
  archive-controls.tsx
src/routes/space-page.tsx    the workspace shell
```

Mutations invalidate the `['spaces']` key; create and archive/restore
are optimistic only where a failure is trivially revertible — the
create dialog stays open and keeps its input on failure (PRD §16, and
the rule already stated in `frontend/CLAUDE.md`).

### The new-space state (PRD §4)

The space shell renders four empty regions — source library,
conversation, notes, notebook — plus the Add Source action and the
prompt that evidence sources are required before the assistant can give
grounded answers. Add Source is rendered **disabled with a hint** until
Phase 2: §4 requires the action to be present in the new-space state,
and a button that 404s is worse than one that explains itself.

Layout reference is the `source_library` mockup's sidebar + content
frame ([[../../wireframe/index]]) — layout only, expressed with the
tokens in `frontend/src/index.css`. Its reading statuses, tags, trash,
and cross-space search are §20 exclusions and are not built.

## Testing

- **Backend** (`backend/test/spaces.test.ts`): create validation,
  ownership 404 for a foreign space, 401 unauthenticated, archive
  removes from the active list, restore preserves attached rows
  (seed a `Source` and a `Note` directly through Prisma), frozen-space
  409, `open` ordering, and that `GET /spaces/:id` does not move
  `lastOpenedAt`.
- **Frontend** (Vitest + Testing Library, `fetch` stubbed as in
  `frontend/src/lib/api.test.ts`): create dialog preserves input on
  failure, empty state renders every §4 region, archived toggle, and
  the resume card picks the most recently opened space.

## Cross-references

- [[proposal]] — scope and acceptance criteria.
- [[tasks]] — work breakdown.
- [[../phase-0-foundation/design]] — schema, `assertOwnership`, limits.
- [[../../specs/auth/spec]] — session and ownership requirements.
- [[../../wireframe/index]] — layout reference and out-of-scope list.
