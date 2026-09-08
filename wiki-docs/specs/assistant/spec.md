---
title: Assistant — spec
kind: spec
status: current
sources:
  - PRD §9 (citation-grounded assistant), §16 (states), §17 (security), §18 (a11y), §19 (performance), §20 (exclusions)
  - backend/src/lib/retrieval.ts, answers.ts, answer-provider.ts
  - backend/src/lib/anthropic-provider.ts, openai-provider.ts
  - backend/src/routes/conversations.ts, backend/src/plugins/answers.ts
  - backend/src/lib/answer-rules.ts
  - frontend/src/features/assistant/
created: 2026-08-13
updated: 2026-08-28
tags: [assistant, spec]
---

The citation-grounded assistant: retrieval over a space's passages, streamed
answers with citations that resolve to stored source content, conversations with
per-request scope, insufficiency, and feedback. Written from the verified Phase 4
implementation ([[../../plan/phase-4-assistant/proposal]]). RFC 2119 keywords are
load-bearing: MUST is a requirement, SHOULD is a strong default.

## Scope

Covers retrieval, answering, citation persistence, conversations, and the
assistant UI. Does **not** cover: saving an answer as a note or anything
note-shaped (Phase 5); converting a note into a source (Phase 5); the reader a
citation opens, which is [[../library-reader/spec]]; ingestion and passage
locators, which are [[../ingestion/spec]]; the `GET /citations/:id/target`
contract, also in [[../library-reader/spec]] — this spec only records that Phase 4
supplies its first real producer.

## Retrieval

### REQ-145 — Retrieval is built from `retrievableSources()`

Every retrieval query MUST be built from the exported `retrievableSources()`
filter and MUST NOT re-derive eligibility inline. A source that is `processing`,
`failed`, or archived MUST NOT contribute a passage to any answer.

- GIVEN a space holding one ready source and one archived source, both matching a
  question
- WHEN the question is asked
- THEN only the ready source's passages are retrieved, and the archived source is
  absent from `retrievableSources()` for that space

### REQ-146 — Retrieval is hybrid and fused by rank

Retrieval MUST combine a vector-similarity candidate list and a full-text
candidate list, and MUST rank the union by reciprocal rank fusion rather than by a
blended similarity score. A passage appearing in both lists MUST rank above a
passage appearing in only one.

### REQ-147 — Both halves earn their place

A question phrased entirely in words absent from a passage MUST still retrieve it
when it is semantically close (the vector half), and a question naming a proper
noun, identifier, or number MUST retrieve the passage containing it (the full-text
half).

### REQ-148 — The retrieval query is the question, verbatim

The text embedded and searched MUST be the user's question as typed. The system
MUST NOT rewrite, expand, or model-generate a search query.

> [!note] The cost, accepted
> A pronoun-only follow-up ("what about the second one?") retrieves poorly, and
> the answer is then usually an insufficiency response even though the model has
> the prior turns as context. A rewrite step would change what the user asked
> without showing it.

### REQ-149 — A source scope narrows and never widens

WHEN a conversation's scope names a source, retrieval MUST add that source id to
the eligibility filter rather than replacing it. A source-scoped question MUST NOT
return a passage from any other source.

### REQ-150 — Retrieval never crosses a space

A source in another space, including another space of the same user, MUST NOT
contribute a passage.

### REQ-151 — Notes are never evidence

A `Note` that has not been converted into a `Source` MUST NOT appear as
supporting evidence. This is enforced structurally: retrieval reads `Passage`
rows and no note is ever chunked into one.

### REQ-152 — An unparseable question does not fail

A question consisting only of punctuation or unbalanced quotes MUST be answered
rather than raise. Full-text matching MUST use a parser that cannot throw on user
input (`websearch_to_tsquery`).

### REQ-153 — There is no similarity floor

Retrieval MUST NOT discard candidates by a distance threshold. Only a scope with
no retrievable passages at all yields an empty retrieval.

> [!warning] Spec-vs-plan
> [[../../plan/phase-4-assistant/design]] first said insufficiency was answered
> for "zero candidates, or none above the floor". No floor was built, and the
> design now records the amendment: a threshold is a tuned constant with no
> principled value, and it would make the product answer "no evidence" for a
> well-posed question whose source uses other words. An off-topic question
> therefore does spend a model call.

## Answering and citations

### REQ-154 — One retrieved passage is one document

Each retrieved passage MUST be sent to the model as its own document, carrying its
source title and its locator label. Citations MUST be enabled on every document
of a request or on none.

### REQ-155 — A citation resolves by index, or it is dropped

A citation returned by the provider MUST be kept only if it addresses a document
the request actually sent. A citation whose index is out of range MUST be
discarded and counted, MUST NOT be persisted, and MUST NOT reach the client.

- GIVEN a request that sent two documents
- WHEN the provider returns citations for document indexes 99 and −1
- THEN no citation row exists for that message, no citation event is streamed, and
  the answer is reported ungrounded

### REQ-156 — A locator is never model-authored

A persisted citation's `sourceId`, `passageId`, `page`, `paragraphRef`, and
`sectionHeading` MUST be copied from the `Passage` row. No code path may derive a
locator from model output. Only the quoted text may come from the provider.

