---
title: Notes — spec
kind: spec
status: current
sources:
  - PRD §5 (limits), §10 (saved answers), §11 (notes), §12 (conversion), §16 (states), §17 (security), §18 (a11y)
  - backend/src/routes/notes.ts, backend/src/routes/conversations.ts
  - backend/src/lib/enqueue-ingest.ts
  - backend/test/notes.test.ts
  - frontend/src/features/notes/, frontend/src/routes/notes-page.tsx, frontend/src/features/assistant/answer-message.tsx
  - frontend/src/components/ui/field.tsx (the shared field contract REQ-225 leans on)
created: 2026-08-15
updated: 2026-08-28
tags: [notes, saved-answers, convert-to-source, spec]
---

# Spec: Notes & saved answers

Private working notes (PRD §11), answers saved from the assistant with their
citations (§10), and the explicit conversion of a note into a retrievable
manual source (§12). Written from the verified Phase 5 implementation
([[../../plan/phase-5-notes/proposal]]), including the changes its code-review
pass made. RFC 2119 keywords are load-bearing: MUST is a requirement, SHOULD
is a strong default.

Ownership, sessions, the error envelope, and disclosure rules are specified
once in [[../auth/spec]]; the frozen-space rule and archive semantics once in
[[../spaces/spec]] (REQ-100); the ingestion pipeline a converted note enters
in [[../ingestion/spec]].

## Scope

Covers the `Note` resource, save-as-note, note CRUD and search, and
convert-to-source. Does **not** cover: the notebook (PRD §13, Phase 6);
retrieval itself ([[../assistant/spec]]); the reader a citation opens
([[../library-reader/spec]]); the feedback route, which is the assistant's.

## Saving an answer (PRD §10)

### REQ-204 — Saving an answer creates one note carrying question, answer, and citations

`POST /messages/:id/save-as-note` MUST create a note in the message's space
with the answer's content, the citations of the message copied with their
locators (source, quoted text, page / paragraph / section, staleness), and
`originType` `saved_answer`. The title MUST default to the preceding user
question of the same conversation (truncated to 80 characters with an
ellipsis), falling back to "Saved answer", and MUST accept a caller-supplied
override. The note and its `note.saved_answer` activity MUST be written in one
transaction.

- GIVEN a conversation with an assistant answer that carries citations
- WHEN the answer is saved as a note
- THEN the note exists with `originMessageId` set to the message, its citation
  count and locators equal to the message's, and the activity row present.

### REQ-205 — One note per answer, identical under concurrency

A second save of the same answer MUST be refused 409 `note_already_saved`,
whether the duplicate is sequential or concurrent — a double-click's loser
MUST NOT answer 500. The uniqueness pre-check is advisory; the
`originMessageId @unique` constraint holds the invariant, and its violation
answers exactly as the pre-check does (backend/CLAUDE.md).

- GIVEN a message already saved as a note
- WHEN two `save-as-note` requests for it are issued concurrently
- THEN the pair answers {201, 409} and neither is a 500.

### REQ-206 — Only answers are saveable

Saving a `user`-role message MUST be refused 400 `not_an_assistant_message`.

### REQ-207 — The saved state is server truth

`GET /conversations/:id` MUST answer each message with `savedNoteId`, the id
of the note it was saved into or `null`. The client's "Saved to notes" state
MUST derive from it, so it survives a remount and a reload, and a save failure
other than `note_already_saved` MUST surface to the user as an error message.

### REQ-208 — Saving into an archived space is refused

`POST /messages/:id/save-as-note` in an archived space MUST answer 409
`space_archived` (REQ-100).

## Notes CRUD and search (PRD §11)

### REQ-209 — Notes are listed newest-updated first and searched server-side

`GET /spaces/:id/notes` MUST answer the space's notes newest-updated first,
each with its citations and a `convertedSource` summary. The optional `?q=`
MUST filter titles case-insensitively. The client MUST ask the server for a
filtered list (debounced, one request per settled query) and MUST NOT filter
the full list in memory.

### REQ-210 — A note is created with a required title and recorded activity

