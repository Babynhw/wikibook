---
title: Phase 4 — Design
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-13
tags: [phase-4, design, retrieval, citations, sse, claude-api]
---

# Design: Phase 4 — Citation-grounded assistant

Phase 3 took one table and two columns. **Phase 4 takes no migration at
all.** `Conversation`, `Message`, and `Citation` were written in Phase 0
with exactly the columns §2 lists, and the reason to say so up front is
that it changes where the risk lives: this phase's difficulty is not the
schema, it is that a wrong answer looks exactly like a right one. Every
decision below is chosen to make a fabricated citation *impossible to
persist* rather than unlikely to be generated.

## API surface

All routes sit behind `requireUser`. Space-scoped routes register
`assertOwnership('space', 'id')`; the conversation and message resolvers
are new (`backend/src/middleware/assert-ownership.ts`), both reaching the
owner through `space.ownerId` the way `passage` and `citation` already do.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/spaces/:id/conversations` | List, most-recently-updated first |
| `POST` | `/spaces/:id/conversations` | Start one — `{ scopeType, scopeSourceId? }` |
| `GET` | `/conversations/:id` | Messages with their citations, oldest first |
| `PATCH` | `/conversations/:id` | Change the active scope — nothing else |
| `POST` | `/conversations/:id/messages` | **Ask.** Answers `text/event-stream` |
| `POST` | `/messages/:id/feedback` | `useful` \| `not_useful` \| `null` (clear) |

Reused unchanged: `GET /citations/:id/target` (Phase 3, inert until now),
`GET /sources/:id/blocks`, `GET /sources/:id/outline`.

There is no `GET /spaces/:id/retrieve` and no way to run retrieval without
asking a question. Retrieval results are not a product surface — the
mockup's "other relevant excerpts" pane is the one that would need one,
and it is out of scope ([[../../wireframe/index]]).

## Decisions

### Retrieval is hybrid, fused by rank rather than by score (decided 2026-08-12)

Two independent queries over `Passage`, both inside
`retrievableSources()`, each returning `RETRIEVAL_CANDIDATES` rows:

```sql
-- vector: exact KNN, cosine distance
ORDER BY p.embedding <=> $queryVector::vector           LIMIT $candidates

-- lexical: the same index Phase 3's search reads
WHERE p.tsv @@ websearch_to_tsquery('english', $q)
ORDER BY ts_rank(p.tsv, websearch_to_tsquery('english', $q)) DESC LIMIT $candidates
```

The two lists are merged by **reciprocal rank fusion** — each passage
scores `Σ 1 / (60 + rank)` over the lists it appears in — and the top
`RETRIEVAL_TOP_K` survive.

Rejected: normalising cosine distance and `ts_rank` onto a common scale
and taking a weighted sum. Those two numbers are not comparable and their
distributions move with the corpus, so the weights would need
recalibrating every time a user adds a source — a knob nobody can tune
against a personal, private evidence set. RRF reads only *ordering*, which
is the only thing both halves agree on, and it has no parameter that
depends on the data. The cost is that fusion cannot express "this vector
match is far better than that one"; a passage that is the single obvious
answer ranks first either way.

Why both halves, rather than the vector search alone: a proper noun, a
statute number, or a participant identifier is exactly the query where
embeddings blur and full-text is exact, and §9's promise is a citation
beside a *specific* claim. And why not lexical alone: §9 expects a
question in natural language to find a paraphrase.

**Every query is built from `retrievableSources()`.** Not "filters by
`state`" — the exported function is spread into the `where` clause, and
the tests assert eligibility through it (`backend/CLAUDE.md`). Current-source
scope adds `sourceId` to that same clause; it never replaces it, so a
question scoped to a source that is archived or still processing cannot
retrieve from it, and the request is refused rather than answered (below).

Notes need no filter. A `Note` is not a `Source`, retrieval reads
`Passage` rows, and no note is ever chunked into one — §9's "notes must
not be evidence" is a property of the data model, not a `WHERE` clause
that could be forgotten. The §12 conversion re-enters through
`retrievableSources()` like any other source. The test seeds a `Note`
whose text answers the question and asserts it never appears.

**Still no ANN index — and this is the last deferral.** Phase 2 deferred
it to "Phase 4, where there is a real retrieval query to measure"
(`backend/prisma/schema.prisma:185`). The query now exists, so [[tasks]]
requires it to be *measured* at the §5 ceiling — 50 sources of real prose
— and the number recorded. Exact KNN over that corpus is a sequential scan
of a few thousand vectors inside a `spaceId` index lookup; if it measures
inside the §19 budget the comment is rewritten from "revisit in Phase 4"
to "measured at MVP scale", because the Prisma drift problem that blocked
a hand-written HNSW index has not changed.

### The retrieval query is the question, verbatim (decided 2026-08-12)

No rewriting, no expansion, no LLM-generated search query.

The cost is stated plainly: **a pronoun-only follow-up retrieves badly.**
"What about the second one?" embeds to nothing useful, so the answer will
often be an insufficiency response even though the model has the previous
turns in context. §9 says follow-ups *may* use previous conversational
context, and they do — as conversation, which is where the referent
actually lives.

Rejected: a `claude-haiku-4-5` rewrite step ahead of retrieval. It buys
better follow-up recall and costs a serial model call inside an 8-second
budget, plus a failure mode nobody can see: the rewrite silently changes
what the user asked, and the citation then supports a question they did
not pose. If hand-verification shows follow-ups failing often enough to
matter, the revisit is a rewrite step *shown in the UI* ("searching for:
…"), not a hidden one — recorded here so the next phase does not
rediscover it.

### One passage is one `document` block (decided 2026-08-12)

The answer call sends the Claude API's native Citations, with
`citations: { enabled: true }` on every document block, and **one block
per retrieved passage**:

```ts
{ type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: passage.text },
  title:  source.title,                       // what §9 requires a citation to name
  context: locatorLabel(passage),             // "Page 7" | "Paragraph 12" | heading
  citations: { enabled: true } }
