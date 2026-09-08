---
title: Phase 5 — Tasks
kind: plan
status: done
created: 2026-08-15
updated: 2026-08-15
tags: [phase-5, tasks, notes, saved-answers]
---

# Tasks: Phase 5 — Notes & saved answers

Backend first, routes before screens: the note routes define the contract the
UI renders against, and the convert route reuses the pipeline Phase 2 owns.
No schema task — Phase 0 wrote `Note` with both `@unique` columns
([[design]] "No migration").

## Backend (`backend/`)

### T1 — Save an answer as a note (PRD §10)

- [x] `POST /messages/:id/save-as-note` — 201 with the note; copies the
      answer's citations with their locators; title defaults from the
      preceding user question (≤ 80 chars, `...` ellipsis past it), falling
      back to "Saved answer"; the question recorded as `contentRich.question`
- [x] 400 `not_an_assistant_message` on a user-role message; 409
      `space_archived` in an archived space; 409 `note_already_saved` on a
      repeat save — including the concurrent double-click: the `P2002` from
      `originMessageId @unique` answers identically to the pre-check
      ([[design]] "Uniqueness pre-checks are advisory")
- [x] Note and `note.saved_answer` activity written in **one** transaction
- [x] `GET /conversations/:id` answers `savedNoteId` per message, from the
      `note` relation — the client's saved state derives from it

### T2 — Notes CRUD and search (PRD §11)

- [x] `GET /spaces/:id/notes` — newest-updated first, citations +
      `convertedSource` summary, `?q=` case-insensitive title filter
- [x] `POST /spaces/:id/notes` — title 1–200 trimmed, `contentRich` optional
      loose JSON; `note.created` activity in the same transaction
- [x] `GET /notes/:id`, `PATCH /notes/:id`, `DELETE /notes/:id` (204 +
      `note.deleted` activity); every write route carries
      `config: writeRateLimit`, including DELETE
- [x] `assertOwnership` gains the `note` resolver; foreign notes are 404s
      ([[../../specs/spaces/spec]] REQ-070 precedent)

### T3 — Convert to source (PRD §12)

- [x] `POST /notes/:id/convert-to-source` — a manual source snapshot
      (`processing`, `originNoteId`, author `User note` / `AI-assisted note`,
      title ≤ 200), enqueued into the Phase 2 pipeline; `source.added`
      activity in the same transaction as the source
- [x] Snapshot independence: editing the note afterwards does not touch the
      source (asserted in the idempotency test)
- [x] Idempotent re-convert answers **200** with the existing source; the
      concurrent-race `P2002` on `originNoteId` answers the same way
- [x] A failed conversion is **reused, not deleted** (the row is reset to
      `processing` with the new snapshot text, as `/sources/:id/retry` does) —
      a delete would cascade away citations referencing it (PRD §6/§10), and
      being net-neutral it works at exactly `sources_per_space`
- [x] 400 `empty_note_content` / `manual_too_long` (field-level, from
      `loadLimits()`) / `note_too_deep`; 409 `sources_limit` /
      `space_archived`
- [x] `extractPlainText` bounds its walk at depth 100 — the only bound on the
      loose-JSON document ([[design]] "The document walk")
- [x] Queue rejection lands the source `failed` with a plain-language message
      (`enqueueOrFail` returns nothing)

## Frontend (`frontend/`)

### T4 — Notes screen and components

- [x] `src/routes/notes-page.tsx` behind `/spaces/:spaceId/notes`, wired into
      the space rail's Notes item; `?noteId=` deep link to the open note
- [x] `features/notes/`: `note-list`, `note-card` (origin badge, citation
      count, snippet, Convert/Delete/Open), `note-viewer` (side drawer),
      `create-note-dialog`, `convert-note-dialog`, `delete-note-dialog`,
      `use-notes`
- [x] Server-side search: `useNotes(spaceId, q)` with a 250 ms debounce and
      `placeholderData: previous`; no client-side filter
- [x] `doc-text.ts` — the one frontend copy of the document text walk
      ([[design]] "Three text walkers")
- [x] Viewer reseeds its editor on **note identity change only** — a
      background refetch of the same note never discards an in-progress edit
- [x] Saving an edit rebuilds paragraphs from blank-line runs — a save never
      flattens a multi-paragraph note
- [x] Viewer is `role="complementary"`, not a hand-rolled modal ([[design]]
      "The viewer is a complementary region")
- [x] Archived space: banner plus every write affordance withheld — New note,
      Edit, Convert, Delete, on cards and in the viewer

### T5 — Save-as-note affordance

- [x] `answer-message.tsx` derives "Saved to notes" from
      `message.savedNoteId`; on success the conversation cache is patched with
      the new note id, on 409 the conversation refetches for the server's
      truth
- [x] Every other save failure surfaces as an `Alert` — no error is swallowed

## Exit criteria