`POST /spaces/:id/notes` MUST require a title of 1–200 characters after
trimming and accept an optional `contentRich` JSON document. The note and its
`note.created` activity MUST be written in one transaction. Creating in an
archived space MUST answer 409 `space_archived`.

> [!note] Shared spaces v1 (2026-08-28)
> Notes carry `author` (the creator; the saver, for a saved answer) and are fully
> shared: any editor edits or deletes any note. Every note write is editor-level
> and a viewer's is 403 ([[../sharing/spec]] REQ-291, REQ-294).

### REQ-211 — Updates are partial and refuse an archived space

`PATCH /notes/:id` MUST apply only the fields sent (`title`, `contentRich`)
and MUST answer 409 `space_archived` for a note in an archived space. The
client MUST show a failed save's message beside the editor, keep the edited
title and text, and let "Save changes" retry (PRD §16).

### REQ-271 — An edit is recorded once per burst, not once per save

A `PATCH` that changes the title or the document MUST record a `note.edited`
activity for the note (PRD §15). If the newest `note.edited` row for the same
note is younger than `ACTIVITY_COALESCE_MINUTES` (env, default 10), its
`createdAt` MUST be moved to now instead of a second row being written — the
editor saves on blur and on a debounce, and one working session is one entry.
The activity write MUST happen in the same transaction as the note update: a
save that committed MUST NOT fail because its feed entry could not be written,
and two saves inside the window MUST NOT both insert.

- GIVEN a note edited a moment ago
- WHEN it is saved again inside the window
- THEN one `note.edited` row exists for it and it sorts to the top of the feed

### REQ-272 — A later edit is a new entry

A `PATCH` that changes the note after the window has passed MUST write a second
`note.edited` row rather than moving the first.

### REQ-273 — A save that changes nothing records nothing

A `PATCH` whose `title` equals the stored title and whose `contentRich` is the
stored document (compared with sorted keys — jsonb does not preserve key order)
MUST answer 200 and MUST NOT write or move any activity.

### REQ-274 — Conversion is recorded as both the note's and the source's event

The convert transaction (REQ-216) MUST write `note.converted` with the note's id
alongside the new source's `source.added` (PRD §15 lists both).

### REQ-212 — Deleting a note is recorded and allowed in an archived space

`DELETE /notes/:id` MUST answer 204, MUST write its `note.deleted` activity in
the same transaction as the delete, and MUST stay allowed in an archived space
— archiving is reversible and must not be a trap, exactly as sources behave.
A converted source MUST survive its note's deletion (`originNoteId` goes
`SetNull`).

### REQ-213 — Every note route is ownership-scoped and every write rate-limited

All note routes MUST register `assertOwnership` and answer 404 — never 403 —
for another user's note (PRD §17). Every write route, DELETE included, MUST
carry the write rate limit; a route option object is per route, never shared
(backend/README.md).

### REQ-214 — The editor round-trips paragraph structure

The client's note viewer MUST NOT flatten a note on save: text is split on
blank lines and rebuilt as one paragraph per run, so a multi-paragraph note
saved once keeps its paragraphs.

- GIVEN a note whose content has two paragraphs
- WHEN it is opened, edited, and saved
- THEN the stored document still has two paragraphs.

### REQ-215 — The editor reseeds only on note identity change

The viewer MUST NOT reset an in-progress edit when a background refetch of the
same note lands — title and content are reseeded only when a different note is
opened.

### REQ-224 — The editor never writes back a document it could not fully read

The viewer rebuilds `contentRich` from the *text* its walk extracted, so a walk
that stopped at its 100-level depth bound holds a lossy view of the document.
The walker MUST report that truncation, and the viewer MUST withhold Edit and
say why rather than offer a save that would persist the loss. This is the
frontend's half of REQ-220: the backend refuses to *convert* a document it
cannot walk; the client refuses to *overwrite* one.

- GIVEN a note nested past the depth bound
- WHEN it is opened in the viewer
- THEN the partial text is shown with an explanation, and no Edit is offered.


## Converting a note into a source (PRD §12)

### REQ-216 — Conversion creates an independent manual-source snapshot

