---
title: Phase 5 — Notes & saved answers
kind: plan
status: done
created: 2026-08-15
updated: 2026-08-15
tags: [phase-5, notes, saved-answers, convert-to-source]
---

# Proposal: Phase 5 — Notes & saved answers

## Problem

The assistant answers, the library holds evidence, and nothing connects the
two. PRD §10 lets a user save an answer *with its citations* as a working
note; §11 makes notes private working material that is excluded from retrieval
unless the user says otherwise; §12 lets a note become an evidence source by
an explicit, snapshot-style conversion. None of it exists. The `Note` table
has been in the schema since Phase 0 with its two uniqueness invariants —
`originMessageId @unique` (one note per saved answer, §11 anti-duplication)
and `Source.originNoteId @unique` (one converted source per note) — unused.

There is also a UI-shaped gap: the space rail has had a Notes item since
[[../space-sidebar/proposal]], pointing at a route that did not exist, and the
`saved_notes` wireframe has been waiting for its screen.

## Goal

From an assistant answer, one click saves it — question, answer, and citations
— into the space's private notes. From the notes screen the user searches,
edits, converts, and deletes them; converting produces a normal manual source
that travels the same ingestion pipeline as any other, so the retrieval
invariant ([[../../specs/ingestion/spec]] REQ-101) is untouched.

```
answer ──"Save as note"──▶ note (private, §11)
                                │ search / edit / delete
                                ▼ "Convert to source" (§12, snapshot)
                          manual source ──▶ ingestion pipeline ──▶ retrievable
```

## Scope

1. **Save an answer as a note** (PRD §10) — `POST /messages/:id/save-as-note`,
   citations copied from the message, title defaulted from the preceding user
   question, and the saved state durable across reloads (`savedNoteId` on the
   conversation read).
2. **Notes CRUD and search** (§11) — create, list, read, update, delete within
   a space, with title search through the list route's `?q=`, following Phase
   3's source-search precedent.
3. **Convert a note into a source** (§12) — an independent manual-source
   snapshot labelled by the note's origin, enqueued into the same pipeline,
   idempotent, and net-neutral against `sources_per_space` when it retries a
   failed conversion.
4. **The notes screen** — the `saved_notes` wireframe as a route: cards with
   origin badges and citation counts, a viewer drawer, and the three dialogs.
5. **Archived spaces** — the notes surface honours the frozen-space rule
   (REQ-100): the banner's "read-only" claim and the offered actions agree.


## Non-goals

- The notebook (PRD §13) is Phase 6. A note is not a page of the notebook.
- Notes are never evidence until converted (§11/§12); nothing in retrieval
  changes.
- Deleting a space is still absent (PRD §4). Note deletion is not space
  deletion.
- Rich-text editing. The viewer edits plain text over the ProseMirror-shaped
  JSON; Tiptap arrives with the notebook.

## Acceptance criteria

**Saved answers (PRD §10)**

- Saving an assistant answer creates one note carrying the answer text, the
  preceding question, and the message's citations with their locators.
- A second save of the same answer — sequential or concurrent — is answered
  409 `note_already_saved`, never 500.
- A saved answer shows "Saved to notes" after a reload, not just in the
  session that saved it.
- Saving a *user* turn is refused (400 `not_an_assistant_message`).

**Notes (PRD §11)**

- Notes are listed newest-updated first and searchable by title; the search is
  a server query, not a client-side filter.
- Creating or editing a note records its activity in the same transaction as
  the note.
- Editing a note round-trips its structure: a multi-paragraph note saved once
  still has its paragraphs — the editor MUST NOT flatten the document.
- Every note route enforces ownership and answers 404 — never 403 — for
  another user's note (PRD §17).

**Conversion (PRD §12)**

- Converting creates an independent manual source (`processing`) whose text
  comes from the note as it exists at that moment; editing the note afterwards
  does not touch the source.
- Converting twice returns the existing source with 200, creating nothing.
- Two concurrent conversions answer 200/201 — never 500.
- A note with no text is refused (400 `empty_note_content`); text over
  `manual_max_chars` is refused with the §5 limit's field message (400
  `manual_too_long`); a space at `sources_per_space` is refused (409
  `sources_limit`) unless the retry frees a failed predecessor first.
- The converted source is labelled `User note` / `AI-assisted note` by origin.
- If the ingest queue rejects the job, the source lands `failed` with a
  plain-language message rather than sitting in `processing` forever.

**Non-functional**

- Every write route carries its own rate limit, including DELETE.
- In an archived space the notes surface offers no write action at all — the
  banner that says "read-only" is true. Deleting a note stays allowed by the
  API, as it is for sources: archiving must not be a trap.
- The viewer is keyboard- and screen-reader-honest: a non-modal side region,
  with the page's real dialogs doing the modal work (PRD §18).

## Cross-references

- [[design]] — the API surface and the decisions, including the concurrency
  contract around both unique constraints.
- [[tasks]] — work breakdown by codebase, with the review-pass notes.
- [[../phase-4-assistant/proposal]] — the producer of the answers and
  citations this phase saves.
- [[../../specs/ingestion/spec]] — the pipeline a converted note enters, and
  the retrieval invariant it must not bypass.
- [[../../specs/spaces/spec]] — REQ-100, the frozen-space rule.
- [[../../wireframe/index]] — `saved_notes`, the screen this builds.
- PRD `../../../RAG Workspace - PRD.docx` §10 (saved answers), §11 (notes),
  §12 (conversion), §16 (states), §17 (security), §18 (a11y).