### REQ-157 — An unverifiable quote is not shown

WHERE a provider's quote is model-written rather than extracted from the document,
the quote MUST be verified as a substring of the passage text and MUST be stored
empty if it is not. The citation itself survives; the unverifiable quote does not.

### REQ-158 — Every citation opens the passage it names

Every persisted citation MUST resolve through `GET /citations/:id/target` to a
reader location whose block range contains the cited passage's text.

### REQ-159 — Answers are never evidence

Prior turns MUST be sent as conversation messages and MUST NOT be sent as
documents, so no earlier answer can be cited. Citation markers MUST be stripped
from a replayed assistant turn, because an old `[n]` indexes a document set that
no longer exists.

### REQ-203 — The system writes the citation marker into the answer

The `[n]` marker MUST be inserted into the answer text as each citation resolves,
and MUST be written to both the stream and the stored `content` so a reload renders
what the user first saw. A passage cited more than once MUST reuse its first marker
number and MUST NOT gain a second citation row.

- GIVEN a provider whose answer text contains no markers of its own
- WHEN two citations resolve, one after each sentence
- THEN the stored content reads `…first claim [1], …second claim [2].`

> [!warning] Spec-vs-code
> This requirement was missing until a review found the gap. **No provider supplies
> a marker**: a native tier attaches citations out-of-band, and the model is never
> asked to type `[1]`. The client derives markers by splitting the answer text, so
> without this an answer rendered with nothing clickable and §9's "citations beside
> the claims they support" was silently unmet — while every test passed, because the
> scripted fixtures wrote the markers into their own text.

### REQ-160 — Groundedness is derived, not stored twice

An assistant message with no citations MUST be reported as ungrounded, and
groundedness MUST be derived from the citation count rather than kept as an
independent field that could disagree with it.

### REQ-161 — An empty retrieval answers without a model call

WHEN retrieval returns nothing, the system MUST answer an insufficiency message
without calling the provider, and the message SHOULD say whether the space has no
ready sources or nothing matched.

### REQ-162 — Conflicting evidence is presented, not resolved

The answer prompt MUST instruct the model to present genuinely conflicting
excerpts as conflicting and MUST NOT have it choose between them for the user.

> [!warning] Model behaviour is hand-verified, not asserted
> REQ-162, and the quality half of REQ-161 (the model itself declining when
> excerpts do not support an answer), are properties of model output. They are
> verified by hand against the real API and recorded in the plan's implementation
> notes — see `## Verification`, where this is currently **outstanding**.

## Failure and refusal

### REQ-163 — A refusal is an outcome, not an exception

`stop_reason` MUST be inspected before response content is read. A provider
refusal MUST be reported as a §16 assistant failure, MUST NOT persist an
assistant message, and MUST leave the user's question stored so Retry can re-send
it.

### REQ-164 — No provider detail reaches the client

A provider error MUST surface as the same plain §16 message as any other failure.
Provider status codes, error types, and messages MUST NOT be sent to the client.
They MAY be logged server-side.

### REQ-165 — A disconnect persists no partial answer

WHEN the client disconnects mid-answer, generation MUST be aborted, the user's
question MUST remain stored, and no assistant message MUST be written — a
half-sentence would become context for the next follow-up.

### REQ-166 — A stream that ends unsettled is a failure

The client MUST treat an answer stream that closes without a `done` or an `error`
event as a failure and offer Retry. It MUST NOT treat it as a completed answer.

### REQ-167 — Truncation is reported, not treated as an error

WHEN the token cap bounds thinking plus answer, the answer MUST be stored and
shown with a notice saying it stopped early. This is not an error state.

### REQ-168 — Asking with no provider configured is refused cleanly

WHERE no answer provider is configured, the ask route MUST answer 503 with a
plain message and MUST NOT 500. The server MUST refuse to start in that state,
including when the key is present but blank.

## Conversations, scope, and feedback

### REQ-169 — A conversation belongs to one space and persists

A conversation MUST belong to exactly one space. Its messages and their citations
MUST survive a refresh and a new session. Conversations MUST be listed
most-recently-updated first.

### REQ-170 — Starting a new conversation deletes nothing

Creating a conversation MUST leave every previous conversation listed and
readable.

> [!note] Shared spaces v1 (2026-08-28)
> "Every previous conversation" means every one of *the caller's*: conversations
> are private to the member who started them, another member's id is 404, and
> retrieval is still over the whole space ([[../sharing/spec]] REQ-297).
> Saving an answer as a note is editor-level.

> [!note] History
> From 2026-08-15 to 2026-08-27 no UI satisfied the "listed" half: the side nav
> was removed at the operator's request and the route redirected to the newest
> thread. [[../../plan/assistant-chat-history/proposal]] restored it as a page,
> not a nav — REQ-238 – REQ-241.

### REQ-171 — The scope is visible and stored per request

