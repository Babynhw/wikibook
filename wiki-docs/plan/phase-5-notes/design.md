---
title: Phase 5 — Design
kind: plan
status: done
created: 2026-08-15
updated: 2026-08-15
tags: [phase-5, design, notes, saved-answers, concurrency]
---

# Design: Phase 5 — Notes & saved answers

**No migration.** `Note`, its two `@unique` columns, and `Activity` have been
in the schema since Phase 0 (`backend/prisma/schema.prisma:256`). The design
risk lives elsewhere: in *uniqueness under concurrency*, in *snapshot
independence*, and in an honest read-only surface for archived spaces.

## API surface

All routes sit behind `requireUser`; note routes register
`assertOwnership('note', 'id')` and the space routes `assertOwnership('space',
'id')`, both resolving the owner through `space.ownerId` and answering 404 —
never 403 — for foreign resources (PRD §17).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/messages/:id/save-as-note` | Save an assistant answer as a note (§10) |
| `GET` | `/spaces/:id/notes` | List, newest-updated first; `?q=` title filter |
| `POST` | `/spaces/:id/notes` | Create a manual note |
| `GET` | `/notes/:id` | One note with citations and converted source |
| `PATCH` | `/notes/:id` | Title and/or `contentRich` |
| `DELETE` | `/notes/:id` | 204; allowed in an archived space (not a trap) |
| `POST` | `/notes/:id/convert-to-source` | Snapshot the note into a manual source (§12) |

Every write route carries `config: writeRateLimit` — including DELETE. A route
without it has no ceiling at all (`@fastify/rate-limit` is `global: false`),
and `backend/README.md`'s per-route-options warning is exactly why.

`GET /conversations/:id` additionally answers `savedNoteId` per message, so
"Saved to notes" is server truth rather than component state.

## Decisions

### Uniqueness pre-checks are advisory — catch the constraint (decided 2026-08-15)

Both save-as-note and convert-to-source read-then-write against a `@unique`
column. The pre-check is a fast path for the common case, not the guard:
under a genuine double-click race both requests pass it and the loser hits
`P2002`. Per `backend/CLAUDE.md`'s non-negotiable, the catch answers
*identically* to the pre-check — save-as-note answers 409 `note_already_saved`,
convert answers 200 with the existing source, exactly as its idempotent branch
does. A differing response under concurrency is an existence oracle, and a 500
breaks the client that was written to handle 409.

### The failed predecessor is reused, not deleted (decided 2026-08-15)

Retrying a failed conversion updates the `failed` source row back to
`processing` with the new title, author, and text — the same way
`/sources/:id/retry` works. Deleting it would cascade away any citations that
reference the source (PRD §6/§10), and the source id is the identity a passage
or citation points at. Because no row is created or destroyed, the retry is
net-neutral on `sources_per_space`, so a retry sitting at exactly the cap is
allowed without a limit check.

### Idempotent re-convert is 200, not 201 (decided 2026-08-15)

Returning 201 for a source this request did not create lies about what
happened. The first conversion is 201; the replay and the lost-race answer
are 200 with the same body.

### The document walk is the only depth bound on `contentRich` (decided 2026-08-15)

Create and update accept `contentRich` as `z.record(z.string(), z.unknown())` —
loose JSON, so the editor can carry a ProseMirror document without the schema
needing to know its grammar. That freedom means a note nested tens of
thousands of levels deep fits in the 1 MB body limit, and an unbounded
recursive walk over it is a stack overflow answered as 500. `extractPlainText`
bounds its walk at depth 100 and answers 400 `note_too_deep` instead (PRD §16).

### Search goes through the list route, not the client (decided 2026-08-15)

`GET /spaces/:id/notes` implements `?q=` — a case-insensitive title filter —
and the client asks for it, debounced 250 ms, exactly as Phase 3's source
search does. A client-side filter over the full list is both a dead server
branch and a page that degrades as the space grows; the two got picked
together. `placeholderData: previous` keeps the old list on screen while the
next keystroke's query resolves (PRD §16) — the same reason `useSources`
carries it, and without it the search input unmounts mid-typing.

### The viewer is a complementary region, not a modal (decided 2026-08-15)

A side drawer declared `role="dialog" aria-modal="true"` without a focus trap,
an Escape handler, or focus restore promises behavior it does not implement —
worse than not claiming it (PRD §18). The viewer is `role="complementary"`
labelled by the note's title; modal behavior belongs to the page's three real
dialogs (create / convert / delete), which use the `Dialog` component.

### The editor round-trips paragraph structure (decided 2026-08-15)

The viewer edits plain text. The text walk emits `\n\n` between paragraph,
heading, and blockquote blocks; on save the text is split on blank lines and
rebuilt as one paragraph per run. Flattening the whole document into a single
paragraph on the first save would be irreversible data loss on a routine
action — that was the review's sharpest bug.

### Archived spaces: the UI withholds, the API still deletes (decided 2026-08-15)

The banner says "Notes are read-only until you restore the space", so the
client offers no New note, Edit, Convert, or Delete affordance when the space
is archived — the claim and the buttons now agree. The API deliberately keeps
`DELETE /notes/:id` open in an archived space, matching the sources rule
([[../../specs/spaces/spec]] REQ-100's companion behavior): archiving is
reversible and must not be a trap.

### `enqueueOrFail` returns nothing (decided 2026-08-15)

When the queue rejects the job, the source is written `failed` with a
plain-language message and a `source.failed` activity — the response still
answers 201 carrying that state. The boolean it used to return was never read
at the one call site; the write is the answer.

### Three text walkers, one shared (decided 2026-08-15)

The ProseMirror text walk existed in three copies with three different join
rules. The frontend pair (card snippet, viewer text) share
`frontend/src/features/notes/doc-text.ts`, parameterized on the separators.
The backend copy in `extractPlainText` stays separate *on purpose* — it
decides what text is indexed for retrieval — and its doc comment says so.