```

The server keeps the ordered array it sent. A returned citation carries a
`document_index`, and that index *is* an array position, so it resolves to
a `Passage` id by lookup — no string matching, no fuzzy attribution.

**This is the shape the documentation prescribes**, checked 2026-08-12:
"if you want Claude to be able to cite specific sentences from your RAG
chunks, you should put each RAG chunk into a plain text document." A plain
text document is auto-chunked into sentences, so a citation lands on the
sentence rather than on the whole passage — finer than this design needs
and never coarser. Two things confirmed with it: citations must be enabled
on **all or none** of a request's documents, and `cache_control` belongs on
the top-level document blocks (irrelevant here, since the documents change
every question).

One alternative to evaluate in T4 rather than decide now: a `search_result`
content block, which the citations documentation mentions alongside
`document` as a citable block type and which is named for exactly this use.
If it carries source and title natively it may be the better primitive; the
resolution rule above does not change either way. Also available and *not*
wanted: a **custom content** document, whose citations are content-block
index ranges with no further chunking — that is the right choice only if we
ever want the citation to address the whole passage instead of a sentence
inside it.

This is the decision that makes fabrication unpersistable. A citation is
written only if its `document_index` addresses a document we sent; the
stored row's `sourceId`, `passageId`, `page`, `paragraphRef`, and
`sectionHeading` are copied **from the `Passage` row**, and only
`quotedText` comes from the model's `cited_text`. There is no code path
that turns model output into a locator. Citations the model returns that
do not resolve are dropped, and the count is logged (a count, never the
text).

Rejected: one document per *source*, with the whole extracted text as its
data. It is the obvious shape and it puts locator interpretation back
where Phase 3 spent a whole phase removing it from — the returned
`char_location` would be a character offset into a concatenation, which
must then be mapped back to a page by arithmetic over text we did not
index that way. Passage-as-document means the model can only cite a unit
that already has a locator.

Costs, both real:

- **Retrieved order is not document order.** The model sees passages
  ranked by fusion, not as a document; a passage that continues the one
  before it may not be adjacent. `context` carries the locator label so
  the model can see what it is citing, and the answer prompt says the
  documents are excerpts, not a document.
- **Citations are incompatible with `output_config.format`** (the API
  returns 400). So the answer is prose plus citations, and nothing about
  the answer is schema-validated. Insufficiency is therefore recognised
  from *the absence of citations*, not from a structured field (below).

Both scopes use the same shape; current-source scope simply retrieves
within one source, so every document block names the same title.

### The model is `claude-opus-5`, thinking is a latency decision (decided 2026-08-12)

`claude-opus-5` for answers, `claude-haiku-4-5` for conversation titles,
both read from env with those defaults.

§19 gives 8 seconds at p75 to *begin displaying*, and the whole budget
sits before the first token: embed the question (a local Ollama round
trip), run two SQL queries, fuse, build the request, and wait for the
model. Thinking is on by default on `claude-opus-5`, and with the default
`display: 'omitted'` a thinking model shows the user nothing at all until
it starts answering — the exact shape §19 is written against.

So: `thinking: { type: 'adaptive', display: 'summarized' }` with
`output_config: { effort: 'low' }`, and the summary is streamed to the
client as its own event type, rendered as visible progress rather than as
answer text. "Begin displaying" is then honest: the user sees real
content, not a spinner.

Rejected: `thinking: { type: 'disabled' }`. It is the obvious way to cut
time-to-first-token, and on `claude-opus-5` it carries a documented
failure mode that this phase cannot tolerate — with thinking off the model
can leak `<thinking>` tags into visible output, and the recommended fix is
to lower effort with thinking *on*. Grounded prose is also the thing
thinking helps most: deciding whether twelve excerpts actually support a
claim is the judgment the citation depends on.

`max_tokens` is 16000 and it bounds **thinking plus answer**, so a
truncated answer surfaces as `stop_reason: 'max_tokens'` and the client
shows what arrived with a notice — it is not an error, and it is not
silently a complete answer.

**Prompt caching applies to the system prompt only.** The documents change
with every question, so they are past the last breakpoint by
construction; the system prompt gets a `cache_control` breakpoint if it
clears the model's 512-token minimum, and `usage.cache_read_input_tokens`
is what proves it (a number worth recording once, not a feature).

### A refusal is a state, not an exception (decided 2026-08-12)

Three distinct failures, three distinct answers, none of them a 500:

1. **Nothing retrievable.** Zero candidates → answer insufficiency
   **without calling the model.** It cannot hallucinate what it never saw,
   it costs nothing, and it is instant. The message names what was
   searched ("no ready sources in this space", or "nothing in this source
   matched").

   > [!warning] Amended during implementation
   > This first read "zero candidates, **or none above the floor**", and no
   > floor was built. KNN always returns its nearest neighbours, so an
   > off-topic question retrieves passages and does spend a model call;
   > only a scope with no retrievable passages at all is empty. A distance
   > cutoff was rejected on the same grounds as weighted score fusion — the
   > threshold is a tuned constant with no principled value — and because a
   > floor makes the product refuse to *look*, answering "no evidence" for
   > a well-posed question whose source happens to use other words. The
   > model reading the excerpts and saying they do not cover the question
   > is more accurate and is what §9 asks for. Found by running the real
   > stack, not by the suite.
2. **Retrieved but unsupported.** The model answers, cites nothing, and
   says so. An assistant message with zero citations is stored with
   `grounded: false` in its `scopeSnapshot` and rendered as an
   insufficiency answer — no "not grounded" badge bolted onto a confident
   paragraph. This is derived, not a column: citation count already says
   it, and a second source of truth could disagree with the first.
3. **The provider declined or failed.** `stop_reason: 'refusal'` is a
   successful HTTP 200 on `claude-opus-5` whose `content` may be empty, so
   `stop_reason` is checked before `content` is read — indexing `content[0]`
   unconditionally is the bug this sentence exists to prevent. A refusal, a
   timeout, and a transport error all surface as §16's "assistant request
   failure": plain language, the question preserved, Retry offered, and no
   provider detail leaked to the client (§16, §17).

Server-side `fallbacks` to a second model is deliberately **not**
configured. The PRD names one answer model; silently answering from a
different one changes what the product is, and a personal research tool
would rather say "try again" than answer from a model the user did not
choose. Recorded because the recommendation runs the other way, and
because reversing it is one request field.

**Asking inside an archived space is a 409** with Phase 1's message
(REQ-100) — asking is a write, it creates rows. Reading conversations
stays allowed. Asking with a current-source scope whose source is not
retrievable is also a 409, not an insufficiency answer: insufficiency
means "we looked and found nothing", and claiming it here would be a lie
about a source the user can see is archived.

### The answer streams over its own POST response (decided 2026-08-12)

`POST /conversations/:id/messages` responds `text/event-stream` directly,
hijacking the reply the way Phase 2's stream does.

This **corrects an expectation Phase 2 recorded.** That phase called its
Redis relay "the transport Phase 4 reuses for assistant tokens"
([[../phase-2-ingestion/design]]). Phase 4 reuses the *plumbing* and not
the *channel*: the events plugin's `registerUserConnection`,
`trackStream`, and `closeStreamsForUser` all apply, so a leaked tab counts
against the per-user cap and sign-out tears an answer down mid-stream. But
the Redis channel exists because the ingestion worker is a different
process and cannot write to a client socket. The assistant runs in the API
process, in the request that asked, so publishing tokens through Redis
would add a hop, put ordering at the mercy of pub/sub, and fan a private
answer out to every subscriber of `space:<id>`.

Rejected: `POST` returns a `messageId`, the client then opens
`GET /messages/:id/stream` with `EventSource`. It is the shape that keeps
`EventSource` (which cannot POST a body), and it costs a second round trip
inside the 8-second budget plus a server-side buffer for every token
produced between the POST and the subscribe. The client reads the stream
with `fetch` and a small SSE parser instead — about thirty lines, and the
only reason Phase 2's `EventSource` usage stays as it is.

Event types on the stream, one JSON object per `data:` line:

| `type` | Carries |
|---|---|
| `user_message` | The persisted user message id, first — so a reload can find it |
| `thinking` | A summary fragment, for §19 progress |
| `delta` | Answer text |
| `citation` | `{ index, citationId, sourceId, sourceTitle, reference, quotedText }` |
| `sources` | The sources actually used, once, before `done` |
| `title` | A generated conversation title, when this was the first question |
| `done` | `{ messageId, grounded, truncated }` |
| `error` | A §16 message. Never a provider message, never a stack |

**The user message is persisted before the stream opens; the assistant
message and its citations are written in one transaction when the answer
completes.** A client that disconnects mid-answer loses the answer and
keeps the question, and the thread offers Retry — deliberately, because
persisting a half-sentence means a later follow-up treats a truncated
thought as context, and the conversation degrades from a dropped Wi-Fi
connection. Generation is aborted on socket close (an `AbortSignal`
through to the SDK) so a closed tab stops paying for tokens.

Citations are emitted as they resolve, which is why `citation` carries an
`index`: the client renders `[n]` markers inline against the text it has
already received.

### History is context; it is never evidence (decided 2026-08-12)

The last `MAX_HISTORY_TURNS` user/assistant pairs of the conversation are
sent as ordinary `messages`, trimmed to a character budget from the most
recent backwards. They are **not** sent as `document` blocks, so no prior
answer can be cited: §9's "must not use saved assistant answers as
evidence" is enforced by which parameter the text goes into.

Prior assistant turns are sent as plain text with their citation markers
stripped — a `[1]` from three turns ago indexes a document set that no
longer exists, and leaving it in invites the model to reuse a number that
now points somewhere else.

### The scope snapshot records what was retrieved, not just what was asked (decided 2026-08-12)

`Message.scopeSnapshot` on an assistant message stores:

```json
{ "scopeType": "space",
  "scopeSourceId": null,
  "sourceIds":  ["cl…", "cl…"],
  "sourceTitles": ["Informed Consent Practices", "Site B Report"],
  "passageCount": 12,
  "grounded": true,
  "provider": "anthropic",
  "model": "claude-opus-5",
  "effort": "low",
  "citationMode": "native" }