The active scope MUST be visible on the assistant screen at all times. Each
assistant message MUST store a snapshot of the scope resolved for that request
**and** of the sources actually used, including their titles, so an answer can
still name its sources after one is deleted. The snapshot MUST also record the
provider, model, effort, and citation mode that produced the answer, and the
model MUST be the one that **served** the request where the provider reports it —
a router does model mapping and provider failover, so the requested id can name
something that never ran.

### REQ-172 — A source scope must name a source in the same space

A scope naming a source in another space MUST answer 404. A source scope with no
source id MUST answer 400.

### REQ-173 — Only the scope is editable

`PATCH /conversations/:id` MUST change only the scope. A title or any other field
in the body MUST be ignored.

### REQ-174 — Asking inside an archived space is refused

Asking a question and changing scope MUST answer 409 with the archived-space
message (REQ-100). Reading a conversation MUST stay allowed.

### REQ-175 — A scope that cannot be retrieved from is refused, not answered

WHEN a conversation's source scope names a source that is not retrievable, asking
MUST answer 409 and MUST NOT answer insufficiency — claiming "we looked and found
nothing" about a source the user archived would be false.

### REQ-176 — Feedback applies to an answer

Feedback MUST be settable to `useful`, `not_useful`, or cleared, MUST persist, and
MUST answer 400 on a user-role message.

### REQ-177 — A conversation is titled from its first question

A title MUST be generated from the first question. A generation failure MUST leave
a usable title derived from the question itself and MUST NOT surface as an error.
Later questions MUST NOT re-title.

### REQ-178 — Ownership answers 404

Every conversation and message route MUST register `assertOwnership` and MUST
answer 404 — never 403 — for another user's resource.

### REQ-179 — Questions are bounded

A question MUST be non-empty after trimming and at most 2000 characters.

## Chat history

### REQ-238 — The bare assistant route is the history hub

`/spaces/:spaceId/assistant` with no conversation MUST render the space's
conversations (REQ-169's order) and MUST NOT redirect to any of them. Each row
MUST be a link to its thread and MUST show the title, the newest question as a
one-line preview when there is one, the last-updated date, and — for a source
scope — that the scope is a source (REQ-171). A row MUST offer no other action:
rename, delete and share do not exist (REQ-173, PRD §20).

### REQ-239 — A conversation is created by its first question

The hub's composer MUST create the conversation and ask the question on one
submit, and MUST offer the same scope choice as the thread (`space`, or one
ready unarchived source) so the first question is retrieved with the scope the
user meant — the scope is snapshotted per request (REQ-171), so a wrong first
scope is a wasted answer. The client MUST NOT create a conversation from a bare
"new" control. The
question MUST be asked exactly once — not again on Back, refresh, or re-render —
and MUST NOT be carried in the URL, so a copied link never re-asks. A failed
create MUST keep the draft and render the error beside the field (PRD §16).

### REQ-240 — The list payload carries a preview and a count

`GET /spaces/:id/conversations` rows MUST include `preview` — the newest
`user` message, whitespace-collapsed, cut to 140 characters with `…` — or
`null`, and `messageCount`. Both MUST come from the same query as the rows.
`POST`, `GET /conversations/:id` and `PATCH` MUST NOT change shape.

### REQ-241 — Empty threads are hidden, not deleted

A conversation with `messageCount === 0` MUST NOT appear on the hub and MUST
remain readable at its URL. In an archived space the hub MUST still list the
conversations and MUST replace the composer with the archived notice (REQ-174).

## Streaming and the client

### REQ-180 — The answer streams on its own response

The answer MUST stream on the ask request's own response as
`text/event-stream`. It MUST NOT be published on the per-space Redis channel: the
assistant runs in the request that asked, and that channel is read by every
subscriber of the space.

### REQ-181 — Stream plumbing is shared with the source stream

An answer stream MUST count against the per-user connection cap and MUST be torn
down on sign-out, reusing the same registry as the source-event stream.

### REQ-182 — Everything refusable is refused before the hijack

Ownership, the archived-space rule, scope retrievability, provider availability,
and body validation MUST be checked before the response is hijacked, so they
answer as ordinary error envelopes.

### REQ-183 — The user message is stored before the stream opens

The user's question MUST be persisted before the stream opens, and the assistant
message with its citations MUST be written in a single transaction on completion.
The per-user stream slot MUST be claimed **before** the question is written, and
released if that write fails: a rejection at the connection cap must leave no
answerless question behind, or every Retry would add another.

### REQ-184 — The client reads the stream without `EventSource`

The client MUST read the answer with a streaming `fetch` response. `EventSource`
MUST NOT be used: it cannot issue a POST or carry the question in a body. A
partial event split across network chunks MUST be reassembled before parsing, and
a malformed block MUST be dropped without ending the answer.

### REQ-185 — Markers render beside their claims

A citation marker MUST render inline at the position the answer text names it,
not collected at the end. A marker naming a citation the answer does not carry
MUST render as plain text.

### REQ-186 — A marker is a control that says where it goes

A citation marker MUST be a button whose accessible name identifies the source and
the reference. It MUST resolve its destination through
`GET /citations/:id/target` and MUST NOT assemble a reader URL itself. A target
reported stale MUST still navigate.

### REQ-187 — The live region announces status, not tokens

The assistant's live region MUST announce state changes (searching, answering,
complete) and MUST NOT re-announce answer text as it streams.

