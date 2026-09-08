---
title: Phase 4 — Tasks
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-13
tags: [phase-4, tasks]
---

# Tasks: Phase 4 — Citation-grounded assistant

Backend first, and inside the backend **retrieval before the model**
(T2 before T4): a scripted answer client can be written against a
retrieval layer, but a retrieval layer written after the streaming route
gets shaped by whatever the route happened to need. There is no schema
task — Phase 0 already wrote the tables ([[design]] "Migration: none"), so
T1 is configuration instead. Estimated 2 weeks ([[../../README]] §6).

## Backend (`backend/`)

### T1 — Configuration and the provider client

- [x] `@anthropic-ai/sdk` added; `src/lib/anthropic-provider.ts` builds the
      client from `ANTHROPIC_API_KEY` (the plan said `anthropic.ts`; the file is
      the adapter, so it is named for that)
- [x] The nine env vars in [[design]] ("Configuration and secrets") added
      to `config.ts` and `.env.example`; `ANTHROPIC_API_KEY` is **not** a
      `devCredential()` and has no default
- [x] `src/index.ts` refuses to boot without the key, with an actionable
      message, beside the existing embedding-dimension gate
- [x] No new `AppConfig` key — §5's list is closed ([[design]] "No new
      `AppConfig` key")
- [x] `README.md` records the key as a prerequisite next to `ollama pull`

### T2 — Retrieval

- [x] `src/lib/retrieval.ts` — two candidate queries (pgvector `<=>` KNN,
      `websearch_to_tsquery` + `ts_rank`), both spreading
      `retrievableSources()` into the `where` clause
- [x] Reciprocal rank fusion, `Σ 1/(60 + rank)`, top `RETRIEVAL_TOP_K`
- [x] Current-source scope **adds** `sourceId` to that clause and never
      replaces it, so a non-retrievable source cannot be scoped to
- [x] Returns passages with their source title and locator; no snippet
      generation, no `ts_headline`
- [x] The query string is not logged with its results (§17)

### T3 — Conversations, scope, feedback

- [x] `GET`/`POST /spaces/:id/conversations`, `GET`/`PATCH
      /conversations/:id` per [[design]] "API surface"
- [x] `assertOwnership` gains `conversation` and `message` resolvers, both
      through `space.ownerId`
- [x] `POST /messages/:id/feedback` — `useful` | `not_useful` | `null`;
      400 on a `user`-role message
- [x] Asking in an archived space is 409 with `ARCHIVED_MESSAGE`
      (REQ-100); reads stay allowed
- [x] Per-route rate-limit option **factories**, never a shared object;
      asking 20/minute, reads on the 600/minute bucket
      ([[../phase-3-library-reader/tasks]] implementation notes)

### T4 — The answer, and citations that cannot be invented

- [x] `src/lib/answers.ts` depends on the `AnswerProvider` port — shaped by
      the assistant's needs, carrying a `capabilities` record, with
      citation resolution and the drop-and-count rule **outside** the
      adapter ([[design]] "The provider is a port, not an SDK wrapper")
- [x] One adapter (`anthropic`) plus the scripted test provider; no second
      adapter and no `marker`-tier implementation in this phase
- [x] One `document` block per retrieved passage (plain text, so citations
      land on a sentence — the shape the docs prescribe for RAG chunks),
      `citations.enabled` on **every** one (all-or-none is enforced),
      `title` = source title, `context` = locator label
- [ ] Evaluate a `search_result` block against `document` first — the
      citations docs name it as a citable type and it may carry source and
      title natively; the resolution rule is unchanged either way. *Not done:
      `document` was used and works; `search_result` is documented only in
      passing on the citations page and evaluating it needs a live call.*
- [x] Citations consumed from `citations_delta` inside
      `content_block_delta`, so a marker can be emitted as it resolves
      rather than only when the block closes
- [x] `thinking: { type: 'adaptive', display: 'summarized' }`,
      `output_config: { effort: ANSWER_EFFORT }`, `max_tokens` bounding
      thinking **plus** answer