```

`citationMode` holds the capability tier (`native` | `structured` |
`marker`). `provider`, `effort`, and `citationMode` are recorded even though
Phase 4 has exactly one of each. `scopeSnapshot` is already `Json`, so this costs
no migration, and it means every stored answer says what produced it — the
prerequisite for ever offering a model or effort choice, and the only
honest way to show that an answer's citations carry no verifiable quote ([[#the-provider-is-a-port-not-an-sdk-wrapper]]).

§9 requires the scope to be stored with each request, and separately
requires an answer to identify the sources it used. Titles are duplicated
into the snapshot on purpose: a source can be deleted (§17 purges its
citations with it), and an answer that then cannot say what it was based
on is worse than one holding a stale title. This is the same reasoning
behind `Citation.quotedText` existing beside `passageId`.

`Conversation.scopeType`/`scopeSourceId` carry the *current* scope for the
next question; the snapshot is per request. They disagree the moment a
user changes scope mid-conversation, which is exactly why §9 asks for
both.

### No new `AppConfig` key, one new activity gap accepted (decided 2026-08-12)

Retrieval `top_k`, the candidate pool, the history budget, and the answer
timeout are engineering knobs on a query and a network call, not §5
product limits an operator tunes — so they are env vars beside
`INGEST_CONCURRENCY`, not `AppConfig` rows. §5's list is closed and this
phase does not extend it.

No `Activity` rows either: §15's list has "answer saved as a note"
(Phase 5) and not "question asked". Asking is not on the list, so nothing
is written — the same restraint [[../phase-3-library-reader/design]]
applied to archiving.

### Configuration and secrets (decided 2026-08-12)

New env vars, all server-side:

| Var | Default | Note |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required; no dev default, boot fails without it (§17) |
| `ANSWER_MODEL` | `claude-opus-5` | |
| `TITLE_MODEL` | `claude-haiku-4-5` | |
| `ANSWER_EFFORT` | `low` | `low` \| `medium` \| `high` |
| `ANSWER_MAX_TOKENS` | `16000` | Bounds thinking **plus** answer |
| `ANSWER_TIMEOUT_MS` | `120000` | |
| `RETRIEVAL_TOP_K` | `12` | Passages sent as documents |
| `RETRIEVAL_CANDIDATES` | `40` | Per half, before fusion |
| `MAX_HISTORY_TURNS` | `6` | |

`ANTHROPIC_API_KEY` is not a `devCredential()`: the S3 pattern exists so
compose defaults work locally, and there is no local default for a
provider key. A missing key must fail at startup with an actionable
message, next to the existing embedding-dimension gate. The same gate is
what would make a second provider selectable later — **credentials decide
which providers exist, configuration only decides which of those are
offered** ([[#the-provider-is-a-port-not-an-sdk-wrapper]]).

`ANSWER_MODEL` and `ANSWER_EFFORT` are env vars rather than `AppConfig`
rows because in Phase 4 nobody chooses them at runtime. They are the two
that would move into `AppConfig` first if a selector is ever built, and
that move is a widening of §5's closed list — a proposal, not a follow-up
commit.

**Logging.** Question text, answer text, passage text, and citation quotes
are never logged (§17). What is logged: conversation and message ids,
scope type, candidate and passage counts, dropped-citation count, model
id, token usage, and the four latencies (embed, retrieve, first token,
total). That set is what makes §19 measurable without turning the log into
a copy of the user's research.

**Rate limiting.** Asking gets its own bucket — 20 per minute per user;
the reads use the 600/minute read bucket. Every route option object is a
**per-route factory**, not a shared object: `@fastify/rate-limit` pushes
its hook into `routeOptions.onRequest`, and a shared array made every
route in Phase 2's sources file run every other route's limiter
([[../phase-3-library-reader/tasks]] implementation notes). A read route
throttled at the ask route's 20/minute would break the thread on reload.

### The provider is a port, not an SDK wrapper (decided 2026-08-12)

`src/lib/answers.ts` depends on an `AnswerProvider` port shaped by **what
the assistant needs**, not by what `@anthropic-ai/sdk` returns. The
default implementation wraps that SDK; tests inject a scripted provider.

```ts
interface AnswerProvider {
  readonly id: string;                     // 'anthropic'
  readonly capabilities: {
    citations: 'native' | 'structured' | 'marker';
    quote: 'extracted' | 'generated' | 'none';
    thinking: 'adaptive' | 'none';
    effortLevels: readonly string[];
  };
  answer(req: AnswerRequest, signal: AbortSignal): AsyncIterable<AnswerEvent>;
}
// AnswerEvent = thinking | delta | citation { passageRef, quotedText? }
//             | usage | done
```

**Everything that makes a citation trustworthy stays on this side of the
port.** The adapter's only obligation is to say *which document it cited*;
resolving `documentIndex` to a `Passage`, dropping an out-of-range index,
and copying the locator from that row all live in `answers.ts`. So the
invariant survives a provider swap rather than being re-implemented per
adapter — which is the whole reason the port is shaped this way instead of
as "a thing that returns Anthropic messages".

**The precondition, before any tier: retrieval stays ours.** Several
providers offer a server-side retrieval tool that returns structured
file citations — OpenAI's `file_search` is the obvious one — and it is the
tempting path precisely because the citations come back machine-readable.
It is **rejected**, and not over citation format: it means uploading
sources to the provider's vector store and letting *their* retrieval choose
the passages, which takes `retrievableSources()` out of our hands. There
would then be no way to guarantee an archived or `failed` source stays out
of an answer, because selection no longer happens in our SQL. Every
supported tier retrieves with our query and sends the passages inline.

Given that, `capabilities` describes **how a citation comes back**, which
is where providers genuinely differ:

| Tier | Passage id | Quote | Answer shape |
|---|---|---|---|
| `native` | `document_index` into the array we sent, validated on arrival | **API-extracted** `cited_text` | Free prose; citations on their own channel, streaming as `citations_delta` inside `content_block_delta` |
| `structured` | An `enum` of the passage ids we sent — **unavailable to generate** if absent, enforced at decode time | **Model-written**, so it must be substring-verified against the passage | A JSON structure we render into prose |
| `marker` | A sentinel label in the prose, parsed back out | none | Prose with labels mixed into the text |

Verified 2026-08-12 against provider documentation, which moved two of
these rows from where the first draft put them:

- **Anthropic is `native`, on every model.** The docs say plainly that
  *all active models* support citations, so the tier is not a
  model-selection constraint. Streaming has a first-class delta type
  (`citations_delta`), so citations arrive incrementally beside text rather
  than only on the finished block.
- **OpenAI's documented path for citing developer-supplied inline context
  is `marker`, not `structured`.** Its citation-formatting guide injects
  context as tagged blocks carrying ids and has the model emit citations as
  **special Unicode sentinels the models are trained on**, with official
  helpers to parse and strip them. That is materially stronger than an
  ad-hoc `[[P3]]` convention — trained markers plus a supported parser —
  and it is still the `marker` tier, because the citation is text the model
  typed. Its *structured* annotation channel (`file_citation`) exists only
  behind `file_search` / web search, i.e. behind provider-side retrieval,
  which is rejected above. `structured` via strict JSON schema remains
  available on OpenAI as **our** construction, not their recommendation.
- **Gemini has a structured channel that may not require giving up
  retrieval.** `groundingMetadata.groundingSupports` maps byte-offset
  segments of the answer to `groundingChunkIndices` plus a confidence
  score — structurally the same shape as `document_index`. It is produced
  by a grounding source, and one of those sources is *"grounding with your
  search API"*, where Gemini calls **our** endpoint. If that holds, it is a
  fourth shape — provider-orchestrated grounding over our retrieval — and
  it is the one worth checking first if a second adapter is ever needed.
  Unverified: whether grounding metadata can be produced over passages
  passed inline, with no search tool at all.

Two things are easy to get backwards. First, `structured` is **not** a weak
tier: constrained decoding over an `enum` is at least as strong as
validating an index after the fact, and since the quote is
substring-verified in *both* cases, the difference in trustworthiness
narrows to "one almost never fails the check, the other sometimes does".
Second, the real cost of `structured` is not correctness but **streaming**:
the answer arrives as JSON being generated, so showing text early means
parsing incomplete JSON — a genuine incremental parser, aimed straight at
§19's 8 s budget. That is the trade to weigh, not grounding strength.

`marker` is the floor, and the only tier where the degradation is real: no
quote, and a label the model can attach to a passage it did not use, with
nothing to check it against.

All tiers keep the two rules that matter — an id outside the set we sent is
dropped and counted, and the locator is copied from the `Passage` row — so
in every tier a citation link opens a real passage, in the right space,
within the asked scope, at the right page.

Nothing in Phase 4 builds a second adapter: a port with one implementation
is a guess, and only a second real provider turns it into a contract.
Shaping it from the requirement rather than from the SDK is what makes that
guess cheap.

> [!note] What is and is not verified
> The `native` row is checked against the Anthropic citations documentation.
> The non-Anthropic rows are checked at the level of *mechanism* only —
> exact request and response field names were not exercised against a live
> API, and Gemini's inline-document case is an open question. Verify before
> writing a second adapter.

**One adapter ships.** Selecting a provider is an operator concern gated
by credentials in env (§17 keeps secrets out of the DB and the browser),
so a provider is selectable only when its key is present at boot — the
rule that stops a selectable model from being a 500. A user-facing model
or effort selector is a feature the PRD does not describe and needs its
own proposal; what Phase 4 owes it is this port, the `capabilities`
record, and the snapshot fields below. Two consequences to inherit rather
than rediscover: §19's 8 s would have to be stated per effort mode
(`thorough` will not meet it), and **embeddings are a separate provider
decision**, frozen by `vector(768)` and by having no backfill — changing
that model means a migration and a full re-embed, so "switch providers"
never silently includes it.

Mixing models across turns of one conversation is already safe: history is
sent as plain text with markers stripped ([[#history-is-context-it-is-never-evidence]]),
so no provider-specific reasoning block is ever replayed to a different
model.

This also draws the line between what CI can assert and what it cannot. CI
asserts everything *around* the model: which passages were retrieved,
which documents were sent, that a citation with an out-of-range
`document_index` is dropped, that locators come from the `Passage` row,
that a zero-citation answer is stored ungrounded, that a disconnect
persists nothing, that history is not sent as documents.

Model behavior — that the answer is actually insufficient when the
evidence is thin, that a conflict is presented without being resolved,
that citations sit beside the claims they support — is **hand-verified
against the real API and recorded in the implementation notes with the
transcript**, not asserted in CI. A test that asks a model to disagree
with itself and asserts on the prose is a flake with a rationale, and the
honest alternative is an eval harness, which is out of scope.

## Frontend

### Structure

```
src/features/assistant/
  use-conversations.ts     list + create, cache patched on new
  use-conversation.ts      messages with citations
  use-ask.ts               fetch + SSE parse, abort, optimistic user turn
  sse.ts                   the ~30-line parser (no EventSource: POST body)
  assistant-pane.tsx       thread + composer, mounted as pane or page
  scope-selector.tsx       always-visible scope (§9)
  message-list.tsx
  answer-message.tsx       inline markers, sources-used footer, feedback
  citation-marker.tsx      [n] → resolves ?cite= and navigates
  conversation-list.tsx
