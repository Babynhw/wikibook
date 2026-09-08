---
title: Spaces — spec
kind: spec
status: current
sources:
  - PRD §3 (resume last-opened), §4 (research spaces), §15 (activity), §16 (empty states), §17 (ownership), §20 (exclusions)
  - backend/src/routes/spaces.ts
  - backend/src/middleware/assert-access.ts
  - frontend/src/features/spaces/
  - frontend/src/routes/home-page.tsx, frontend/src/routes/space-page.tsx
  - frontend/src/components/space-shell.tsx
created: 2026-08-11
updated: 2026-08-28
tags: [spaces, archive, spec]
---

# Spec: Research spaces

Behavior of creating, editing, listing, archiving, and opening a research
space, written from the implementation verified at the end of
[[../../plan/phase-1-spaces/tasks|Phase 1]].

Keywords per RFC 2119. Requirement ids are stable and globally unique across
specs; new requirements append. Ownership, sessions, and the error envelope are
specified once in [[../auth/spec]] and are not restated here.

## Scope

Covers the `Space` resource and the workspace shell's new-space state. Does
**not** cover sources, conversations, notes, or the notebook's contents — each
gets its own spec as its phase lands. Space deletion is deliberately absent:
PRD §4 requires archive and restore and never mentions deleting a space.

## Creating and editing

### REQ-055 — A space is created from a required name and an optional objective

The system MUST create a space owned by the signed-in user from a name of 1–120
characters after trimming, and MUST accept an optional research objective of at
most 2000 characters. A blank or whitespace-only objective MUST be stored as
"not set" (`null`), not as an empty string.

- GIVEN a signed-in user
- WHEN `POST /spaces` is called with `{ name: "  Sleep and memory  " }`
- THEN the response is 201 with the space, `name` trimmed and `objective` null.

A name that is empty after trimming MUST be rejected with 400
`validation_failed` and a field-level message.

### REQ-056 — Creating a space records an activity entry

Creating a space MUST write an `Activity` row with kind `space.created` for the
owner, in the same transaction as the space, so PRD §15's feed has history from
before the feed itself exists.

### REQ-057 — Name and objective edits persist

The system MUST allow renaming a space and editing its research objective,
together or one at a time, and a field that is not sent MUST be left unchanged.
A request that changes neither MUST be rejected with 400 carrying a field-level
message, like any other validation failure — a 400 that names nothing to fix is
not actionable (PRD §16).

- GIVEN an active space
- WHEN `PATCH /spaces/:id` is called with a new name and objective
- THEN a subsequent `GET /spaces/:id` returns the new values.

Sending a blank objective is how the client clears one: it is stored as "not
set" (`null`), consistent with REQ-055.

### REQ-058 — Space limits are input-shape validation, not configurable limits

The name and objective bounds MUST live in the route schema. Phase 1 introduces
no `AppConfig` key, and any future limit on spaces (for example a per-user cap)
MUST be read through `loadLimits()` rather than hard-coded (PRD §5).

## Listing and last-opened

### REQ-059 — Active spaces are listed most-recently-opened first

`GET /spaces` MUST default to the active filter and MUST order results by
`lastOpenedAt` descending with never-opened spaces last, then by creation date
descending. The first entry is therefore the space a returning user resumes
(PRD §3).

> [!note] Shared spaces v1 (2026-08-28)
> The list is every space the caller is a *member* of, ordered by the caller's
> own `SpaceMember.lastOpenedAt`; `Space.lastOpenedAt` was dropped. Each row
> gains `myRole`, `ownerName`, `memberCount` ([[../sharing/spec]] REQ-298–REQ-299).

### REQ-060 — The archived list is a separate, explicit filter

`GET /spaces?filter=archived` MUST return exactly the user's archived spaces,
and the active list MUST exclude them.

### REQ-061 — A listed space carries its source and note counts

Each space in a list or detail response MUST include `sourceCount` and
`noteCount`, the number of sources and notes attached to it (PRD §15's home
screen).

### REQ-062 — Reading a space does not change its position

`GET /spaces/:id` MUST NOT modify `lastOpenedAt`. Only `POST /spaces/:id/open`
stamps it.

> Rationale, because it looks like an omission: the SPA refetches a space on
> window focus and on cache invalidation, and a stamping read would silently
> reorder the user's space list on every one of those.

