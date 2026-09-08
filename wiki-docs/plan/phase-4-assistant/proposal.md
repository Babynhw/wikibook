---
title: Phase 4 — Citation-grounded assistant
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-13
tags: [phase-4, assistant, retrieval, citations, streaming]
---

# Proposal: Phase 4 — Citation-grounded assistant

## Problem

Everything the assistant needs exists and nothing consumes it. A ready
source carries chunked passages with a 768-dimension embedding and a
GIN-indexed `tsv` (`backend/prisma/schema.prisma:160`), each passage names
the block range a reader can highlight (REQ-088, REQ-110), and
`retrievableSources()` states exactly which sources may be retrieved from
(`backend/src/lib/retrieval-scope.ts`) — with no query built from it. The
embeddings are written on every ingest and have never been read.

The `Conversation`, `Message`, and `Citation` tables have been in the
schema since Phase 0 and are still empty. `GET /citations/:id/target`
resolves a citation to a reader location, was tested against hand-seeded
rows, and is marked inert because **nothing produces a citation**
([[../phase-3-library-reader/tasks]] T6). Phase 3 built the destination of
a citation link; Phase 4 builds the thing that emits the link.

Two consequences make this the phase that decides whether the product is
what the PRD describes. §9 is the only section whose acceptance criteria
are about *not* answering — insufficient evidence, no invented citations,
no note used as evidence — so the phase is as much about refusal as about
answers. And §21's end-to-end scenario has six lines in a row that all
run through this phase; until it lands, the MVP has evidence, a reader,
and no research.

## Goal

A user asks a question in a space, watches a grounded answer stream in
with citation markers beside the claims they support, clicks one, and
lands on the exact passage in the reader — with a way back to the answer.

```
space → Assistant   scope: ▸ Entire space   ▸ Only "Informed Consent Practices"
                    │
                    │  "What did participants say about withdrawing?"
                    ▼
     ░ streaming ░  Participants described withdrawal as socially costly [1],
                    though one site reported no such pressure [2]. ▸ conflict
                    kept, not resolved
                    │
                    │  Sources used: Consent Practices (p. 7), Site B Report
                    ▼
   click [1] →  /spaces/:sid/sources/:id?cite=<citationId>&from=/spaces/:sid/assistant/:cid
                    │  the passage highlighted, "Page 7" shown
                    ▼
                    ← Back to the answer
                    ▸ Useful / Not useful      ▸ New conversation
```

## Scope

1. **Retrieval over a space's evidence** (PRD §9) — hybrid vector +
   full-text search over passages, built from `retrievableSources()` and
   from nothing else, with the two §9 scopes: the entire space, or one
   current source.
2. **A streamed, citation-grounded answer** (§9) — `claude-opus-5` with
   the Claude API's native Citations over `document` content blocks, one
   document per retrieved passage, tokens streamed to the client as they
   arrive.
3. **Citations that cannot be invented** (§9) — a persisted `Citation` row
   exists only where the model cited a document we sent; its source title,
   quoted passage, and page/paragraph reference come from the `Passage`
   row, never from model output.
4. **Insufficiency** (§9, §16) — a question with no retrievable evidence
   at all is answered as insufficient *without* calling the model (the
   "above the floor" clause this first carried was amended during
   implementation — see [[design]] and [[tasks]]); a question whose retrieved evidence does not support an answer
   is answered as insufficient by the model, and the client marks an
   ungrounded answer as such.
5. **Conflicting evidence surfaced, not resolved** (§9).
6. **Conversations** (§9) — one space, persisted across refresh,
   follow-ups carrying prior turns as conversation context (never as
   evidence), a new conversation that deletes nothing, a list of previous
   conversations, and a title generated from the first question with
   `claude-haiku-4-5`.
7. **The scope is always visible and stored per request** (§9) —
   `Conversation.scopeType`/`scopeSourceId` carry the current scope,
   `Message.scopeSnapshot` records the scope *and the sources actually
   retrieved from* for each assistant request.
8. **Useful / not-useful feedback** on an assistant message (§9).
9. **Citation navigation into the reader** — `?cite=<citationId>` resolved
   through the route Phase 3 built, with `?from=` carrying the way back.
10. **The §16 states this screen owns** — no conversations, no relevant
    evidence, and assistant request failure with the question preserved
    and Retry offered.

## Out of scope

- **Save an answer as a note** (§10) and everything note-shaped — Phase 5.
  Phase 4 ships no disabled "Save as note" button; the affordance arrives
  with the note that backs it. What Phase 4 owes Phase 5 is a `Message`
  and its `Citation` rows durable enough to copy onto a note, which is
  why citations are persisted rather than derived on read.
- **Converting a note into a source** (§12) — Phase 5. Notes are already
  excluded from retrieval by construction: a `Note` is not a `Source`, and
  retrieval reads sources ([[design]] "Notes need no filter").