- [x] `stop_reason` is checked **before** `content` is read; `refusal`,
      `max_tokens`, and transport errors are three distinct outcomes
- [x] `document_index` → `Passage` by array position; an out-of-range
      index is dropped and counted (a count, never text)
- [x] A persisted `Citation` takes `sourceId`, `passageId`, `page`,
      `paragraphRef`, `sectionHeading` from the **`Passage` row**; only
      `quotedText` comes from `cited_text`
- [x] History sent as `messages`, trimmed to `MAX_HISTORY_TURNS`, with
      citation markers stripped from prior assistant turns — never as
      documents (§9)
- [x] Empty retrieval answers insufficiency **without calling the client**
- [x] `cache_control` on the system prompt if it clears the 512-token
      minimum; `usage.cache_read_input_tokens` recorded once

### T5 — The stream

- [x] `POST /conversations/:id/messages` responds `text/event-stream`,
      hijacked like `routes/events.ts`, with the event types in
      [[design]] ("The answer streams over its own POST response")
- [x] Reuses the events plugin's `registerUserConnection`, `trackStream`,
      `releaseUserConnection`, and sign-out teardown — **not** the Redis
      channel, and Phase 2's note is corrected in its own design
- [x] The user message is persisted before the stream opens; the assistant
      message and its citations are written in **one transaction** on
      completion
- [x] Socket close aborts generation (`AbortSignal` to the SDK) and
      persists no assistant message
- [x] The conversation title is generated with `TITLE_MODEL` after the
      answer completes, emitted as a `title` event; a failure falls back to
      a truncated question and is never an error