### REQ-063 — Opening a space stamps last-opened

`POST /spaces/:id/open` MUST set `lastOpenedAt` to the current time and return
the updated space.

> [!note] Shared spaces v1 (2026-08-28)
> The stamp lands on the caller's membership row, so another member opening the
> space does not move it in my list ([[../sharing/spec]] REQ-298).

## Archiving

### REQ-064 — Archiving is reversible and destroys nothing

`POST /spaces/:id/archive` MUST mark the space archived and MUST NOT delete or
modify its sources, notes, conversations, or notebook. `POST /spaces/:id/restore`
MUST clear the archived state, and every attached record MUST still be present
and unchanged afterwards (PRD §4).

- GIVEN an archived space that had a source and a note
- WHEN it is restored
- THEN both records still exist and the space reports the same counts.

### REQ-065 — An archived space is read-only until restored

While a space is archived, requests that write to it MUST fail with 409 and code
`space_archived` and a message telling the user to restore it. `GET` requests
and `POST /spaces/:id/restore` MUST continue to succeed.

> [!note] Shared spaces v1 (2026-08-28)
> Archive and restore are owner-only (403 for an editor); a viewer never writes.
> Editing name and objective is editor-level ([[../sharing/spec]] REQ-291).

This applies to `PATCH /spaces/:id` and `POST /spaces/:id/open` today, and MUST
be extended to writes introduced by later phases: an archived space is the
space-level counterpart of the rule that archived sources never reach retrieval
(PRD §6/§9/§17).

The check MUST be part of the write itself rather than a read followed by a
write, so that a space archived between the two cannot still be written to.

### REQ-066 — Archive and restore are idempotent

Archiving an already-archived space, or restoring an active one, MUST answer 200
with the unchanged space rather than an error.

## Ownership and access

### REQ-067 — Every space route is ownership-scoped

Every `/spaces/:id` route MUST register `assertOwnership('space', 'id')`, and a
space belonging to another user MUST answer 404 — never 403 — on every method.
`GET /spaces` MUST return only the caller's own spaces (PRD §17, [[../auth/spec]]
REQ-030+).

> [!note] Shared spaces v1 (2026-08-28)
> "Ownership-scoped" now reads "access-scoped": membership, with the role the
> route declares ([[../sharing/spec]] REQ-283–REQ-284).

### REQ-068 — Authentication is checked before request validation

An unauthenticated request MUST answer 401 regardless of whether its body would
also fail validation. Authentication runs in `onRequest`, ahead of Fastify's
body validation.

- GIVEN no session
- WHEN `PATCH /spaces/:id` is called with an empty body
- THEN the response is 401, not the 400 the schema would produce.

### REQ-078 — Space writes are rate-limited

Every route that writes a space — create, edit, open, archive, restore — MUST
register a rate limit. The limiter is registered with `global: false`, so a
route without its own `config.rateLimit` has no ceiling at all, and a signed-in
client could grow the table (and its activity rows) without bound.

This is a ceiling on request rate, not a limit on how many spaces a user may
have: no such limit exists, and if one is ever wanted it is an `AppConfig` key
read through `loadLimits()` (REQ-058, PRD §5).

> [!note] Reads are not yet limited, and lists are not paginated
> `GET /spaces` returns every space the user owns. That is sound while a user's
> spaces are created by hand one at a time, and the write limit above is what
> keeps it that way. Pagination changes the response shape, so it belongs to
> whichever phase first has a reason to page — its own proposal, not a quiet
> addition here.

## The notebook relationship

### REQ-069 — A space's notebook is created lazily

Creating a space MUST NOT create its `Notebook` row. A space has at most one
notebook, enforced by the unique constraint on `Notebook.spaceId`; the row is
created on first access to the notebook (Phase 6, via `upsert`), and its absence
MUST be rendered as the blank notebook PRD §4 requires.

## Client behavior

### REQ-070 — The no-spaces state explains and offers the action

With no spaces, the home screen MUST explain what a space is and offer the
create action rather than showing an empty list (PRD §16). The archived list
MUST have its own empty state saying archiving is reversible.

### REQ-071 — A new space shows every region of PRD §4's new-space state

Opening a space MUST render an empty source library, an empty assistant
(conversation) area, an empty note collection, a blank notebook, an Add Source
action, and the prompt that evidence sources are required before the assistant
can give grounded answers.