- [x] Backend: `pnpm --filter backend lint` clean; `vitest run
      test/notes.test.ts` green — 15 tests: CRUD, saved-answer flow, the
      dedicated `not_an_assistant_message`, `note_too_deep`, both concurrency
      races, idempotent re-convert and snapshot independence, the reuse-and-
      citation-survival retry at `sources_per_space` (REQ-219), ownership,
      archived writes/delete, citation staleness, and the queue-down path
- [x] Frontend: `pnpm --filter frontend lint` clean; full suite green —
      141 tests across 21 files including the notes page, the note-viewer
      Cancel test, the archived read-only assertions, the multi-paragraph
      edit round-trip, and the streaming-answer-save withholding
- [x] Full backend suite green against the running stack
- [x] Space-page note count reads from `space.noteCount`, not the full list

## Implementation notes (2026-08-15)

This phase was implemented without its plan folder and was caught by review
([[../../AGENTS]] "A change that touches both codebases is still one plan
folder"); these notes record what the review pass changed, so nothing here is
a mystery three phases from now.

- **Neither codebase compiled.** `FastifyInstance` was imported from
### Second review pass (2026-08-15)

The follow-up review found two real bugs the first pass shipped, both caught by
reading the code against the data model rather than by running the suites:

- **Deleting the failed converted source cascade-deleted citations (PRD
  §6/§10).** `Source` owns its `Citation`s with `onDelete: Cascade`, so
  deleting a failed predecessor could silently destroy saved-answer citations
  whose `sourceId` pointed at it. Fixed by REUSING the row the way
  `/sources/:id/retry` does — reset to `processing` with the new snapshot text
  ([[design]] "The failed predecessor is reused"). A test now forces a
  citation to reference the converted source, fails the source, fills the space
  to `sources_per_space`, and re-converts: same id, 201, citation survives.
- **"Save as note" was live on the streaming answer.** The synthetic
  `pending-answer` message had no persisted id, so the button called a route
  that cannot exist and 404'd. `AnswerMessage` gained a `canSave` flag; the
  streaming copy renders no footer action.
- The space-page's Notes region stopped calling the full notes list for a count
  — it reads `space.noteCount` instead. The list itself stays unpaginated with
  full `contentRich` at MVP scale (PRD §19 targets 50 sources); pagination is a
  phase-change, not a bug, at this volume.
- Nits the round matched: `button.tsx`'s `as Partial<unknown>` cast removed
  (React 18's `ReactElement<any>` needs no cast and keeps the prop check);
  `field.tsx` now forwards `...props` to a child element instead of silently
  dropping them; the viewer's Cancel discards the draft; `doc-text.ts` got the
  depth bound its backend twin already had; the list `?q=` and the preceding-
  question query picked up a `.max(200)` and a deterministic `id` tiebreak; a
  bad `?noteId=` now shows an alert instead of an empty page.

Verification after the pass: backend `vitest run` green against the running
stack, frontend 141/141, both `lint` clean. Browser UI still not driven.

  `fastify-type-provider-zod`, which does not export it; the dialogs passed
  `htmlFor` / `description` to a `Field` that has neither prop; two unused
  imports failed `noUnusedLocals`; the new test suite carried eight
  strict-mode errors; and `backend/test/notes.test.ts` wrote `ord` keys the
  `LocatedBlock` / `ChunkedPassage` types do not have. All fixed.
- **Both `@unique` races answered 500 under concurrency.** The `P2002` catches
  were added per `backend/CLAUDE.md` (`auth.ts`'s registration catch is the
  pattern), and `notes.test.ts` gained the two `Promise.all` races that assert
  no 500 is ever returned.
- **The editor had two data-loss bugs** ([[design]] "The editor round-trips
  paragraph structure" and the identity-keyed reseed) — the flatten-on-save is
  the reason the round-trip test exists.
- **The archived banner disagreed with the buttons.** Fixed on the UI side;
  the API still deletes notes in an archived space, matching sources
  ([[design]] "Archived spaces").
- **`?q=` was a dead server branch** until the client switched to it
  ([[design]] "Search goes through the list route"). `placeholderData` turned
  out to be load-bearing, not cosmetic: without it the search input unmounted
  while the next query resolved, and a test caught it by the detached element
  — the same detached-element lesson the space-sidebar pass recorded.
- **`DELETE /notes/:id` had no rate limit** — the one write route without a
  config block, exactly the mistake `backend/README.md`'s per-route-options
  warning describes.
- **`button.tsx`'s `render` branch silently dropped every prop** but
  `className` and `children`; `field.tsx` rendered unsupported children
  unlabelled. Both are shared components, so both are now loud: the spread is
  forwarded, and a non-element child throws instead of orphaning the label.
- **A pre-existing failure surfaced:** the space rail's keyboard test still
  expected the pre-Notes tab order (Sources → Assistant → All spaces). The
  Notes item is now in it (Sources → Assistant → Notes → All spaces).
- **Not verified here:** the browser UI was not driven (no Chrome extension
  this session); the notes screen rests on its Vitest suite, as earlier
  phases' screens did.