### REQ-188 — A failure keeps the question and offers Retry

WHEN an answer fails, the client MUST discard the partial answer, show the failure
message, and offer a Retry that re-sends the same question.

### REQ-189 — The answer identifies its sources

An answer with citations MUST display the sources it used. An ungrounded answer
MUST say plainly that nothing is cited.

### REQ-190 — An archived space is readable, not askable

WHERE the space is archived, the composer MUST be absent and the thread MUST
remain readable.

## Security and configuration

### REQ-191 — The provider key never reaches the browser

The provider credential MUST be server-side only and MUST NOT appear in any
response.

### REQ-192 — Logs carry ids, counts, and latencies — not content

Assistant logging MUST NOT include question text, answer text, passage text, or
citation quotes. It MUST include the conversation and message ids, candidate and
passage counts, dropped-citation count, provider and model, token usage, and the
retrieve / first-token / total latencies.

### REQ-193 — Retrieval knobs are not §5 limits

Retrieval depth, candidate pool, history budget, model, effort, and timeouts MUST
be configuration, not `AppConfig` rows: §5's list of runtime limits is closed.

### REQ-194 — Asking has its own rate-limit bucket

Asking MUST be rate-limited separately from reads, and route options MUST be
built per route so no route inherits another's limiter.

### REQ-195 — The provider sits behind a port

The answer provider MUST be reached through an interface that carries a
capability record naming its citation mode and whether its quote is extracted or
generated. Citation resolution, the drop rule, and the locator copy MUST live
outside every adapter, so a provider swap cannot re-implement them differently.

## Provider tiers

Added by [[../../plan/assistant-provider-tiers/proposal]]. The port has two
implementations, which is what turns the tier taxonomy from a guess into a
contract.

### REQ-196 — Configuration selects the tier, credentials decide availability

The answer provider MUST be selected by configuration, and the server MUST refuse
to start when the selected provider is unusable, naming what to set. `anthropic`
requires a credential; `openai-compatible` requires a base URL and MUST treat the
credential as optional, because a local endpoint has no auth.

### REQ-197 — Either tier may be pointed at a different endpoint