src/routes/
  assistant-page.tsx       /spaces/:spaceId/assistant/:conversationId?
```

Phase 3 built `source-reader.tsx` as a component taking props "so Phase 4
can mount it in a pane" ([[../phase-3-library-reader/tasks]] T10). That
promise is kept: on a wide viewport the assistant page renders the thread
and the reader side by side, and clicking `[1]` opens the reader in the
pane instead of navigating. Below the breakpoint, and at §18's 320 px, the
marker navigates to the reader route with `?cite=` and `?from=`, and
Phase 3's back control returns. One resolution path, two presentations.

### The citation marker

`[1]` is a `<button>`, not a superscript — it does something, and §18
wants the semantic element. Its accessible name says where it goes
("Citation 1: Informed Consent Practices, page 7"), because "1" announced
alone is useless. On activation the client asks
`GET /citations/:id/target` and navigates to the URL that route's contract
defines; it never assembles a reader URL from the citation payload, which
is the whole reason Phase 3 put locator interpretation in one place.

A citation whose target reports `stale: true` still navigates — Phase 3's
reader says the exact passage is gone and shows the recorded page
(REQ-134). The marker does not hide it.

### The streaming answer and assistive technology

The answer region is `aria-live="polite"` but **the deltas are not what is
announced.** A token-by-token live region reads a sentence to a screen
reader eight times. The live region carries status ("Searching your
sources", "Answering", "Answer complete, 2 citations"), and the answer
text is an ordinary region the user navigates to when it settles. §18 asks
for state changes to be announced, not for the content to be re-read.

The composer keeps its text until the answer is stored, so a failure
leaves the question where the user can resend it (§16). Retry re-sends the
same question rather than restoring a partial answer — there is no partial
to restore, by design.

### States

- **No conversations** — the §16 state, with the scope selector already
  visible and a prompt to ask something, not an empty panel.
- **No relevant evidence** — the insufficiency answer, rendered as an
  answer in the thread with no citation markers and no sources footer;
  where the space has no ready sources at all, it links to the library.
- **Assistant request failure** — the question preserved, plain language,
  Retry (§16).
- **Archived space** — the composer is disabled with Phase 1's message and
  the thread stays readable.

## Migration and dependencies

**Migration: none.** `Conversation`, `Message`, and `Citation` already
carry every column this phase writes, including `Message.feedback` and
`Message.scopeSnapshot`. `grounded` is derived from citation count and is
not a column ([[#a-refusal-is-a-state-not-an-exception]]).

**Dependencies:** `@anthropic-ai/sdk` in the backend, and nothing in the
frontend — the SSE parser is written rather than installed, because the
alternative is a dependency for thirty lines of `TextDecoder` and a split
on `\n\n`.

## Testing

- **Retrieval** (`backend/test/retrieval.test.ts`): a paraphrase found by
  the vector half and not the lexical one; a proper noun found by the
  lexical half and not the vector one; fusion ranking a passage present in
  both above one present in either; current-source scope returning
  nothing from a second source; a `processing`, a `failed`, and an
  archived source all absent — asserted through `retrievableSources()`;
  a source in another space of the same user absent; a seeded `Note`
  whose text answers the question absent; a punctuation-only query
  answering rather than throwing.
- **The answer request** (`backend/test/answers.test.ts`, scripted
  client): one `document` block per retrieved passage, each with
  `citations.enabled`; history sent as `messages` and never as documents;
  markers stripped from prior assistant turns; the system prompt's cache
  breakpoint present.
- **Citation persistence** — the tests this phase is really for: a
  citation with an out-of-range `document_index` is dropped and counted; a
  persisted citation's `passageId`, `page`, and `paragraphRef` equal the
  `Passage` row's and not anything the scripted client returned; a
  citation's `quotedText` round-trips; every persisted citation resolves
  through `GET /citations/:id/target` to a block range whose text contains
  the passage's text — closing the loop Phase 3 opened.
- **Insufficiency**: an empty retrieval answers without calling the client
  at all (asserted by a client that throws if called); a scripted
  zero-citation answer is stored and reported ungrounded.
- **Failure paths**: `stop_reason: 'refusal'` with empty `content` becomes
  a §16 error event and persists no assistant message; a client error
  becomes the same event with no provider text in it; a client abort
  mid-stream persists the user message and no assistant message.
- **Conversations** (`backend/test/conversations.test.ts`): create, list
  ordered by `updatedAt`, messages with citations oldest-first, scope
  `PATCH`, 404 for a foreign conversation and a foreign message, 409 for
  asking in an archived space and for a current-source scope on an
  archived source, feedback set / changed / cleared and rejected on a
  user-role message, and a title-generation failure leaving a usable
  title.
- **Mutation checks**, each must fail exactly one named test: drop
  `archivedAt` from the retrieval filter; let a citation keep the scripted
  client's page instead of the passage's; accept an out-of-range
  `document_index`; send history as documents; persist the assistant
  message before the stream completes. **Not done until the mutation is
  reverted and the suite is green** ([[../phase-2-ingestion/tasks]]).
- **Frontend** (Vitest + Testing Library): a stubbed SSE stream rendering
  deltas in order and markers inline at the right offsets; a marker
  resolving `?cite=` through the target route and opening the reader; the
  three §16 states; feedback toggling; the composer keeping its text on
  error and Retry re-sending; scope visible at all times and changing it
  persisting; the live region announcing status rather than tokens.
- **§19, measured and recorded as numbers**: time-to-first-visible-content
  over ten real questions against 50 sources, reported as p75 with the
  embed / retrieve / first-token split, plus the exact-KNN retrieval time
  at that ceiling — which is also the ANN-index decision.
- **Hand-verified against the running stack and the real API**, with
  transcripts in the implementation notes: a grounded answer whose
  citations open the right passages; two contradicting sources presented
  without resolution; a question the evidence cannot support; a
  current-source question about content that only exists in another
  source; a follow-up relying on the previous turn; a conversation
  surviving a refresh.

## Cross-references

- [[proposal]] — scope and acceptance criteria.
- [[tasks]] — work breakdown, split by codebase.
- [[../phase-2-ingestion/design]] — the passages, embeddings, locators,
  and SSE plumbing this builds on, and the Redis-channel expectation this
  corrects.
- [[../phase-3-library-reader/design]] — "The reader's URL is the citation
  contract" and the `?cite=` form this supplies.
- [[../phase-1-spaces/design]] — the frozen-archived-space rule.
- [[../../specs/ingestion/spec]] — REQ-088/089, REQ-100, REQ-101.
- [[../../specs/library-reader/spec]] — REQ-130/134/137 and the citation
  target route.
- [[../../wireframe/index]] — `knowledge_assistant`, layout only.