- [x] `scopeSnapshot` written per [[design]] ("The scope snapshot records
      what was retrieved"), including `provider`, `model`, `effort`, and
      `citationMode` — one value each today, and no migration to add later
- [x] Logging carries ids, counts, model id, usage, and four latencies —
      no question, answer, passage, or quote text (§17)

### T6 — Backend tests

- [x] `test/retrieval.test.ts` — the nine cases in [[design]] ("Testing" →
      Retrieval), including the seeded `Note` that never appears and
      eligibility asserted **through `retrievableSources()`**
- [x] `test/answers.test.ts` — request shape, history-not-documents,
      stripped markers, cache breakpoint
- [x] Citation persistence: dropped out-of-range index; locators from the
      passage and not the client; `quotedText` round-trip; **every
      persisted citation resolves through `GET /citations/:id/target` to a
      block range containing the passage's text**
- [x] Insufficiency: empty retrieval with a client that throws if called;
      zero-citation answer stored ungrounded
- [x] Failure paths: refusal with empty content, client error, mid-stream
      abort
- [x] `test/conversations.test.ts` — create, list order, messages with
      citations, scope `PATCH`, 404s, the two 409s, feedback set/clear
- [x] Mutation checks: drop `archivedAt` from the filter; stop copying the
      page from the passage row; accept an out-of-range `document_index`; send
      history as documents; persist the assistant message before completion.
      Three failed exactly one test, two failed several — see the implementation
      notes. All reverted and the suite re-run green
- [x] Tests share one registered account and isolate by space —
      `/auth/register` is 10/minute ([[../phase-3-library-reader/tasks]])

## Frontend (`frontend/`)

### T7 — Data layer

- [x] `features/assistant/sse.ts` — the SSE parser over `fetch` +
      `TextDecoder`; no `EventSource` (it cannot POST a body) and no
      dependency
- [x] `use-ask.ts` — optimistic user turn, deltas appended, citations
      collected by index, abort on unmount, the composer's text retained
      until the answer is stored
- [x] `use-conversations.ts` / `use-conversation.ts` — list and thread,
      cache patched on create and on `title`
- [x] `lib/api.ts` — the new endpoints and types; citation payloads carry
      no passage text beyond the quote

### T8 — Assistant UI

- [x] Route `/spaces/:spaceId/assistant/:conversationId?` →
      `assistant-page.tsx` rendering `assistant-pane.tsx`
- [x] `scope-selector.tsx` — the active scope **visible at all times**
      (§9), switching between the space and one ready source, persisted
      through `PATCH`
- [x] `answer-message.tsx` — inline `[n]` markers at the offsets the
      citations name, a sources-used footer, useful / not-useful feedback
- [x] `citation-marker.tsx` — a `<button>` whose accessible name says
      where it goes; resolves `GET /citations/:id/target` and never
      assembles a reader URL itself; a `stale` target still navigates
- [x] `conversation-list.tsx` — previous conversations, newest first; new
      conversation deletes nothing
- [x] Three-pane on wide viewports mounting Phase 3's `source-reader.tsx`
      in the pane; below the breakpoint the marker navigates with `?cite=`
      and `?from=`, usable at 320 px (§18)
- [x] `aria-live="polite"` carries **status**, not tokens; the answer text
      is an ordinary region (§18)
- [x] The three §16 states: no conversations, no relevant evidence,
      assistant request failure with the question preserved and Retry
- [x] Archived space: composer disabled with Phase 1's message, thread
      still readable

### T9 — Frontend tests

- [x] A stubbed stream renders deltas in order with markers inline
- [x] A marker resolves `?cite=` through the target route and opens the
      reader; the stale case still opens
- [x] The three §16 states; the composer keeps its text on error and Retry
      re-sends the same question
- [x] Feedback toggles and clears; scope is visible and persists
- [x] The live region announces status, not tokens
- [x] Tests cite REQ ids once the spec is written
      ([[../../specs/AGENTS]])

## Exit criteria

- [x] Every acceptance criterion in [[proposal]] is exercised — by test
      where possible, by hand otherwise, and anything unverified is
      written down rather than dropped
- [x] Current-source scope never returns another source's passage; space
      scope answers from several; archived, failed, processing sources and
      unconverted notes never appear — through `retrievableSources()`
- [x] Every citation the product emits resolves to a stored passage and
      opens the reader at it; a fabricated `document_index` cannot be
      persisted
- [ ] A question the evidence cannot support answers insufficiency; two
      contradicting sources are both presented; **both hand-verified
      against the real API with the transcript recorded** — *outstanding, no
      provider credential in the implementing session*
- [ ] Time-to-first-visible-content measured over ten real questions
      against 50 sources and reported as p75 with its embed / retrieve /
      first-token split (§19), as numbers — *outstanding, needs a credential;
      the retrieval half is measured below*
- [x] The ANN-index question is **settled, not deferred again**: exact KNN
      measured at the §5 ceiling and the `Passage.embedding` comment
      rewritten from "revisit in Phase 4" to what was measured
- [x] A conversation, its messages, its citations, and its feedback
      survive a refresh and a sign-out / sign-in
- [x] A dropped connection mid-answer loses the answer, keeps the
      question, and persists no partial assistant message
- [x] No key, provider message, or stack reaches the client; no question,
      answer, or passage text reaches the log (§17)
- [x] `specs/assistant/spec.md` written from the verified behavior,
      numbering from **REQ-145** (REQ-144 is the highest id in use), with
      `index.md` updated, `log.md` appended, `tasks.md` ticked and
      `status: done`
- [x] [[../phase-3-library-reader/design]]'s "inert until Phase 4" note on
      `GET /citations/:id/target` is resolved in
      [[../../specs/library-reader/spec]], and Phase 2's "Redis channel is
      the transport Phase 4 reuses" expectation is corrected where it was
      written

## Implementation notes (2026-08-13)

Implemented on branch `phase-4-assistant`. Backend 115 → 151 tests, frontend
103 → 121, all green against the compose stack with real Ollama embeddings. The
verified behavior is written up in [[../../specs/assistant/spec]]. What deviates
from [[design]], and what a later phase needs to know:

- **The design promised a similarity floor and there is none.** It said
  insufficiency was answered for "zero candidates, or none above the floor". KNN
  always returns its nearest neighbours, so an off-topic question retrieves
  passages and *does* spend a model call; only a scope with no retrievable
  passages at all comes back empty. A distance cutoff was rejected for the same
  reason weighted score fusion was — the threshold is a tuned constant with no
  principled value — and because a floor makes the product refuse to *look*,
  answering "no evidence" for a well-posed question whose source happens to use
  other words. Found by running the real stack, not by the suite: a question about
  mercury's boiling point still reached the provider. The design carries the
  amendment as a callout and `retrieval.ts` states it in place.
- **The boot gate never fired in the case that actually happens.**
  `.env.example` ships `ANTHROPIC_API_KEY=` blank, and a `z.string().min(1)`
  rejected that at schema-parse time with "expected string to have >=1
  characters" — so the actionable message in `index.ts` was unreachable on a fresh
  checkout. The schema now normalises blank to absent and the gate prints the
  message. Verified by booting with a blank key.
- **A stream that ends with neither `done` nor `error` was treated as success.**
  The client cleared its pending answer and refetched, so an answer the server
  never finished vanished silently with no Retry offered. Now an unsettled stream
  is a §16 failure (REQ-166). Found by a frontend test whose premise was wrong,
  which is the useful kind of wrong.
- **`assertOwnership` already had `conversation` and `message` resolvers** —
  Phase 0 wrote the whole map. T3's bullet was work that was already done.
- **One mutation check found a hole in a test rather than in the code.** Resolving
  an out-of-range `document_index` to passage 0 passed the whole suite, because
  the drop test kept one *valid* citation alongside the invented ones and the
  dedupe-by-passage rule absorbed the difference. The test was split into an
  all-invented case (asserting *zero* citations) and a mixed case that cites the
  **second** passage, so a fallback to the first is visible. Both then failed,
  which is coverage rather than duplication.
- **Two mutations failed more than one test, and neither was loosened.**
  Accepting a bad index fails the two drop cases; persisting the assistant message
  early fails five — the disconnect case plus every refusal and error case that
  asserts no answer was stored. They assert REQ-163/165 from different angles.
- **`app.inject()` cannot exercise the answer stream.** A hijacked reply writes to
  the raw socket, which light-my-request does not capture — the same lesson
  `events.test.ts` recorded in Phase 2. The helper opens a real TCP connection;
  `inject` is used only for the paths refused *before* the hijack, which is also
  why those tests can assert a status code at all.
- **§19 retrieval, measured** at the §5 ceiling — 50 sources, 300 passages: hybrid
  retrieval median 46 ms, p75 52 ms, worst 71 ms, of which ~34 ms is the Ollama
  embedding call. So exact KNN plus full-text is roughly 15 ms against an 8 000 ms
  budget for the whole answer. **The ANN-index question deferred by Phases 2 and 3
  is now settled**, and `schema.prisma` records the measurement instead of another
  deferral. Numbers from a throwaway script, not committed.
- **Verified end to end against the running stack** (API + worker + real Ollama +
  MinIO): a manual source reaching `ready`; the insufficiency path answering with
  the provider never called; and a real provider failure — the live API rejecting
  an invalid key — surfacing as the §16 message with no assistant message
  persisted, the question kept, and the provider's 401 in the server log only.
- **Outstanding, and the reason: no provider credential was available.** The §19
  8 s p75 to first visible content is unmeasured, and the model-behaviour halves of
  the phase are unverified — honest insufficiency on thin evidence, and a conflict
  presented without being resolved. Everything *around* the model is asserted in
  CI; the model's own output is not. The two exit criteria above stay unticked, and
  [[../../specs/assistant/spec]] carries the caveat in its `## Verification`
  section. Whoever first runs this with a key should ask: a grounded question whose
  citations open the right passages; two contradicting sources; a question the
  evidence cannot support; and a current-source question about content that only
  exists in another source — then record the transcripts and the latency split
  here.
- **The browser UI was not driven.** The Chrome extension was not connected in this
  session, so the assistant screen rests on its Vitest suite, exactly as Phase 3's
  reader did.