`POST /notes/:id/convert-to-source` MUST create a `manual` source in the
note's space whose content is the note's plain text *as it exists at that
moment*, titled from the requested title or the note's (≤ 200 characters),
authored `AI-assisted note` or `User note` by the note's origin, linked by
`originNoteId`, and starting at `state: 'processing'`. It MUST enter the same
ingestion pipeline as any other manual source — the retrieval invariant
([[../ingestion/spec]] REQ-101) is untouched — and the source and its
`source.added` activity MUST be written in one transaction. The source and the
note are independent records afterwards: editing the note MUST NOT alter the
source.

- GIVEN a note with text
- WHEN it is converted with a custom title
- THEN a manual source in `processing` exists with that title, an ingest job
  is enqueued, and editing the note afterwards leaves the source unchanged.

### REQ-217 — Re-converting is idempotent and honest

When the note already has a non-failed converted source, the route MUST answer
**200** with that source and create nothing — 201 is reserved for the source
this request created.

### REQ-218 — Concurrent conversions never answer 500, and enqueue exactly once

Two concurrent conversions of the same note MUST answer {200, 201}: the loser
of the `originNoteId @unique` race MUST get the existing source back, exactly
as the idempotent branch answers.

The same holds for two concurrent *retries* of a failed conversion, and there
the guard MUST be the row, not the queue: the retry claims the source with one
atomic statement (`state: 'failed'` in the WHERE, exactly as `/sources/:id/retry`
reasons), and only the claimer enqueues. Without the claim both racers would
reach the enqueue, where the loser's `remove()` can delete the settled-job slot
the winner just filled — leaving the source in `processing` with no job coming,
the one failure the state guard exists to prevent. The loser answers 200 with
the source, like every other non-creating branch.

- GIVEN a note whose converted source is `failed`
- WHEN two retries are issued concurrently
- THEN the pair answers {200, 201}, both carry the same source id, and the
  ingest queue is handed the job exactly once.

### REQ-219 — Retrying a failed conversion REUSES the source row

When the previous converted source is `failed`, the route MUST update that row
back to `processing` (with the new title, author, and text) rather than
deleting and recreating it — a delete cascades away any citations referencing
the source (PRD §6/§10), and the source id is the identity a passage or
citation points at, exactly the reasoning `/sources/:id/retry` records. Because
no row is created or destroyed, the retry is net-neutral on `sources_per_space`
and so is allowed at exactly the cap.

- GIVEN a note whose converted source is `failed` and which a citation references
- WHEN a conversion is retried with the space at `sources_per_space`
- THEN the retry answers 201 reusing the same source id, and the citation still
  references that source.

### REQ-220 — Conversion refuses what it cannot accept

The route MUST answer 400 `empty_note_content` when the note has no text, 400
`manual_too_long` with a field-level message when the text exceeds
`manual_max_chars` (read live from `AppConfig`, PRD §5), 400 `note_too_deep`
when the document is nested too deeply to walk (the loose-JSON body is bounded
only by this walk), 409 `sources_limit` at the per-space cap, and 409
`space_archived` in an archived space.

### REQ-221 — A queue rejection is written to the source, not thrown

When the ingest queue rejects the job, the source MUST land `failed` with the
plain-language "Processing could not be started…" message and a
`source.failed` activity, and the response still carries that state — the
source never sits in `processing` with no job coming.

## The archived surface and a11y

### REQ-222 — An archived space's notes surface offers no write action

When the space is archived, the client MUST show the read-only banner and MUST
withhold every write affordance — New note, Edit, Convert, Delete — on the
cards and in the viewer. The banner's claim and the offered actions MUST
agree.

### REQ-223 — The note viewer is a non-modal side region

The viewer MUST NOT claim modality it does not implement: it is a
`complementary` region labelled by the note's title, and the page's modal
behavior belongs to its three real dialogs (create, convert, delete), which
carry focus trap, Escape, and focus restore (PRD §18).

### REQ-225 — Every notes control is labelled, and the search announces its result