> [!note] Add Source is present but inert until Phase 2
> §4 requires the action to exist in the new-space state; ingestion does not
> exist yet, so it renders disabled with a hint rather than failing on click.

### REQ-072 — The most recently opened space is marked, not forced

The home screen MUST mark the most recently opened active space as the one to
resume, and MUST NOT redirect to it automatically — the space list and the
create action stay reachable (PRD §3).

### REQ-073 — A failed action explains itself and keeps what was typed

A create or edit that fails MUST keep the dialog open with the entered values
intact and render the message beside the field it belongs to (PRD §16).

Every other space action MUST report its failure too, including the ones with no
dialog to report into: a failed restore MUST render its message on the card or
banner it was triggered from. Doing nothing visible is indistinguishable from
having done nothing.

### REQ-074 — Dialogs are keyboard- and screen-reader-usable

Every dialog MUST expose `role="dialog"` with `aria-modal` and an accessible
name, move focus into itself on open, keep Tab inside it, close on Escape and on
a backdrop click, and return focus to the trigger on close (PRD §18).

Focus MUST move only when the dialog opens and closes. A re-render while it is
open — a list refetch, a mutation settling — MUST NOT move focus, or a user
typing in the second field is returned to the first mid-word.

### REQ-079 — The active/archived filter is a complete tab widget

The filter MUST be operable from the keyboard as a tablist: the selected tab is
the single tab stop, the arrow keys move between tabs and wrap, and each tab
points at the list it controls with `aria-controls` against a `role="tabpanel"`
(PRD §18). A `role="tab"` without those is a promise to a screen-reader user
that the page does not keep.

### REQ-075 — Archiving asks first and says nothing is deleted

The archive action MUST ask for confirmation, and the confirmation MUST state
that the space's sources, notes, conversations, and notebook are kept.

### REQ-076 — An archived space opened directly is read-only with a way out

Navigating to an archived space MUST render a banner saying it is archived and
read-only with nothing deleted, offer Restore, and MUST NOT call the open
endpoint (which would answer 409).

### REQ-077 — An unknown or foreign space explains itself

A 404 from `GET /spaces/:id` MUST render a "we could not find that space" state
with a link back to the space list, not a redirect loop or a raw error.

### REQ-237 — The space rail offers Add source wherever the space is writable

The space rail (`SpaceRail`) MUST offer an **Add source** control on every
space route — library, reader, assistant, notes — that opens the same
add-source dialog the library page uses. It MUST NOT offer it for an archived
space (adding answers 409; see REQ-065/REQ-076) nor before the space has
loaded, and the collapsed icon rail hides it. The library page keeps its own
control; the two share one dialog component, and a source added from the rail
is in the library list when it is next shown.

## Audience & style

Added by [[../../plan/space-audience-style/proposal]]. What the assistant does
with this note is [[../assistant/spec]] REQ-308–REQ-312; here it is a space field.

### REQ-313 — The owner writes it, every member reads it

`Space.audienceInstruction` MUST be settable only through
`PUT /spaces/:id/audience`, declaring `owner`: an editor is answered 403 and a
non-member 404. It MUST appear on every space payload for **every** role — a
member should be able to read what is shaping the answers they are given.

> It is its own route rather than a field on `PATCH /spaces/:id`, which declares
> `editor`. A stricter check inside that shared handler would be invisible to the
> route-table test that proves the rule from the declared role.

### REQ-314 — Blank is unset, and the cap is configurable

The value MUST be trimmed; empty or whitespace-only MUST store null rather than a
blank string. Its length MUST be checked against the `AppConfig` key
`audience_instruction_max_chars` (default 300) read at request time, and a longer
note refused with 400 naming the limit. The payload MUST carry that number so the
editor can count characters without a second request.

> Unlike a space's name (120) and objective (2000), which are deliberately
> constants, this cap does enforcement work: it is the only control on the note
> that does not depend on the model cooperating, so a deployment must be able to
> tighten it.

### REQ-315 — It is not an access control, and the UI says so

The owner's editor MUST state that the note shapes how the assistant writes and
does **not** limit what members can read. Setting it in an archived space MUST be
refused with the existing 409 `space_archived` (REQ-065).

> Not a copy preference. Every member can already open every source in the
> reader, the notebook, and the export, so a note read as a content restriction
> would change who an owner invites on a false premise. The plan declines the
> protection use outright; the control for it is a separate space with different
> sources.