Both providers MUST accept a base URL, so an Anthropic-shaped proxy (such as
OpenRouter's Anthropic Skin) is reached on the `native` tier without a second
adapter.

> [!warning] Citations through a proxy fail silently
> A proxy may accept `document` blocks and never return citation blocks. Every
> answer then has zero citations and is reported ungrounded (REQ-160), which is
> indistinguishable on screen from "the evidence does not cover this". A run of
> uniformly ungrounded answers means this, not the corpus. Unverified — see
> `## Verification`.

### REQ-198 — The `structured` tier constrains the answer to the indexes it sent

WHERE the provider has no native citation channel, the answer MUST be constrained
to a schema whose citation field is an enum of exactly the document indexes that
request sent, plus a value meaning uncited. The adapter MUST NOT resolve an index
itself; it reports one, and REQ-155's drop rule judges it.

### REQ-199 — A schema-ignoring server yields prose and no citations

WHEN a response is not in the requested shape, its text MUST be delivered as the
answer and **no citations MUST be produced**. The answer is then ungrounded.
Attribution MUST NOT be inferred from position, order, or similarity.

### REQ-200 — A structured answer becomes visible before it finishes

Text MUST be emitted as each segment of the constrained answer completes, so the
answer is readable before the whole response has arrived. A network chunk boundary
falling anywhere — including inside answer text — MUST NOT corrupt, duplicate, or
drop a segment, and structure appearing *inside* answer text MUST NOT be read as
structure.

### REQ-201 — Validation MUST NOT delete answer text

WHERE segments are validated before being emitted, a segment that fails validation
MUST still contribute its text. In particular a citation index outside the range
sent MUST cost only the citation, never the sentence carrying it — REQ-155 remains
the single place that decides whether an index is real.

> [!warning] Spec-vs-code
> This requirement exists because the mechanism changed. The first implementation
> hand-scanned the response and passed any segment with usable text through, so
> the failure was impossible. It now streams validated elements from a provider
> abstraction, where a strict schema would drop the whole element — text and
> all — for a bad index. The schema therefore keeps its enum for constrained
> decoding but coerces an invalid index to "uncited"
> ([[../../plan/assistant-provider-tiers/design]] "Validation must not eat answer
> text").

### REQ-202 — A generated quote is verified or dropped

WHERE `capabilities.quote` is `generated`, REQ-157's substring check MUST run in
production, not only in tests: a paraphrased quote is stored empty and its
citation is kept.

## The space audience note

Added by [[../../plan/space-audience-style/proposal]]. A space's owner may write
one short note saying who its answers are for and in what register. The note is
**user input**, not product text, and this section is entirely about keeping that
distinction structural rather than editorial.

### REQ-308 — The audience note never enters the system prompt

WHERE a space has an audience note, the assembled request's system prompt MUST be
byte-identical to the one assembled without it, for **every** provider tier. The
note MUST travel in the user turn, ahead of the documents, rendered by the one
shared `audienceNoteBlock()`.

> The reason is the trust boundary, not prompt caching. `system` is text written
> and reviewed here; the note is read from a `Space` row and reviewed by nobody.
> Concatenating them leaves line order as the only thing separating what the
> product guarantees from what a user asked for. A cache prefix that survives is
> a consequence of the rule, not its justification — placing the note after the
> cache breakpoint would have preserved the cache too, and given unreviewed input
> the closing word.

### REQ-309 — The rules declare their precedence over the note

The rule list every adapter sends MUST carry `AUDIENCE_PRECEDENCE_RULE` verbatim
from `lib/answer-rules.ts`: the note governs language, reading level, length, and
tone, and never licenses presenting an unsupported statement as fact, hiding a
disagreement between excerpts, or concealing thin evidence. An adapter MUST NOT
re-word it — being first in the prompt is not by itself being stronger, so the
precedence is stated rather than positional.

### REQ-310 — English is a default, not a rule

`LANGUAGE_RULE` MUST state English as the default *unless the audience note asks
for another language*. Before this, "Answer in English" was a rule, and no space
could be answered in any other language.

### REQ-317 — The note cannot forge an evidence delimiter

`audienceNoteBlock()` MUST neutralise runs of `<` and `>` before the note is
rendered. The `structured` tier fences each excerpt as `<<<EXCERPT n>>>` on its
own line, and the note is placed outside every fence, so an unneutralised note
could put a forged excerpt in the prompt — a citation of its index would then
resolve to the **real** passage, stamping that source's title and locator onto a
claim no source makes. Neutralised, not rejected at the write route: this is a
property of how a tier delimits its prompt, and rows written before the guard
must render safely too.

> Found in review of the change that introduced the field. The design was right
> that the note is unreviewed input; the first implementation sealed it out of
> `system` and left the structured tier's delimiter open. REQ-157 would have
> dropped the fabricated *quote*; the marker and the citation row survived.

### REQ-311 — An unset note leaves the request untouched

WHERE a space has no note, or one that is empty after trimming, the request MUST
carry no trace of the field — byte-identical to what the same question produced
before the field existed.

### REQ-312 — The note in force is recorded on the answer

An assistant message's `scopeSnapshot` MUST record the note that shaped it, or
null. On the insufficiency branch, where no model runs, it MUST be null: no note
shaped a text no model wrote.

It is recorded for forensics and MUST NOT be surfaced on the message payload:
showing it beside a saved answer is a product decision this change did not make.
The requirement is that the row can explain an answer that reads oddly after the
note changes, in the same spirit as `model` recording what actually served the
request.

> [!warning] Model behaviour is hand-verified, not asserted
> That the model *obeys* REQ-309 — refusing a widening note while following a
> narrowing one — is a property of model output, like REQ-161 and REQ-162. It is
> verified by hand against a live provider and recorded in
> [[../../plan/space-audience-style/tasks]] "Implementation notes", where the
> 2026-08-28 run is quoted verbatim. One run, one model: the structural
> requirements above are what hold across a provider change.

## Reasoning and progress

Added by [[../../plan/assistant-reasoning-visibility/proposal]]. A reasoning model
spends most of an answer's wall-clock before any answer text exists, so what the
user sees during that time is the whole of §19's "begins displaying" for them.

### REQ-226 — A provider's reasoning channel MUST be surfaced

WHERE a provider streams reasoning separately from answer text, the adapter MUST
emit it as progress and the server MUST forward it to the client. An adapter MUST
NOT discard a reasoning channel the endpoint provides.

- GIVEN a model that reasons before answering
- WHEN it streams reasoning for twenty seconds before its first answer token
- THEN the client receives progress from the first reasoning chunk, not from the
  first answer chunk

### REQ-227 — Reasoning is progress, never product

Reasoning MUST NOT be accumulated into the answer text, MUST NOT be persisted,
and MUST NOT be citable or replayed as history. A stored answer carries answer
text and citations only.

This is the same rule as REQ-159 one step earlier: an answer is not evidence, and
the thinking that produced it is not even an answer.

### REQ-228 — The capability record MUST match the behaviour

`capabilities.thinking` MUST report `adaptive` for a provider that emits
reasoning and `none` for one that does not. An adapter that emits reasoning while
declaring `none` is the same defect as one declaring a citation tier it does not
deliver (REQ-195), pointing the other way.

### REQ-229 — The configured effort MUST reach the provider

The configured answer effort MUST be sent on every answer request. On the
`structured` tier it is passed through unvalidated, because OpenAI-compatible
endpoints do not share a vocabulary for it.

> [!warning] The value ships; its effect is unproven
> `reasoning_effort` was confirmed in the outgoing body at `low`, `medium`, and
> `high`. Whether the measured endpoint *honours* it could not be shown: two runs
> at `medium` produced 11.6 s and 46.8 s, a spread wider than any difference
> between levels. `effortLevels: []` on this provider therefore means **not
> enumerable**, not *not supported* — an overload recorded in
> [[../../plan/assistant-reasoning-visibility/design]] rather than resolved.

### REQ-230 — An OpenAI-compatible request MUST be bounded by the answer timeout

A stalled endpoint MUST fail with the §16 assistant failure and a Retry rather
than hang. The caller's own abort MUST keep working independently, so a closed
tab still stops generation.

### REQ-231 — The pane distinguishes searching, thinking, and answering

The client MUST show three distinct states while an answer is in flight: before
any event, while only reasoning has arrived, and once answer text has arrived.
The reasoning MUST be labelled as thinking, MUST be visually subordinate to an
answer, and MUST be bounded on screen rather than growing without limit.

- GIVEN an answer stream that sends reasoning and no text
- WHEN the reasoning arrives
- THEN a "Thinking…" state is shown with the reasoning beneath it, and it is
  replaced by the answer as soon as the first text arrives

REQ-187 continues to govern the live region: the third state is announced as a
*state*, and reasoning text is never announced.

### REQ-233 — Streamed answer text is revealed at a paced rate

The client MUST reveal streaming answer text progressively rather than in the
jumps it arrives in, MUST NOT reveal a partial `[n]` marker, and MUST show a
stored answer whole — a saved answer is not typed out again on reload. Pacing
MUST NOT delay the end of the answer: when streaming stops, whatever remains is
shown at once.

- GIVEN a segment of ~80 characters delivered in one event
- WHEN it arrives
- THEN it appears over several frames rather than in a single step

This is presentation, not protocol. The received text remains authoritative, and
nothing here changes what is stored or cited.

> The alternative was streaming sub-segment text from the provider, and it was
> measured rather than assumed: the AI SDK's `partialOutputStream` emitted **3
> updates for an answer `elementStream` delivered in 2**, on an endpoint that
> sent ~16 raw chunks for it. `Output.array()` only surfaces whole validated
> elements, so finer text would mean hand-parsing the JSON again and giving up
> the citation-index enum REQ-198 rests on. The jumpiness was therefore fixed
> where it was fixable.

### REQ-232 — The asking state MUST end on `done`, not on the stream closing

The server MUST send `done` as soon as the answer is stored, with titling — a
second provider call — following it. The client MUST hand off to the stored
thread and re-enable asking **on `done`**, and MUST NOT wait for the stream to
close, because the stream deliberately stays open past `done`. A title MUST still
be announced when it completes, so the conversation list refreshes.

- GIVEN a stream that has sent `done` and is still open
- WHEN the title has not yet been generated
- THEN the answer is readable, Ask is enabled, and a new question can be typed

> [!warning] Spec-vs-code
> The code asserted this and did not do it. `await provider.title(...)` sat
> between the stored answer and `done`, behind a comment reading "off the critical
> path". With one reasoning model serving both, the answer was complete at 21.6 s
> and `done` arrived at **56.7 s**.
>
> **Fixing only the server half changed nothing the user could see**, which a
> review caught after the first fix had already been written up as delivered: the
> client settled after its read loop ended, so it still waited for the close. The
> requirement now names both halves, and a test drives `done` on a stream that is
> deliberately left open — the only shape in which the client-side defect is
> visible at all.

> [!warning] Spec-vs-code — embeddings moved to HuggingFace (2026-09-07)
> Retrieval embeds the question through HuggingFace's serverless Inference API
> (`intfloat/multilingual-e5-base`, prefixed `query: `) rather than a local
> Ollama serving `nomic-embed-text`
> ([[../../plan/huggingface-embeddings/design]]). Nothing in the retrieval
> requirements changes — the dimension is still 768 and ordering is still
> cosine — but the latency figures recorded below include a *local* embedding
> call and are now a floor, not a measurement: a hosted call crosses the
> network. Passages embedded by the old model must be re-embedded before these
> requirements hold at all.

## Verification

Backend 178 tests, frontend 122 (from 115 and 103 at the end of Phase 3), all
green, against the running compose stack with real Ollama embeddings.

- **REQ-145, 147, 149–153** — `backend/test/retrieval.test.ts`, ten cases,
  including a paraphrase found only by the vector half, a proper noun found only
  by the full-text half, and a seeded `Note` whose text answers the question and
  never appears. Eligibility is asserted *through* `retrievableSources()`.
- **REQ-146** — asserted by a passage present in both candidate lists ranking
  first.
- **REQ-154–160, 163–165, 167, 171, 177** — `backend/test/answers.test.ts`,
  fifteen cases, against a scripted provider.
- **REQ-158** — every persisted citation is resolved through
  `GET /citations/:id/target` and its block range asserted to contain the
  passage's text. This closes the "inert until Phase 4" note in
  [[../library-reader/spec]]: the route now has a real producer.
- **REQ-169, 170, 172–179** — `backend/test/conversations.test.ts`, eleven cases.
- **REQ-166, 184–190** — `frontend/src/features/assistant/*.test.tsx` and
  `sse.test.ts`, eighteen cases, including an event split mid-JSON across chunks.
- **REQ-161, 164, 168** — verified end to end against the running stack: the
  insufficiency path answered with the provider never called; a real provider
  failure (an invalid key against the live API) surfaced as the §16 message with
  no assistant message persisted, the question kept, and the provider's 401 in the
  server log only; and a blank `ANTHROPIC_API_KEY` refused to boot with the
  actionable message.
- **Mutation checks.** Dropping `archivedAt` from the eligibility clause, stopping
  the page being copied from the passage row, and sending history as documents
  each failed exactly one test. Resolving an out-of-range citation index to
  passage 0 failed **two** — the all-invented case and the mixed case — which is
  coverage, not duplication. Persisting the assistant message before completion
  failed **five**, all of them asserting REQ-165 or REQ-163 from different angles.
  Each mutation was reverted and the suite re-run green.
- **REQ-196–202** — `backend/test/openai-provider.test.ts`: the enum contains
  exactly the indexes sent, the routing guard reaches the endpoint, excerpts are
  numbered, history goes as messages, a delta and a citation are emitted per
  completed segment, the served model is reported, a schema-ignoring server yields
  prose with zero citations, finish reasons map, a non-2xx raises, and no auth
  header is sent without a key.
- **REQ-200/201** — the per-segment guarantee is now the provider abstraction's
  (`Output.array()` + `elementStream`), so the twelve hand-scanner cases that used
  to pin it were **deleted with the scanner**. What is asserted here instead is the
  behaviour that abstraction could take away: an out-of-range `cite` keeps its
  segment's text and loses only the citation.
- **Both tiers through the route** — `answers.test.ts` asserts
  `scopeSnapshot.citationMode` reads `structured` and that a `structured`
  citation still resolves to a real passage with a locator from its row and a
  substring-verified quote; and that `scopeSnapshot.model` names the served model
  rather than the requested one.
- **REQ-203** — `answers.test.ts`: a provider whose text has no markers still
  produces `…costly [1], …everywhere [2].` in both the stream and the stored
  content; a passage cited twice reuses `[1]` and stores one row. Mutation check:
  deleting the insertion fails both.
- **REQ-154, 163, 167, 197** on the `native` tier — `backend/test/anthropic-provider.test.ts`,
  added after the review found the default production adapter had **no tests at
  all**: `citations.enabled` on every document block, `citations_delta` read into a
  citation, the served model from `message_start`, the three stop reasons, the
  system-prompt cache breakpoint, a base URL honoured, and a non-2xx raising.
- **REQ-183** — `conversations.test.ts`: filling the per-user stream budget makes
  asking answer 429 and leaves **zero** messages on the conversation. Mutation
  check: registering after the write fails it.
- **Phase 4 unchanged** — the config refactor's gate: every pre-existing
  assistant test passes with no new configuration set, and the frontend suite is
  untouched at 121, which is the evidence that the port was the right shape.
- **§19 retrieval, measured** at the §5 ceiling: 50 sources, 300 passages, hybrid
  retrieval median 46 ms / p75 52 ms / worst 71 ms, of which ~34 ms is the Ollama
  embedding call. This settles the ANN-index question deferred by Phases 2 and 3;
  the schema comment now records the measurement instead of a deferral.

> [!warning] Outstanding: model behaviour and §19 time-to-first-token
> No provider credential was available in the implementing session, so three
> things are **not** verified: the §19 8 s p75 to first visible content, and the
> model-behaviour halves of REQ-161 and REQ-162 (honest insufficiency,
> conflicting evidence presented without resolution). Everything around the model
> is asserted; the model's own output is not. Whoever first runs this with a key
> should ask the four hand-verification questions in
> [[../../plan/phase-4-assistant/tasks]] and record the transcripts and the
> latency split there.
>
> Two more were added with the provider tiers and are also unverified: whether
> Anthropic's citations survive a proxy on the `native` tier (REQ-197), and
> whether a real OpenAI-compatible endpoint honours the strict schema in practice
> (REQ-198) — the adapter is tested against a stub, not against a live server.

### Reasoning visibility (2026-08-15)

Backend 200 → 207, frontend 149 → 152, both green, no existing test edited.
Verified against the running stack (compose Postgres + Redis + MinIO, real Ollama
embeddings, and a **live** OpenAI-compatible endpoint serving a reasoning model)
— the first time this spec's provider requirements have met a real server.

- **REQ-226, 228** — `backend/test/openai-provider.test.ts`: reasoning becomes
  `thinking` and never `delta`; interleaved channels stay intact; a model that
  does not reason emits no `thinking` at all. Mutation check: dropping the
  reasoning branch fails exactly the first two.
- **REQ-227** — `backend/test/answers.test.ts`: a run with reasoning forwards it
  and the stored `content` contains none of it.
- **REQ-229** — the outgoing request body carries `reasoning_effort`, asserted in
  the adapter test and confirmed by hand at three levels against the live
  endpoint. Mutation check: removing the field fails that test alone.
- **REQ-230** — a stalled endpoint fails as an `AnswerProviderError`, asserted by
  message rather than by class so a different failure cannot satisfy it.
- **REQ-231** — `frontend/src/features/assistant/assistant-pane.test.tsx`: the
  "Thinking…" label appears in place of the searching copy, the live region reads
  exactly `Thinking`, and both label and reasoning are gone once text arrives.
- **REQ-232** — `answers.test.ts` asserts `done` precedes `title` on the stream;
  `assistant-pane.test.tsx` asserts Ask is enabled after `done` on a stream that
  is still open. Mutation checks: restoring the old server order fails the first,
  and removing the client's settle-on-`done` fails the second. The client test is
  the one that matters — the server change alone left the user-visible behaviour
  unchanged.
- **§19, measured end-to-end** through the route against the live endpoint. First
  progress event **21.6 s → 1.6 s**; `done` **56.7 s → 21.1 s**; the answer was
  grounded with a resolved citation in both runs. The §19 8 s p75 to first visible
  content is now **met on this endpoint** — by reasoning, not by answer text,
  which is what REQ-226 exists to make legitimate. First *answer* text remains
  ~20 s and is bounded by the model, not by this code.

- **REQ-238 – REQ-241** — `backend/test/conversations.test.ts` (+1: preview is
  the question, truncated at 140 with `…`; an empty thread answers `null` / `0`);
  `frontend/src/features/assistant/conversation-list.test.tsx` (5: rows are
  links with title / preview / `<time>`, the Source chip, hidden empties, empty
  and loading states, the error, the three date forms);
  `frontend/src/routes/assistant-page.test.tsx` (5: the hub lists and does not
  redirect, one `POST` then the thread with the question in flight and the router
  state cleared, a source picked in the composer reaches `POST` as
  `{scopeType:'source', scopeSourceId}` and re-words the placeholder, a failed
  create keeps the draft, archived hides the composer and keeps the list); `assistant-pane.test.tsx` (+1: the handed-over question is
  asked once across re-renders). Backend 226, frontend 184, lint and build clean
  on both. Not looked at in a browser — see below.

> [!warning] Outstanding: nobody looked at the running app
> The Chrome extension was unavailable, so REQ-231's clamp, the pulse, and the
> three-line bound are verified in jsdom and the compiled stylesheet — neither of
> which has layout. The stream behind it was driven against the real backend and
> the real model; only the pixels are unseen. The same gap
> [[../../plan/space-sidebar/tasks]] recorded, and for the same reason.

### Paced reveal (2026-08-15)

Frontend 152 → 160, no existing test edited.

- **REQ-233** — `use-smoothed-text.test.ts`: the marker boundary (5 cases, the
  part a user would see go wrong), progressive reveal, immediate flush when
  streaming stops, and rewind on a new answer. Mutation checks: disabling the
  marker guard fails exactly the 3 marker cases; disabling the pacing fails
  exactly the 2 behavioural ones.
- **Measured in a real browser**, sampling the rendered answer every frame during
  live answers: **2 distinct rendered lengths before, 219–308 after.** A first
  attempt showed an 84-character mid-stream jump from a dropped frame handing the
  next frame its whole stall as elapsed time; frame time is capped at 1/30 s.

> [!warning] Reduced, not eliminated — and the ending is variable
> Draining the buffer as fast as possible left **617 ms of frozen text** between
> segments, which is what "it still stalls at the citation marker" was: the
> marker is appended immediately after its segment, so the freeze always landed
> just after `[n]`. Pacing to the estimated arrival gap shortened those freezes
> to **250–500 ms** but did not remove them, across three runs.
>
> It cannot remove them. The provider delivers ~6 segments in the last ~1.4 s
> after ~20 s of silence, and nothing on the client can smooth text that has not
> arrived. Pacing longer than the arrival rhythm only moves the problem: with a
> 2 s ceiling the freezes dropped to one and the ending jumped **229 characters**.
> The held backlog is capped for that reason, but the ending still varies **77 to
> 235 characters** run to run, because `done` flushes whatever is unrevealed and
> REQ-232 requires that flush be immediate.
>
> The numbers above are single samples per configuration, on answers the model
> words differently each time. They show a direction, not a precise gain.

> [!warning] Outstanding: whether the endpoint honours `reasoning_effort`
> See REQ-229's callout. The value ships; two `medium` runs 4× apart mean no
> conclusion can be drawn about its effect on this endpoint.

## Cross-references

- [[../../plan/phase-4-assistant/proposal]] — scope and acceptance criteria.
- [[../../plan/assistant-provider-tiers/proposal]] — the second implementation of
  the port (REQ-196 – REQ-201), and why `marker` is still unbuilt.
- [[../../plan/assistant-reasoning-visibility/proposal]] — REQ-226 – REQ-232: the
  reasoning channel that tier was discarding, and the title call that was sitting
  in front of `done`.
- [[../../plan/phase-4-assistant/design]] — the decisions, and the two amended
  during implementation.
- [[../../plan/phase-4-assistant/tasks]] — work breakdown and implementation notes.
- [[../../plan/assistant-chat-history/proposal]] — REQ-238 – REQ-241: the history
  hub, and why a chat is created by its first question.
- [[../library-reader/spec]] — REQ-130/134/137 and the citation target route this
  activates.
- [[../ingestion/spec]] — REQ-088/089 (locators), REQ-100 (archived-space
  writes), REQ-101 (retrieval eligibility).
- [[../spaces/spec]] — the frozen-archived-space rule.
- [[../../wireframe/index]] — `knowledge_assistant`, layout only.