Both editor controls in the viewer (title and content) MUST carry real `<label>`
elements with ids derived from `useId` — placeholder-only or bare controls are
not accessible, and a hard-coded id collides when two viewers render. The notes
search MUST likewise be labelled and MUST announce its result count through an
`aria-live` region, because a search that silently rewrites a list is invisible
to a screen reader (PRD §18) — the same contract `source-filters.tsx` follows.

The page-title badge MUST show the space's `noteCount`, not the filtered list
length: a count beside the title that shrinks while filtering reads as though
the space lost notes. The filtered count belongs to the announced line under
the search box, where it says what it means.

## Verification

Backend — `test/notes.test.ts` (16 tests): the CRUD round-trip; the save flow
with citations and both 409 paths; a dedicated `not_an_assistant_message` test
(REQ-206); a `note_too_deep` test over a >100-level document (REQ-220); both
concurrency races (REQ-205, REQ-218); idempotent re-convert and snapshot
independence (REQ-216/217); the failed-conversion retry that reuses the row,
works at `sources_per_space`, and preserves the citation against that source
(REQ-219); the ownership 404; the archived-space write refusals (REQ-208,
REQ-210/211); the archived delete staying allowed (REQ-212); citation staleness
after a reprocess; and the queue-down path that lands the source failed with
the plain-language message (REQ-221). Frontend —
`src/routes/notes-page.test.tsx`: empty state, list rendering, server-side
search with debounce and clear, create / edit / convert / delete dialogs, the
archived read-only surface (REQ-222), and the multi-paragraph edit round-trip
(REQ-214). `assistant-pane.test.tsx` covers the save affordance and its
"Saved to notes" state (REQ-207).
The follow-up review pass tightened the Verification promises to what the
suites actually cover: the failed-conversion reuse and the `note_too_deep`
refusal are now named tests (REQ-219, REQ-220), the `assistant-pane` suite
asserts the streaming synthetic answer offers no save button, and the new
`note-viewer.test.tsx` pins Cancel discarding the draft. The space-page's Notes
region reads its count from the space detail (`noteCount`), not the full notes
list.

A second review pass closed the gaps that pass had left. Backend: the
concurrent-retry race is now guarded and named (REQ-218), asserting {200, 201}
and exactly one `ingestQueue.add`; `enqueueOrFail` moved to
`src/lib/enqueue-ingest.ts` as the single copy of the "a queue rejection is
written to the source, not thrown" invariant (REQ-221), which `sources.ts` and
`notes.ts` now share rather than duplicate. Frontend: `assistant-pane.test.tsx`
covers both save-failure branches — a real error surfaces and the button does
not claim saved, while `note_already_saved` re-reads the thread instead of
erroring (REQ-207); `note-viewer.test.tsx` pins both editor labels and the
withheld Edit on a too-deep note (REQ-224, REQ-225); `field.test.tsx` pins that
a `children` control receives the component's props *and* the error border, on
`Field` and `TextareaField` alike — the two had drifted apart on that path.
`Field`'s error styling reaching only the built-in control was why an errored
`convert-note-dialog` field was announced but not visible.

Not verified here: the browser UI was not driven in this session, and the
`?q=` filter is title-only by design — body search has no PRD basis.

## Cross-references

- [[../../plan/phase-5-notes/proposal]] · [[../../plan/phase-5-notes/design]] ·
  [[../../plan/phase-5-notes/tasks]]
- [[../assistant/spec]] — the producer of saved answers and their citations;
  REQ-207's `savedNoteId` extends its conversation read.
- [[../ingestion/spec]] — REQ-101 (the retrieval invariant a converted note
  enters), the pipeline, and the failure split.
- [[../spaces/spec]] — REQ-100, the frozen-space rule.
- [[../../wireframe/index]] — `saved_notes`, the screen.

> [!note] Phase 7 additions (2026-08-27)
> REQ-271–274 and the client half of REQ-211 were added by
> [[../../plan/phase-7-home-and-hardening/tasks]]; `backend/test/notes.test.ts`
> names REQ-271–274, `frontend/src/features/notes/note-viewer.test.tsx` and
> `frontend/src/routes/notes-page.test.tsx` name REQ-211 and REQ-210's §16 case.