## Verification

Verified 2026-08-11 against the running stack (Postgres via docker compose, API
on `:4000`, SPA on `:5173`), and re-verified 2026-08-11 after the code review
below.

Backend — 8 tests in `backend/test/spaces.test.ts` (suite total 29 → 37):
creation and validation (REQ-055) with the activity row (REQ-056), edit
persistence including one-field-at-a-time and clearing an objective plus the
field message on the change-nothing 400 (REQ-057), ordering plus the
read-does-not-stamp rule (REQ-059/062/063), archive/restore with a seeded source
and note surviving (REQ-064) and the counts they produce (REQ-061), the
frozen-space 409, idempotency, and the absence of any activity row beyond the
create (REQ-065/066, REQ-056), 404-for-foreign and 401-for-anonymous across all
five `:id` routes (REQ-067/068), and the absence of a notebook row (REQ-069).

By hand through the API: register → create → open → list → archive → active list
empty → `PATCH` answering `space_archived` → restore → anonymous list 401.

Frontend — 25 tests across `home-page.test.tsx`, `space-page.test.tsx`,
`features/spaces/space-list.test.tsx`, `components/ui/dialog.test.tsx`, and the
`TextareaField` half of `components/ui/field.test.tsx` (suite total 38 → 63):
empty state and create round-trip (REQ-070), field-level failure preserving
input and the reported restore failures on both the card and the banner
(REQ-073), active/archived switching and its arrow-key tab behavior
(REQ-060/079), the whole dialog contract — name, initial focus, Tab and
Shift+Tab wrapping, Escape, backdrop press versus panel press, focus restore,
and focus surviving a parent re-render (REQ-074) — the resume marker (REQ-072),
the archive confirmation copy (REQ-075), the full new-space state with a
disabled Add Source (REQ-071), the archived banner with no open call (REQ-076),
and the not-found and retryable-failure states (REQ-077).

Re-verified 2026-08-27 for REQ-237 ([[../../plan/space-sidebar-wireframe-parity/tasks]]):
`space-shell.test.tsx` opens the dialog from the assistant route and closes it
with Escape, withholds the control for an archived and for an unloaded space,
and checks the collapsed-hidden utility; `space-page.test.tsx`'s REQ-076 case
now also proves the rail withholds it on the archived page. jsdom only — the
browser was not available.

Five behaviors were mutation-checked, each making exactly the intended test
fail: removing the archived guard before `open` and making `GET /spaces/:id`
stamp `lastOpenedAt` (REQ-062/076, from the original pass), then dropping the
`path` from the change-nothing refine (REQ-057), removing the `archivedAt` guard
from the `open` write (REQ-065), and removing the restore error alert from the
space card (REQ-073). The dialog focus rule in REQ-074 was checked the same way
by restoring `onClose` to the focus effect's dependencies.

> [!note] The visual pass was human, not automated
> The Chrome extension was not connected, so the screens were exercised through
> jsdom tests and the API by hand rather than by the agent looking at them. The
> user reviewed the rendered pages on 2026-08-11 and accepted them. Layout and
> visual-token adherence therefore rest on that one review: nothing in the suite
> would catch a token regression.

Not covered by an automated test: REQ-058 (a negative — no `AppConfig` key
exists to assert on); REQ-071's exact copy, which is asserted by region heading
rather than word for word; and REQ-078, where a test would have to spend 60
requests to observe the ceiling and would then poison the limiter for the rest
of the file — the registration to which every space test is a client is itself
capped at 10 per minute, which is what `registerUser` now fails loudly about.

> [!warning] The 409 on a concurrent archive is reasoned, not observed
> REQ-065's "the check is part of the write" is verified only in its ordinary
> form (archive, then `PATCH` → 409). The race it exists to close — an archive
> landing between a handler's read and its write — is not reproduced by a test;
> it rests on the write carrying `archivedAt: null` in its own filter.

## Cross-references

- [[../../plan/phase-1-spaces/proposal]] · [[../../plan/phase-1-spaces/design]] ·
  [[../../plan/phase-1-spaces/tasks]]
- [[../auth/spec]] — sessions, ownership, and the error envelope these routes rely on.
- [[../../wireframe/index]] — layout reference; its statuses, tags, and trash are §20 exclusions.