- **Compare, Summarize, Synthesize, Challenge, Verify, Find Gaps modes**
  (§9's own prohibition, §20). A user may ask for any of these as an
  ordinary question; the product ships no mode for them, no preset prompt
  buttons, and no "summarize this source" action.
- **Cross-space queries** (§20) and any retrieval that reads outside the
  current space.
- **Re-ranking with a second model, query rewriting, and HyDE.** The
  retrieval query is the user's question, verbatim
  ([[design]] "The retrieval query is the question").
- **Streaming the model's reasoning as a product feature.** Thinking is
  configured for latency, not surfaced as content the user can inspect
  ([[design]] "Thinking is a latency decision").
- **Editing or deleting a message, regenerating an answer, branching a
  conversation, renaming a conversation.** §9 lists new conversation,
  follow-up, and view previous; none of the rest.
- **Deleting a conversation.** §9 requires that starting a new
  conversation not delete previous ones and says nothing about removing
  one; adding a delete needs its own proposal, and PRD §17's deletion
  requirements are written about sources.
- **A citations index page.** The `knowledge_assistant` and
  `research_notebook` mockups both draw a Citations nav item; citations
  are surfaced per answer and per source, and a global index is
  unspecified ([[../../wireframe/index]]).
- **Answer caching, batch answering, and an answer-quality eval harness.**
  Model-behavior claims are hand-verified and recorded, not asserted in
  CI ([[design]] "The provider is a port, not an SDK wrapper").

## Acceptance criteria

From PRD §9's acceptance criteria, plus the §16, §17, §18, and §19 lines
this phase is measured by.

**Retrieval and scope**

- Current-source scope never retrieves a passage from another source.
- Space scope can retrieve from several ready sources in one answer.
- A `processing`, `failed`, or archived source never contributes a
  passage, asserted through `retrievableSources()` rather than by
  re-deriving the filter.
- A note that has not been converted into a source never appears as
  supporting evidence.
- A source in another space of the same user never contributes a passage.
- The active scope is visible on screen at all times, and the resolved
  scope is stored with each assistant request.

**Answers and citations**

- Every citation resolves to stored source content: its `passageId` names
  a row, and the quoted text is that row's text.
- Every citation carries the source title, the supporting passage, a
  page / paragraph / section reference, and a link that opens the reader
  at that location.
- A claim's citation marker sits beside that claim, not collected at the
  end of the answer.
- The answer identifies the sources it used.
- No citation exists for a document that was not sent to the model, and no
  citation's locator is model-authored.
- A question the retrieved evidence cannot support produces an
  insufficiency response rather than an unsupported claim.
- Two sources that disagree are both presented, and the answer does not
  pick a winner on the user's behalf.
- A saved assistant answer is never evidence — enforced by the fact that
  retrieval reads passages, and no answer is ever chunked into one.

**Conversations**

- A conversation and its messages survive a refresh and a sign-out /
  sign-in.
- A follow-up question can rely on the previous turns of the same
  conversation.
- Starting a new conversation leaves previous conversations listed and
  readable.
- A conversation's title is generated from its first question, and a
  failure to generate one leaves a usable title rather than an error.
- Feedback on an assistant message is recorded and survives a refresh.

**Non-functional**

- An answer begins displaying within 8 s at p75, excluding provider
  outages (PRD §19), measured as time from submit to the first content the
  user sees.
- A dropped connection mid-answer loses the answer, not the question: the
  question stays in the composer or in the thread, and Retry is offered
  (§16).
- Every route enforces ownership and answers 404 — never 403 — for another
  user's space, conversation, or message (PRD §17).
- The Anthropic API key never reaches the browser, and no answer,
  question, or passage text is written to the application log (PRD §17).
- Asking a question inside an archived space is refused with Phase 1's
  message; reading its conversations stays allowed (REQ-100).
- The composer, scope selector, citation markers, and feedback controls
  are keyboard reachable; a streaming answer is announced to assistive
  technology without re-announcing every token (PRD §18).
- The screen is usable at 320 px, where the reader is a navigation rather
  than a third pane (§18).

## Cross-references

- [[design]] — decisions: how retrieval fuses two rankings, why each
  passage is its own `document` block, how the stream is transported, and
  what is refused rather than answered.
- [[tasks]] — work breakdown, split by codebase.
- [[../phase-2-ingestion/proposal]] — the pipeline that produced the
  passages, embeddings, and locators this reads, and the SSE plumbing
  this reuses.
- [[../phase-3-library-reader/design]] — "The reader's URL is the citation
  contract"; Phase 4 supplies the `?cite=` producer it specified.
- [[../../specs/ingestion/spec]] — REQ-088/089 (locators), REQ-100
  (archived-space writes), REQ-101 (retrieval eligibility).
- [[../../specs/library-reader/spec]] — REQ-130/134/137 (reader URL,
  highlight copy, displayed reference) and the `GET /citations/:id/target`
  contract this activates.
- [[../../wireframe/index]] — `knowledge_assistant`, layout only; its
  Citations nav item and "other relevant excerpts" pane are out of scope.
- PRD `../../../RAG Workspace - PRD.docx` §2 (Conversation, Message,
  Citation), §9 (assistant), §16 (states), §17 (security), §18 (a11y),
  §19 (performance), §20 (exclusions), §21 (end-to-end scenario).
