# Wiki log

Append-only. Entry format: `## [2026-08-28] update | Phase 7 review fixes

Code review of the uncommitted Phase 7 work, no blocker. Fixed: `note.edited`
joins the `PATCH` transaction (a failed feed write could 500 a committed save);
`/activity?limit=` clamps as REQ-265 says instead of 400; the "row inserted
between pages" cursor case and the backend §17 secret-surface grep are now real
tests (both boxes had been ticked without them); `REDACT_PATHS` derived from one
list with `email` added; `useActivity` drops its cache on unmount; `Button`
merges refs; Escape no longer discards a dirty note draft. Details in
[[plan/phase-7-home-and-hardening/tasks]] "Review fixes"; [[specs/notes/spec]]
REQ-271 gains the transaction clause.

## [YYYY-MM-DD] <verb> | <title>`.

## [2026-08-10] bootstrap | Wiki initialized

AGENTS.md adapted from the Folio template to WikiBookLM (Fastify/Prisma
backend, Vite/React frontend, Claude + local Ollama). Created `index.md`
and this log.

## [2026-08-10] create | Plan: phase-0-foundation

Created `plan/phase-0-foundation/` (proposal, design, tasks) for the
project foundation: monorepo, docker-compose infra, backend/frontend
skeletons, Ollama embeddings client, session auth + assertOwnership.
Status: proposed.

## [2026-08-10] update | Phase 0 implemented and verified

All Phase 0 tasks (T1–T5) landed; plan set to `status: done`. Verified from a
wiped database: compose healthy → migrate → seed → `/health` all-OK →
768-dim embedding from Ollama → 12 backend tests → register/refresh/logout/
login/forgot/reset end-to-end through the Vite proxy.

## [2026-08-10] create | Spec: auth

Wrote `specs/auth/spec.md` (REQ-001…REQ-053) from the verified behavior:
accounts, sessions, sign-in, password reset, ownership, error envelope.
Records what is not yet automatically tested, and that reset delivery is
console-only pending an email provider.

## [2026-08-10] update | Phase 0 backend hardening

Code review of the Phase 0 backend found a concurrent-registration race
answering 500 (an existence oracle REQ-004 forbids), `/health` returning raw
dependency error messages to unauthenticated callers, and reset tokens logged
with nothing preventing that in production. Fixed all three plus six smaller
items (argon2 catch symmetry, `EmbeddingError.code` replacing a regex that
gated `process.exit`, embed body-read timeout scope, URL-validated connection
strings, `loadLimits` stampede coalescing, helmet). Suite grew 12 → 29 tests.
Spec gains REQ-034 and REQ-054; REQ-004 and REQ-022 tightened.

## [2026-08-11] update | Phase 0 frontend review pass

Code review of the Phase 0 frontend found the session-state unhappy paths
unfinished: `useCurrentUser` distinguishes "signed out" from "request failed" but
`RequireAuth` ignored the difference (a transient failure logged users out), no
401 outside `/auth/me` was recognised as a lost session, `queryClient.clear()`
erased the `me: null` set the line before, and the guard's `state.from` was
written but never read. Also fixed: DESIGN.md's Inter/JetBrains Mono were declared
in tokens but never loaded (now self-hosted via `@fontsource-variable`), no error
boundary, `role="alert"` on confirmations, missing default `type="button"`, a
non-JSON 2xx passed through as `null`, and a dead `--radius-DEFAULT` token.
Spec: REQ-016 amended, REQ-017/018/019 added, REQ-053 refined. Frontend still has
no test runner — six client-side REQs are unexercised, now the spec's biggest gap.

## [2026-08-11] update | Frontend test runner + client-side REQ coverage

Vitest + Testing Library (jsdom) set up in `frontend/`; 38 tests across 7 files now
cover every client-side requirement the auth spec had listed as unverifiable —
REQ-016/017/018/019/052/053 — plus the api client's envelope, fallback, and
transport branches. `fetch` is stubbed with real `Response` objects, so no backend
or Docker is needed. `createQueryClient()` was extracted from `main.tsx` to make
the session-lost rule (REQ-018) assertable. Each of the six fixes from the review
pass was mutation-checked: re-introducing the defect fails exactly the intended
test. Remaining spec gaps (REQ-012/013/022-timing/023/034) are all backend-side.

## [2026-08-11] ingest | Wireframes: five sample screen designs

`wiki-docs/wireframe/` added (login, source_library, knowledge_assistant,
saved_notes, research_notebook — each `screen.png` + standalone `code.html`).
Catalogued in `wireframe/index.md`: per-screen mapping to phase and spec, a
vocabulary table (Folio → WikiBookLM, "Project" → Space), and the out-of-scope
list — the mockups show reading statuses, tags, social sign-in, trash, and
cross-space search, which §20 excludes or no spec describes. Their palette does
match DESIGN.md, but they are Tailwind v3 CDN so the markup must not be copied.
AGENTS.md gains a Wireframes section and treats the folder as immutable like
`raw/`; root README and frontend/CLAUDE.md now point at the catalog.

## [2026-08-11] create | Plan: phase-1-spaces

Created `plan/phase-1-spaces/` (proposal, design, tasks) for research spaces:
CRUD, archive/restore, last-opened ordering, the §4 new-space empty states, and
the first routes guarded by `assertOwnership`. No migration needed — the `Space`
model landed in Phase 0. Decisions recorded: the notebook is **lazy-created** on
first access (the `Notebook?` relation already allows absence, and Phase 6 owns
the Tiptap document shape); archived spaces are frozen, answering 409 on writes,
mirroring the retrieval invariant at space level; `POST /spaces/:id/open` stamps
`lastOpenedAt` so refetching a space cannot reorder the user's list; resume is a
sort order, not a redirect; name/objective validation lives in zod, not
`AppConfig` — the phase adds no new limit. Status: proposed.

## [2026-08-11] update | Phase 1 implemented and verified

All Phase 1 tasks (T1–T6) landed; plan set to `status: done`. Backend:
`src/routes/spaces.ts` — list/create/read/patch/open/archive/restore, every
`:id` route behind `assertOwnership`, 8 new tests (29 → 37). Frontend: the home
screen is now the space list with active/archived tabs, create and edit dialogs,
an archive confirmation, and a `/spaces/:id` shell rendering §4's new-space
state; 11 new tests (38 → 49). One real defect surfaced while testing: Fastify
validates the body before `preHandler`, so an anonymous request with a bad body
answered 400 instead of 401 — `requireUser` moved to `onRequest`. Two behaviors
were mutation-checked (the archived guard before `open`, and `GET` stamping
`lastOpenedAt`); each made exactly the intended test fail. Verified by hand
against the running stack through the API; **not** verified in a browser — the
Chrome extension was not connected, so nothing was looked at on screen.

## [2026-08-11] create | Spec: spaces

Wrote `specs/spaces/spec.md` (REQ-055…REQ-077) from the verified behavior:
creation and validation, ordering and the resume rule, archive as a
non-destructive frozen state, ownership and pre-validation auth, the lazy
notebook, and the client's empty states, dialog accessibility, and new-space
shell. Records what is untested and that no browser pass happened.

## [2026-08-11] create | Schema: specs/AGENTS.md

`AGENTS.md` had pointed at `specs/AGENTS.md` for the spec format since the wiki
was bootstrapped, but the file never existed — both specs so far were written by
imitating `auth/spec.md`. Written now from what the two specs actually do: file
shape and frontmatter, the REQ format (RFC 2119 + optional GIVEN/WHEN/THEN), id
rules (globally unique, never renumbered or reused — `auth` reserved a block per
section, `spaces` numbered contiguously, both allowed), the three callout types
with `Spec-vs-code` mandatory when a spec is edited to match code, what a
`## Verification` section must record (including mutation checks), the plan-folder
structure and the five-step feature workflow, and grep commands for finding
duplicate or missing ids. The Phase 1 tests were then renamed to cite their REQ
ids, which is the convention the new file documents and `frontend/CLAUDE.md`
already required; suites unchanged at 37 and 49.

## [2026-08-11] update | Phase 1 closed: UI reviewed and accepted

The user reviewed the Phase 1 screens in a browser and accepted them, closing the
last open exit criterion. The "not verified in a browser" warning in
`plan/phase-1-spaces/tasks.md` and `specs/spaces/spec.md` becomes a note: the
visual pass happened, but it was human and one-off — nothing automated covers
layout or design-token adherence, so a token regression would still pass CI.

## [2026-08-11] update | Phase 1 code review: fixes and spec amendments

Reviewed the uncommitted Phase 1 diff before committing it. One blocking bug:
`Dialog`'s focus effect depended on `onClose`, which every caller passes inline,
so any parent re-render while a dialog was open dragged focus back to the first
field mid-typing — and the primitive's claim that "every behavior is asserted"
was what justified hand-writing it, with no `dialog.test.tsx` in the repo. Also
fixed: restore failing silently, unthrottled space writes (`rateLimit` is
`global: false`), the archived check moved inside the write, and the filter tabs
finished as a real tablist. REQ-057/065/073/074 amended, REQ-078 (rate-limited
writes) and REQ-079 (tablist) appended; `specs/spaces/spec.md` REQ range is now
055–079. Suites 37 backend (unchanged count, more assertions) and 49 → 63
frontend; five mutation checks recorded in `## Verification`.

## [2026-08-12] create | Phase 2 plan: source ingestion

Phase 1 closed, so the next item on the §6 roadmap is ingestion — and the
Phase 0 infrastructure built for it (Redis, the Ollama client, the `Source` /
`Passage` tables with their `vector(768)` and `tsvector` columns) has never
been exercised. `plan/phase-2-ingestion/` covers PDF / web / manual sources,
the queued pipeline, the processing states with retry and confirmed delete,
and PRD §5's four limits, which finally get their first consumer.

The decisions worth remembering: original files go to the **local filesystem**
under `STORAGE_DIR` — so encryption at rest (§17) is a host obligation, written
down because it otherwise lives nowhere; the worker is a **separate process** so
a 200-page PDF parse cannot stall the API event loop; **retry is guarded by
source state** (409 unless failed), with BullMQ's `jobId` only as a second line
of defence, because a dedup key that expires on completion cannot express "this
source is already being worked on"; failures split into retryable (embedding
unreachable, 5xx) and permanent (corrupt PDF, no text layer, over the page
limit) so a user error is not delayed by three backoffs; and `pdf_max_pages` is
the one limit that produces a *failed source* rather than a rejected request,
since page count is unknowable before parsing. The Passage ANN-index question
the Phase 0 schema deferred "to Phase 2" was revisited and deferred again — to
Phase 4, where there is a real query to measure. `retrievableSources()` is
defined now, against a consumer that does not exist yet, because §6/§9/§17 state
the invariant three times and its failure mode is silent.

## [2026-08-12] update | Phase 2 plan: object store and SSE

Two decisions reversed on review, before any code exists. Original files move
from the local filesystem to an **S3-compatible object store** (MinIO in
docker-compose): encryption at rest (§17) becomes a bucket setting that can be
asserted instead of a host property nobody can check from inside the app, and
the API and worker — split into separate processes by this same phase — stop
needing a shared disk. Two consequences are written into the design rather than
discovered later: files are **proxied** through `GET /sources/:id/file` rather
than presigned, because §17 makes ownership a per-request obligation and a
presigned URL works for whoever it is pasted to; and object deletion is a
**queued `purge-object` job** after the row is deleted, since neither deletion
order is free and a dangling object is more recoverable than a source whose file
silently vanished.

Polling is replaced by **SSE** on `GET /spaces/:id/events`. The argument that
settled it is Phase 4: the assistant streams tokens over SSE regardless, so the
transport gets built either way. The cost is real and now enumerated — the
worker is a different process, so it publishes to a Redis channel and the API
relays; the subscriber needs its **own** ioredis connection because subscriber
mode refuses ordinary commands and `app.redis` belongs to BullMQ; there is no
event replay, so the client refetches the list on every reconnect and the stream
is a latency optimization over that refetch; and a defined 5 s poll fallback
after two failed opens keeps §16 honest where SSE is stripped.

## [2026-08-12] update | Phase 2 implemented: source ingestion end to end

PDF / web / manual ingestion is built and verified, and
[[specs/ingestion/spec]] records the behavior at REQ-080 – REQ-109. Backend
63 → 87 tests, frontend 63 → 82. The §21 scenario was run by hand against the
real stack: three sources to `ready` with each transition arriving over SSE, a
fourth failed by stopping Ollama and recovered by Retry, and a delete that left
no object in the bucket. A 24-page text PDF processed in about a second against
§19's two-minute budget.

Two things the suite could not have told us, both worth remembering. `chunk.ts`
had been left with a mutation-check edit still in it — a syntax error that kept
`pipeline.test.ts` from loading, so eight tests silently never ran; a mutation
check is not done until the mutation is reverted and the suite is green. And
`POST /sources/:id/retry` answered 200 while queueing nothing, because BullMQ
keeps settled jobs and `add` with an existing `jobId` is a no-op — every retry
after the first failure left the source stuck in `processing`. Both now have
named regression tests. Deviations (the worker runs as a host process rather
than a compose service; the badge only renders non-ready states) are in
`plan/phase-2-ingestion/tasks.md`.

## [2026-08-12] update | Phase 2 code review: two defects fixed, four gaps closed

A review of the phase's uncommitted diff found two real defects, both hidden by
a fixture that avoided the failing shape. `chunkBlocks` truncated an over-long
paragraph instead of splitting it whenever the split landed on whitespace —
5,999 characters of ordinary prose in, 1,199 out — because the loop tested the
*trimmed* piece against the target; the test used `'y'.repeat(2400)`, which has
no whitespace to land on. And the SSRF guard's IPv4-mapped branch was dead code:
it matched a dotted quad, but `URL` had already rewritten the host to
`::ffff:7f00:1`, so `http://[::ffff:169.254.169.254]/` was fetched.

The pattern in both is the same and worth keeping: **a test whose fixture cannot
express the failure is not coverage**. Both defects sat behind passing,
deliberately-written tests. The guard now works on the parsed numeric address
rather than the hostname text, which is the only form that survives `URL`.

Also closed: REQ-087 had no test (an enqueue failure could have shipped leaving
sources stuck in `processing`), REQ-100's upload case was unasserted, the
`ensureBucket()` fallback created unencrypted buckets against REQ-109, and
`/auth/reset` closed no streams because it read `request.user` on the
unauthenticated path. [[specs/ingestion/spec]] records all of it; the new
integration tests are unexecuted (no Docker in that session) and are flagged
there as such.

## [2026-08-12] create | Phase 3 plan: source library and reader

[[plan/phase-3-library-reader/proposal]] scopes PRD §7/§8 — in-space search
(title/author/content), type filters, archive/restore and metadata editing for a
source, and the reader that a citation deep-links into. Status `proposed`.

The phase turns on one thing the earlier phases left unreachable: Phase 2's
locators are exact and have no destination, and `retrievableSources()`'s
`archivedAt` filter has no route that can set the column. Two decisions carry
the design. Ranking is a **tier**, not a weight — §7 says title matches rank
above content-only ones, and `setweight('A')` can only make that usually true,
so `metadata_match DESC` leads the `ORDER BY` and `ts_rank` breaks ties within
it. And the reader's units are **persisted blocks**, not re-split `Source.content`
and not the passages: page number is unrecoverable from the concatenation
(which §8 makes an acceptance criterion), and rendering passages would show the
chunker's ~15% overlap as visibly repeated text. So Phase 3 takes the schema
change Phase 2 avoided — a `SourceBlock` table plus `Passage.startBlockOrd` /
`endBlockOrd` — and a citation highlight becomes a range lookup rather than a
substring search. No backfill: pre-migration sources fall back to the recorded
locator, and the dev instruction is to reset the volume.

Deliberately not built: the PDF is not rendered in the browser (a `pdf.js` text
layer would re-derive the locators this phase exists to trust), extracted content
is not editable (the passages and citations built from it would still describe
the old text), and there is no disabled "Ask about this source" button — §8's
current-source scope is Phase 4's. `GET /citations/:id/target` is specified and
built now so locator interpretation lives in one place, and is marked inert until
there is a producer.

## [2026-08-12] update | Phase 3 built: search, metadata, archive, and the reader

[[plan/phase-3-library-reader/tasks]] is done and [[specs/library-reader/spec]] is
written from what was verified (REQ-110 – REQ-144). Backend 93 → 114 tests,
frontend 82 → 100; both suites and both type-checks green. The §7/§8 behavior was
also driven by hand over HTTP against the running stack — real worker, real Ollama
embeddings, a real fetch of `example.com`, and an uploaded 3-page PDF — because the
Chrome extension was unavailable, so the reader's *rendering* rests on its Vitest
suite and that gap is a callout in the spec.

Two things the plan got wrong, both worth keeping. The design specified a reader
URL contract built on `?passage=<id>` and then listed no route that could resolve
one: `/citations/:id/target` was there, but Phase 3 has no citations. `GET
/passages/:id` was added, answering the same locator shape and deliberately
*without* the passage text — the reader highlights a block range and has no use for
it. And measuring §19 turned up a bug the suite could not see: reads were being
rate-limited at the write routes' 60 per minute, because `@fastify/rate-limit`
*pushes* its hook into `routeOptions.onRequest` and Phase 2 shared one options
object across every route in the file — so each route ran every other route's
limiter. Searching is one request per settled query, so a user typing for two
minutes started getting 429s. Route option objects are now per-route factories, and
70 consecutive searches is the regression.

Smaller lessons, all now written into the code as comments: a `min`/`max` on a
number field makes the browser *block* an out-of-range submit, so "typing 99 lands
on the last page" needed the attributes gone and the clamp in JS; an unguarded
`scrollIntoView` (absent in jsdom) threw inside an effect and unmounted the whole
reader; and a deep link raced its own lookup until the reader learned to wait for
the passage to resolve before choosing a page. `websearch_to_tsquery` also turned
out to honour a bare `-` as negation, so a punctuation-only query returns nearly
everything rather than nothing — kept, and the test now asserts the operator
semantics instead of the emptiness the first draft assumed.

Phase 2's outstanding caveat is closed: its integration tests had never run, and
they do now. The single failure was the suite's own — an eleventh `registerUser`
against a 10-per-minute cap, surfacing as a 429 that looked like a delete bug.

§19 on this machine: search over 50 sources worst-case 24 ms against a 500 ms
budget; a 200-page PDF's reader at page 190 answered in 1.9 ms. The migration adds
`SourceBlock` and two `Passage` columns with **no backfill** — pre-Phase-3 sources
open through the fallback with no text to page through, and the README says to
re-add them while the project is pre-release.

## [2026-08-12] update | Phase 3 code review: two defects fixed, four gaps closed

Reviewing the Phase 3 diff before commit turned up two real backend defects, both
invisible to the tests that existed. `POST /sources/:id/archive` built its route
table with `['archive', new Date()]`, so the timestamp was evaluated once at plugin
registration: every archive for the life of the process recorded the server's boot
time, and on a long-running server an `archivedAt` could precede its source's
`createdAt`. The idempotency test could not see it — archiving twice and asserting
the stamp did not move is exactly what a frozen date also satisfies. And
`PATCH /sources/:id` declared `author` as `.nullish().transform(v => v ?? null)`,
which turns an *absent* key into an explicit null that Zod keeps in the parsed
body: a title-only edit erased the stored byline. Recorded as REQ-122 and REQ-123.

Three smaller reader/library gaps, now specced: the reader printed "Showing the
cited passage" for a `?page=`-only link that highlights nothing (REQ-134 — the copy
now distinguishes the two, and [[plan/phase-3-library-reader/design]] step 3 is
amended, since it had promised a page-wide highlight that neither shipped nor
should); the reference kept naming page 2 after the user paged away (REQ-137); and
the search input adopted its own URL echo, which could discard a keystroke typed
during the debounce commit (REQ-118). `?page=` combined with `?from=` was left
emergent and is now pinned as "narrow, don't compete" (REQ-130).

The archive fix was mutation-checked: reintroducing the hoisted `new Date()` fails
the new assertion and nothing else. Backend 115 tests green, frontend 103.

## [2026-08-12] create | Phase 4 plan: citation-grounded assistant

Phase 3 built the destination of a citation link; this plan builds the producer.
`plan/phase-4-assistant/` covers PRD §9: hybrid retrieval, streamed grounded
answers, conversations, insufficiency, feedback, and the `?cite=` deep link that
takes `GET /citations/:id/target` out of the inert state Phase 3 left it in.

The phase takes **no migration** — Phase 0 wrote `Conversation`, `Message`, and
`Citation` with exactly the columns §2 lists, so the risk is not schema, it is
that a wrong answer looks like a right one. The decisions are picked to make a
fabricated citation impossible to *persist*: one retrieved passage is one
`document` block, so a returned `document_index` is an array position that
resolves to a `Passage` row, and the stored locator is copied from that row
while only the quoted text comes from the model. An out-of-range index is
dropped and counted.

Retrieval fuses a pgvector KNN list and a `websearch_to_tsquery` list by
reciprocal rank fusion rather than by a normalised weighted score — cosine
distance and `ts_rank` are not comparable, and weights would need recalibrating
per corpus. Both halves spread `retrievableSources()` into their where clause;
current-source scope adds `sourceId` to it rather than replacing it, so a
question cannot be scoped to an archived source.

Two things the plan corrects or settles. Phase 2 recorded its Redis channel as
"the transport Phase 4 reuses for assistant tokens"; Phase 4 reuses the stream
*plumbing* (per-user connection cap, sign-out teardown) but answers on its own
POST response — the assistant runs in the request that asked, so a pub/sub hop
would only add latency and fan a private answer out to a space-wide channel. And
the ANN index deferred twice with "revisit in Phase 4" is required to be
measured and settled here, since the real query finally exists.

Thinking stays on (`adaptive`, `summarized`) at `low` effort rather than being
disabled: §19's 8 s is time to *begin displaying*, the summary gives the user
real content to see, and disabled thinking on `claude-opus-5` can leak internal
tags. Also written down as costs rather than discovered later: the retrieval
query is the question verbatim, so a pronoun-only follow-up retrieves badly, and
the Citations API is incompatible with structured outputs, so insufficiency is
recognised from the absence of citations rather than from a schema field.

Model behavior — conflicts presented without resolution, honest insufficiency —
is hand-verified against the real API with transcripts recorded, not asserted in
CI. Spec will number from REQ-145.

## [2026-08-12] update | Phase 4 plan: the provider becomes a port

Asked what happens if a different LLM provider is used, and what a later
"user picks the model and thinking level" feature would take. The answer changed
one decision in [[plan/phase-4-assistant/design]] and nothing else.

**Native citations are the one thing that is not portable**, and that is the
whole finding. Phase 4's guarantee — a fabricated citation cannot be persisted —
comes from `document_index` being an array position that resolves to a `Passage`.
No other provider has that, so a flat "LLM client" interface would quietly turn a
structural guarantee into a convention. The port now carries a `capabilities`
record naming the tier: `native` (Anthropic) or `marker` (labels sent with each
passage, cited by label, parsed back out — keeps the drop-and-count and
locator-from-the-row rules, loses `cited_text`). Nothing in Phase 4 builds a
`marker` adapter.

The injectable test client is therefore reshaped into an `AnswerProvider` port
defined by what the assistant needs rather than by what the SDK returns, with
citation resolution deliberately **outside** the adapter so the invariant is
written once instead of once per provider. `scopeSnapshot` gains `provider`,
`effort`, and `citationMode` alongside `model` — one value each today, and free
because the column is already `Json`.

Three things recorded so a later selector inherits them: credentials decide which
providers *exist* and configuration only decides which are *offered* (so a
selectable model can never be a 500); §19's 8 s would have to be stated per
effort mode, because `thorough` will not meet it; and **embeddings are a separate
provider decision**, frozen by `vector(768)` with no backfill, so switching
answer providers never silently includes them. Mixing models across turns of one
conversation is already safe — history goes as plain text with markers stripped.

A user-facing model or effort selector is not in the PRD and would move
`ANSWER_MODEL`/`ANSWER_EFFORT` into `AppConfig`, widening §5's closed list. That
is its own proposal, not a follow-up commit.

## [2026-08-12] update | Phase 4: the citation tiers were mis-cut

Corrected a wrong claim in [[plan/phase-4-assistant/design]]. The provider
decision had split citations into `native` (Anthropic) versus `marker` (labels
parsed out of prose), described as structural grounding versus grounding by
convention. That drew the axis in the wrong place and understated every other
provider.

A provider with **strict JSON schema output** can carry the passage id in an
`enum` of exactly the ids we sent, which constrained decoding makes
*ungenerable* if absent — at least as strong as validating an index after it
arrives. So there are three tiers, not two: `native`, `structured`, and `marker`
as the floor for models with no strict mode. The remaining gap between `native`
and `structured` is narrow: the quote is API-extracted in one and model-written
in the other, and since it is substring-verified against the passage either way,
the difference is how often the check fails. The real cost of `structured` is
**streaming** — the answer arrives as JSON being generated, so showing text early
needs an incremental JSON parser, aimed straight at §19's 8 s. That is the trade,
not grounding strength.

The genuinely disqualifying option turned out to be a different one, and it is
now written down as rejected: a provider's own retrieval tool (OpenAI's
`file_search` and its kind) returns structured file citations and is tempting for
exactly that reason, but it means their vector store and their retrieval choosing
the passages — `retrievableSources()` stops being enforceable, so an archived or
failed source could reach an answer. The rejection is about **retrieval, not
citations**. Every supported tier keeps our query and sends passages inline.

`capabilities` gains `quote: 'extracted' | 'generated' | 'none'`, `citationMode`
in `scopeSnapshot` holds the tier, and the `structured` row carries a callout that
its field names were never checked against live provider docs.

## [2026-08-12] update | Phase 4: citation support checked against provider docs

Looked up which models actually support citations rather than reasoning about it.
Three results changed [[plan/phase-4-assistant/design]].

**Anthropic: all active models support citations** — the tier is not a
model-selection constraint, so nothing in the phase depends on picking a
particular Claude. Streaming has a first-class `citations_delta` inside
`content_block_delta`, so citations arrive incrementally beside text. And the
documentation prescribes exactly the shape this phase chose: "if you want Claude
to be able to cite specific sentences from your RAG chunks, you should put each
RAG chunk into a plain text document" — with auto-chunking to sentences, so a
citation lands finer than the passage, never coarser. Also confirmed: citations
must be enabled on all or none of a request's documents, and the
structured-outputs incompatibility is a real 400.

**OpenAI's documented path for citing developer-supplied inline context is the
`marker` tier, not `structured`** — the opposite of what the previous entry
assumed. Its citation-formatting guide injects context as tagged blocks with ids
and has the model emit special Unicode sentinels it was trained on, with official
parse/strip helpers. That is stronger than an ad-hoc `[[P3]]` convention but
still a label the model typed. OpenAI's structured `file_citation` annotations
exist only behind `file_search`, i.e. behind provider-side retrieval, which is
already rejected. `structured` via strict JSON schema stays available there as
*our* construction rather than their recommendation.

**Gemini may offer a fourth shape worth checking first.**
`groundingMetadata.groundingSupports` maps byte-offset answer segments to
grounding-chunk indices with a confidence score — structurally the same as
`document_index` — and one of its grounding sources is "grounding with your
search API", where Gemini calls our endpoint. If that holds it is
provider-orchestrated grounding over *our* retrieval, keeping
`retrievableSources()` enforceable. Open question: whether grounding metadata can
be produced over passages passed inline with no search tool.

Two smaller notes now in T4's scope: a `search_result` content block is mentioned
as a citable type beside `document` and may be the better primitive; a *custom
content* document gives block-range citations with no sub-chunking, which is
wanted only if a citation should address a whole passage rather than a sentence.

## [2026-08-13] update | Phase 4 built: retrieval, grounded answers, citations

Implemented on branch `phase-4-assistant`. Backend 115 → 151 tests, frontend
103 → 121, all green against the compose stack with real Ollama embeddings. The
verified behavior is [[specs/assistant/spec]], REQ-145 – REQ-195. The phase took
**no migration**: Phase 0's `Conversation`/`Message`/`Citation` columns fitted
exactly, and `Message.scopeSnapshot` absorbed the provider/model/effort/citation-
mode fields for free.

The embeddings written on every ingest since Phase 2 finally have a reader, and
`GET /citations/:id/target` — specified in Phase 3 and marked inert — has a real
producer: every persisted citation is asserted to resolve to a block range
containing its passage's text.

Three things the plan got wrong, all found by running rather than by reading.
**The design promised a similarity floor and none was built** — KNN always returns
its nearest neighbours, so an off-topic question retrieves passages and does spend
a model call. A cutoff was rejected rather than added: the threshold is a tuned
constant with no principled value, and a floor makes the product refuse to *look*,
answering "no evidence" for a well-posed question whose source uses other words.
**The boot gate never fired in the case that actually happens**: `.env.example`
ships the key blank, and `z.string().min(1)` rejected that at schema-parse time
with "expected string to have >=1 characters", so the actionable message was
unreachable on a fresh checkout. **A stream ending with neither `done` nor `error`
read as success**, so an answer the server never finished vanished silently with no
Retry — now a §16 failure.

One mutation check found a hole in a test rather than in the code, which is the
best outcome a mutation check has: resolving an out-of-range `document_index` to
passage 0 passed the entire suite, because the drop test kept a valid citation
beside the invented ones and the dedupe-by-passage rule absorbed the difference.
Split into an all-invented case asserting *zero* citations and a mixed case citing
the second passage, both now fail. Two other mutations each fail several tests —
the same requirement asserted from different angles — and neither was loosened.

**The ANN-index question deferred by Phases 2 and 3 is settled.** Measured at the
§5 ceiling — 50 sources, 300 passages — hybrid retrieval is median 46 ms, p75
52 ms, worst 71 ms, of which ~34 ms is the Ollama embedding call. Exact KNN plus
full-text is roughly 15 ms against §19's 8 000 ms for a whole answer, so an index
would buy nothing but Prisma drift; `schema.prisma` now records the measurement
instead of another deferral.

Outstanding, and stated rather than dropped: **no provider credential existed in
this session**, so §19's 8 s p75 to first visible content is unmeasured and the
model-behaviour halves are unverified — honest insufficiency on thin evidence, and
a conflict presented without being resolved. Everything *around* the model is
asserted in CI; the model's own output is not. Two exit criteria stay unticked and
the spec carries the caveat, the same way Phase 2 carried its unexecuted
integration tests until Phase 3 closed them. The provider failure path *was*
verified for real: the live API rejecting an invalid key surfaced as the §16
message with no assistant message persisted, the question kept, and the 401 in the
server log only.

## [2026-08-13] create+update | Assistant provider tiers: `native` kept, `structured` added

Phase 4 shipped one adapter on purpose — "a port with one implementation is a
guess, and only a second real provider turns it into a contract". The second
implementation now exists, so the tier taxonomy has met a caller.
`plan/assistant-provider-tiers/` carries the proposal, design, and tasks; the spec
gains REQ-196 – REQ-201. Backend 161 → 175 tests, frontend untouched at 121.

Researching OpenRouter first changed the shape of the answer. It has **two faces**:
an **Anthropic Skin** that "behaves exactly like the Anthropic API" and passes
advanced features through — so the `native` tier reaches it with a base URL and
nothing else, keeping structural citations and token-level streaming — and an
OpenAI-compatible chat-completions API, which is the only way to a non-Claude
model and has no citation channel at all. So the plan keeps `native` rather than
migrating everything to `structured`, and the two tiers coexist.

The `structured` tier constrains the answer to a schema whose citation field is an
**enum of the document indexes the request actually sent**, not of passage ids.
That choice is what keeps the rules in one place: the port never hands an adapter a
`passageId`, so `answers.ts` resolves both tiers with literally the same code and
the drop rule, the locator copy, and the quote verification are not re-implemented
per tier. `quote` is requested and marked `generated`, which finally exercises
REQ-157's substring check in production instead of only in a test.

Streaming is **per segment**, not per token — a structured answer is JSON being
generated, so nothing is renderable until a string closes. The cost is written
down rather than discovered: text appears a sentence at a time, and there is no
thinking summary to show first because that tier has no thinking channel.

One correctness fix to Phase 4 came out of the router work: `scopeSnapshot.model`
recorded the model *requested*, and a router does model mapping and provider
failover, so it could name something that never ran. The port gained a `model`
event and the snapshot now records what served.

Two test holes worth remembering, both found by mutation checks rather than by
review. The scanner's first version anchored on the first `{` in the buffer — the
*wrapper*, which brace-matches to the end of the answer — so every segment test
failed at once. And removing string-state tracking from the brace matcher passed
all twelve scanner tests, because the "braces inside text" case used `{"a": 1}`,
whose braces *balance*: naive depth counting landed on the right brace by accident.
The generalisable lesson is that a test for "structure inside a string is not
structure" has to use **unbalanced** structure. Separately, adding two route tests
pushed one file past the 20-questions-per-minute ask cap, and the 429 arrives as a
JSON envelope rather than a stream — so `ANSWER_RATE_PER_MINUTE` is now
configuration and the test env raises it, leaving the limiter itself in the path.

Outstanding for want of a live endpoint: whether Anthropic's citations survive the
Anthropic Skin — undocumented, and it fails *quietly* as uniformly ungrounded
answers — and whether a real endpoint honours the strict schema in practice. The
§19 first-token measurement is unmeasured on both tiers. One request carrying a
`document` block settles the first.

## [2026-08-13] update | The `structured` tier moves onto the AI SDK

Reverses one decision in [[plan/assistant-provider-tiers/design]] and leaves the
other alone. The hand-written segment scanner is replaced by the AI SDK's
`Output.array()` + `elementStream`, whose documented contract is to yield "each
fully completed and validated element as it is generated" — the same shape the
scanner produced, plus per-element validation it never had. `segments.ts`, its
twelve tests, the SSE line reader, and the finish-reason mapping all go.

The original argument ("written this way rather than as a streaming JSON parser
dependency") was half right. A general streaming-JSON parser would still be the
wrong tool; this is a provider abstraction whose array primitive happens to be
exactly the required shape. What was right is the risk of a normalizing layer,
which is why it is taken on **one** tier only.

`native` deliberately stays on the raw SDK. `@ai-sdk/anthropic` does expose
citations, but the parsing that landed covers search-result blocks and
custom-content documents (`search_result_location`, `content_block_location`),
while this adapter sends plain-text documents whose citations are
`char_location` — unconfirmed as parsed — and there are open reports of citations
being stripped entirely. The structural reason matters more than the bug count: a
normalizing SDK exists to flatten provider differences, which is the wrong
property for the single provider feature the product's guarantee rests on, and it
would fail *silently* as uniformly ungrounded answers.

Writing the amendment surfaced a trap before any code was written, which is the
argument for doing the wiki first. `elementStream` yields only elements that
**validate**, so a strict `cite` enum would reject a segment with an out-of-range
index and drop the whole element — **including its text**. That is strictly worse
than the scanner, which kept the text and dropped only the citation. The schema
therefore keeps the enum (it guides constrained decoding) but coerces an invalid
index to "uncited". Recorded as REQ-201, with a spec-vs-code callout explaining
that the requirement exists because the mechanism changed; the old REQ-201 is
renumbered to REQ-202, since ids are never reused.

## [2026-08-13] update | `structured` tier swapped onto the AI SDK

Done as planned: `segments.ts`, its twelve tests, the SSE line reader, chunk
parsing, and finish-reason mapping are gone, replaced by `Output.array()` +
`elementStream`. Backend 175 → 165 tests (twelve deleted, two added), frontend
untouched, `native` untouched.

Updating the wiki first paid for itself immediately. Writing the amendment
surfaced the trap before a line of code existed: `elementStream` yields only
elements that **validate**, so a strict `cite` enum would have dropped whole
segments — their text with them — for an out-of-range index, which is strictly
worse than the scanner it replaced. The schema now keeps the enum for constrained
decoding and coerces an invalid index to "uncited"; REQ-201 records it, and a
mutation check pins it.

Two things the docs did not say, both found by printing the request body.
`@ai-sdk/openai-compatible` sends `response_format: {type:'json_object'}` and
**drops the schema entirely** unless the provider is constructed with
`supportsStructuredOutputs: true` — it warns rather than failing, so the enum
would silently never reach the model. And `elementStream` **completes empty
rather than throwing** when the response is the wrong shape, so the prose fallback
had to become an explicit "no elements arrived" branch — which then had to tell
*prose* apart from *well-formed but empty*, or an answer that hit the token cap
reported `end` instead of `truncated` and the user was shown braces.

Two assertions changed and neither weakened: the array wrapper key is the SDK's
(`elements`), and the enum's position in the body is the SDK's business, so that
test now searches the schema for its content instead of walking a fixed path.

`native` deliberately stays on the raw Anthropic SDK. The reasoning is in the
design: a normalizing layer is the wrong place for the one provider feature the
product's guarantee rests on, and `@ai-sdk/anthropic`'s citation support covers
search-result and custom-content documents rather than the plain-text documents
this adapter sends.

## [2026-08-13] update | Code review of the assistant branch: one blocking gap

Reviewed the uncommitted assistant work before committing it. Backend 165 → 178
tests, frontend 121 → 122.

**The blocking finding: no citation ever rendered inline.** Nothing wrote the
`[n]` marker into the answer text, and the client derives markers by splitting
that text. No provider supplies one — a native tier attaches citations
out-of-band, and the model is never asked to type them — so with a real provider
the answer showed prose with a "Sources used" footer and **nothing clickable**.
§9's "citations beside the claims they support" and REQ-185 were silently unmet.

Every test passed because the scripted fixtures wrote the markers into their own
text: `groundedScript('Withdrawal was costly [1], though not everywhere [2].')`
supplied exactly what production would not. That is the sharpest lesson of the
session — a fixture that provides the thing under test hides its absence, and it
took reading the code against the spec rather than running it to see.

The fix makes marker insertion the fourth rule in `answers.ts`, beside the drop
rule and the locator copy: as each citation resolves, the marker is appended to the
accumulated text and emitted as a delta, so it lands in the stream *and* the stored
content and a reload renders identically. A passage cited twice reuses its number.
Recorded as REQ-203 with a spec-vs-code callout.

Three more findings, all fixed with tests. **The default production adapter had no
tests at all** — nothing asserted `citations.enabled`, which the API requires on
all-or-none of a request's documents; `test/anthropic-provider.test.ts` now covers
the flag, `citations_delta`, the served model, stop reasons, the cache breakpoint,
and a base URL. **The question was persisted before the per-user stream slot was
claimed**, so hitting the cap left an answerless question and every Retry added
another; the slot is claimed first and released if the write fails (REQ-183
amended). **A citation marker went inert after one click** in pane mode, because
`busy` was never reset on the success path.

Smaller: `createMany` for citations instead of N inserts inside the transaction;
excerpts on the structured tier are now fenced, since a source containing a
label-shaped line could otherwise impersonate one and steer the credit to the wrong
passage; `model: 'none'` became a named constant; one dead export removed.

## [2026-08-14] create | shadcn/ui adoption: a token bridge, not a re-skin

Asked whether the frontend could integrate shadcn/ui. It nearly already has:
`class-variance-authority`, `clsx`, `tailwind-merge`, `cn()`, the `@` alias, and
`src/components/ui/` are all in place, and [[AGENTS]] has named shadcn as the
stack since bootstrap. What is missing is `components.json`, Radix — and a
decision nobody had made.

The real obstacle is vocabulary. A generated component says `bg-background`,
`border-input`, `ring-ring`; `index.css` says `surface`, `outline-variant`,
`primary` — DESIGN.md's Material-3 roles. Add a component today and it renders
transparent, borderless, and without a focus ring. Both obvious fixes are bad:
hand-editing every generated file forfeits the reason to generate it, and
adopting shadcn's palette discards the design system for a default.

`plan/shadcn-ui-adoption/` takes the third path — an `@theme inline` block where
every entry is a `var()` redirect to an existing token. No colour is defined
there, which is what makes "DESIGN.md stays the source of truth" mechanical
rather than aspirational, and lets generated files be committed unedited.

Three decisions worth their own line. `shadcn init` runs only for
`components.json`; its stylesheet diff — an `oklch` `:root` palette, a `.dark`
block, a global `border-border` rule — is reverted in full, since each would
shadow or contradict the palette. **No dark mode**, stated rather than implied:
DESIGN.md has one palette, generated `dark:` classes stay inert, and that is
correct, not an oversight to be fixed. And `chart-*`/`sidebar-*` are omitted on
the principle that a missing token fails visibly the first time while a guessed
one fails plausibly forever.

Scope is deliberately narrow: no screen changes appearance, `button`/`card`/
`field`/`alert` stay hand-written (§16's contract has no shadcn equivalent), and
the native `<select>`s keep the decision `source-filters.tsx` already argued.
The pilot is `dialog` — seven call sites, Radix behind unchanged props, with
`dialog.test.tsx` as a gate that may not be relaxed. 110 lines of hand-written
focus trap retire only if the library satisfies §18 exactly as already asserted.

## [2026-08-14] update | shadcn/ui adopted: the bridge landed, the pilot did not

Implemented [[plan/shadcn-ui-adoption/proposal]]. The bridge works and is
proven: `shadcn add separator` produced a file whose `bg-border` compiled to
`background-color:var(--border)` → `#c3c5d7`, with **no edit to the generated
file**. "No visual change" was checked rather than asserted — the built CSS was
diffed variable-by-variable against a build of `master`: **0 changed, 0 removed,
45 added**. That diff is the technique worth reusing; it is cheap, and it is the
difference between knowing and hoping.

Four of the design's decisions were written from documentation and did not
survive contact. shadcn 4.18 generates against **Base UI, not Radix** — put to
the operator, who chose Base UI. The bridge needed **two** layers, because
generated code reaches for the bare `var(--secondary)` inside `color-mix()`, not
just `--color-secondary`. The `inline` rationale was right in conclusion and
wrong in reason. And `dark:` had to be **rebound** to a `.dark` class that is
never set: the original decision to simply not add the variant would have left
Tailwind v4's stock `prefers-color-scheme` in place, firing generated dark
styles against a palette DESIGN.md does not have. That is the one error that
would have shipped a visible bug, and it came from writing "stay inert" without
asking what makes them inert.

`shadcn init` also did something no amount of reading predicts: it wrote
components to a literal `frontend/@/` directory, because it resolves aliases
through `tsconfig.json` — a solution file here, with no `paths`. Its stylesheet
diff was reverted in full, as designed, and it earned that: it would have made
WikiBookLM Blue near-black, swapped Inter for Geist, and reset the radius scale.

**The pilot failed its gate and was reverted.** Moving `dialog` to Base UI broke
6 of 7 §18 assertions, two unfixable without editing the suite — the page behind
goes `inert`, so a control outside the dialog is unreachable to `getByRole`, and
`Backdrop` is a sibling of `Popup`, so the backdrop is not the panel's parent.
Neither is a defect; both are arguably better than the hand-written trap. But
ratifying them means rewriting the very suite that judges the change, in the same
step as the change. The gate existed to stop exactly that, so `dialog.tsx` is
byte-identical to before this proposal and the migration is its own future
proposal — whose first task is deciding what §18 should assert when containment
replaces a focus trap.

One name collides and shadcn wins it: `bg-secondary` now means DESIGN.md's
`secondary-container` (#D5E3FC), not its M3 `secondary` ink (#515F74). Zero call
sites used the ink; DESIGN.md records the change.

## [2026-08-14] create | Space sidebar

Proposed [[plan/space-sidebar/proposal]]: the persistent 280px left rail
`frontend/DESIGN.md` § Layout & Spacing has specified since the design system
was written, and the only element of it with no counterpart in the code. It
lands on the space, reader, and assistant routes as a `SpaceShell` nested
inside `AppShell` — not as a prop on `AppShell`, because every rail item needs
a `spaceId` that the home and auth routes cannot supply.

This retires the reason [[plan/shadcn-ui-adoption/proposal]] gave for leaving
`sidebar-*` out of the bridge — "no consumer, and a dozen tokens the palette
has no opinion on". Reading the registry entry rather than shadcn's stylesheet
shows the generated file reads exactly **six** of them, and DESIGN.md has a
value for all six, so none has to be guessed. It is also the first thing to
exercise the bridge inside the app; until now it was proven by a `separator`
that was generated, inspected, and deleted.

Four collisions are what makes this more than `shadcn add`, and each is
decided in [[plan/space-sidebar/design]]: the generated menu button spends
**one** token on both hover and active, so the wireframe's blue active pill
comes from a wrapper class rather than a re-pointed token; `sidebar` lists
`button` as a registry dependency, so the overwrite is declined and the
hand-written file gains only the `icon-sm` size `SidebarTrigger` asks for;
`use-mobile` calls `matchMedia` **during render**, so every space-route test
throws before it asserts anything unless the jsdom stubs land first; and the
provider installs a global Cmd+B listener that will fight Tiptap's bold
binding the moment Phase 6 mounts an editor. The last one cannot be fixed here
— the generated file is not editable and the editor does not exist yet — so it
is written into the code as a comment naming the phase that owns it.

Nav is Sources and Assistant only. The wireframe's Citations, Drafts, Trash,
and Help are §20 exclusions or have no PRD §2 counterpart, and Notes and
Notebook get links when they get routes. Moving "Add source" into the rail is
left as an open question rather than done in passing: it lifts dialog state
past the archived-space guard, which is a behaviour change wearing a layout
change's clothes.

One decision arrives by consequence rather than argument, so it is recorded
plainly: `components.json` already says `"iconLibrary": "lucide"`, so
generating this component makes **lucide-react** the project's icon set and
settles the open question [[wireframe/index]] has been carrying since
2026-08-11.

## [2026-08-14] update | Space sidebar implemented

[[plan/space-sidebar/proposal]] built. The rail is on the space, reader, and
assistant routes; `sidebar.tsx` and its five generated siblings are committed
unedited, and the six bridge rows paint them in DESIGN.md's palette. The suite
went 122 → 128 with none of the existing tests edited, which is the evidence the
gates were asking for.

The four collisions the design predicted were all real and all decided as
written: the `button` overwrite declined (md5 identical before and after) with
one added `icon-sm` size, the active pill from a wrapper class rather than a
re-pointed token, 280px from the provider's style prop, and `matchMedia` called
during render — the stub landed first, before anything was generated, which is
why the suite never went red for an unrelated reason.

What the design got wrong was the part it did not write from the registry file.
`AppShell` could not stay untouched: the generated `Sidebar` positions itself
`fixed` and `SidebarInset` is a `<main>`, so nesting a shell inside `AppShell`'s
`<main>` would have produced two landmarks and a rail floating against the
viewport. It took a `rail` slot and a sticky `h-16` header instead.

The second correction was a live bug rather than a tidiness problem. Rendering
the rail only once the space had loaded makes `AppShell` swap between two
element trees, and React unmounts everything under it to do that — the reader
threw away its loaded blocks and reading position the moment the space query
answered. Five `source-reader.test.tsx` failures found it, with a symptom worth
remembering: `findByRole` *resolving* with an element that was already detached,
which reads as "not found" and fails in 24ms rather than after the timeout. The
rail now takes `spaceId` from the URL and treats the space name as decoration
that arrives late.

One thing the CLI did not do: install. It generated seven files and rewrote
every registry import correctly, but `@base-ui/react` and `lucide-react` had to
be added by hand.

**Not done, and it is the honest gap:** nobody looked at the running app. The
Chrome extension was not connected, so the 280px measurement, the focus ring
against `surface-container-low`, the 320px off-canvas behaviour, and the
assistant's two-pane layout beside the rail are verified only in the compiled
stylesheet and in jsdom — neither of which has layout. Recorded as the one
unticked box in the plan.

## [2026-08-14] update | Sidebar border colour — a reverted reset, not a bad mapping

The rail's right edge came out as the nav *ink* (#434654). The six-token mapping
was innocent: `group-data-[side=left]:border-r` names a width and no colour, and
Tailwind v4 — unlike v3 — has no default border colour, so it painted
`currentColor` inherited from `text-sidebar-foreground`.

The cause is one line [[plan/shadcn-ui-adoption/proposal]] reverted. Its decision
to revert `shadcn init`'s stylesheet diff **in full** was right about the palette
and wrong about `* { @apply border-border … }`, which is not palette at all —
generated components are written against it. Nothing showed it until a generated
component with a coloured `text-*` ancestor finally had a border, which is the
kind of latency a "revert everything" rule buys.

Fixed at the cause rather than the symptom: the border half of the reset is back
in `@layer base`. An audit found exactly two places in `src/` with a border width
and no colour, both generated (`sidebar.tsx`'s rail edge, `sheet.tsx`'s drawer
edges); patching those two would have left the next generated component to
rediscover it. Being in `base`, every explicit `border-<colour>` still wins —
checked in the built stylesheet, not assumed. `outline-ring/50` stays reverted:
§18's focus ring is `:focus-visible`'s.

## [2026-08-15] create | Plan + spec: phase-5-notes, and its review pass

Phase 5 (notes & saved answers, PRD §10–§12) landed staged without its wiki
records: no `plan/phase-5-notes/`, no `specs/notes/spec.md`, no log entry.
The review that caught it also caught that **neither codebase compiled** —
`pnpm lint` failed on both sides — so the plan folder, spec, and this entry
are written together with the fixes, in the same pass. `plan/phase-5-notes/`
(proposal, design, tasks) records the phase's decisions; `specs/notes/spec.md`
gains REQ-204 – REQ-223; `index.md` catalogs both.

What the review pass fixed, in order of consequence:

- **Two data-loss bugs in the note editor.** Saving an edit flattened a
  multi-paragraph note into one paragraph, irreversibly; and a background
  refetch mid-edit reset the editor over the user's typed text. Both are now
  structural: paragraphs round-trip through the blank-line split the text walk
  emits, and the editor reseeds only on note identity change. A multi-paragraph
  round-trip test pins the first; the second is in the viewer's effect deps.
- **Both `@unique` races answered 500 under concurrency.** save-as-note's
  `P2002` catch answers 409 `note_already_saved` identically to the pre-check;
  convert-to-source's answers 200 with the existing source, as its idempotent
  branch does. `notes.test.ts` gained the two `Promise.all` races, plus the
  previously untested `not_an_assistant_message` / `empty_note_content` /
  `manual_too_long` / `sources_limit` branches and the enqueue-failure path.
- **The archived banner disagreed with the buttons.** The UI now withholds
  New note / Edit / Convert / Delete when the space is archived; the API still
  deletes (archiving is not a trap, matching sources). The archived test now
  asserts the withholding, which is why the contradiction survived the first
  pass.
- **Compile-level:** the `FastifyInstance` import, the `Field` props that were
  never props, the unused imports, and the test-suite strict errors. The
  staged work's rail item also broke the rail's keyboard test — the Notes item
  is now in it.
- **Smaller:** `DELETE /notes/:id` gained the write rate limit every sibling
  has; the doc walk is depth-bounded (400 `note_too_deep` instead of a stack
  overflow); `?q=` stopped being a dead server branch — the client searches
  through it, debounced; idempotent re-convert is 200; `enqueueOrFail` returns
  nothing; `button.tsx`'s `render` forwards props; `field.tsx` throws on
  unsupported children; the three text walkers are one frontend helper plus a
  backend copy that stays on purpose.

Verification: backend `vitest run` 196/196 with the stack up (Postgres, Redis,
MinIO, Ollama), frontend 138/138, both `lint` clean. The browser UI was not
driven — same caveat as every earlier phase.

## [2026-08-15] update | Phase 5 code review — second pass

A second review of phase-5-notes found two real bugs the first pass shipped,
both from reading the code against the data model rather than running the
suites:

- **Deleting a failed converted source cascade-deleted citations (PRD §6/§10).**
  `Source` owns its citations on `onDelete: Cascade`, so `tx.source.delete`
  on the retry path could silently destroy saved-answer citations. Convert now
  REUSES the failed row (`/sources/:id/retry`'s pattern) — reset to
  `processing` with the new snapshot text — which preserves the source id and,
  being net-neutral, still works at `sources_per_space`. The spec (REQ-219),
  design, and the Retry test were corrected together; a test forces a citation
  to reference the converted source, fails the source, fills the space to the
  cap, and re-converts: same id, 201, citation survives.
- **"Save as note" was live on the streaming answer.** The synthetic
  `pending-answer` message had no persisted id, so the button called a route
  that cannot exist and 404'd. `AnswerMessage` gained `canSave`; the streaming
  copy renders no footer action.

Also: the space-page's Notes region now reads its count from `space.noteCount`
instead of fetching the full list; `button.tsx`'s `as Partial<unknown>` cast
is gone (React 18 needs none); `field.tsx` forwards `...props` to a child
instead of dropping them; Cancel in the viewer discards the draft; the shared
`doc-text.ts` walker got the depth bound its backend twin had; `?q=` got a
`.max(200)` and the preceding-question query a deterministic `id` tiebreak; a
bad `?noteId=` now alerts instead of blank-pageing. Missing tests landed
(REQ-206 named, `note_too_deep`, REQ-219 retry, note-viewer Cancel, streaming
save withholding). Verification: backend 199/199, frontend 141/141, both
`lint` clean.


## [2026-08-15] update | Phase 5 code review — third pass, fixes applied

Reviewed the uncommitted Phase 5 diff and fixed what held up.

- **Two concurrent conversion retries could leave a source stranded.** The
  failed-retry branch updated the row with no state guard, so both racers
  reached the enqueue — where the loser's `ingestQueue.remove()` can delete the
  settled-job slot the winner just filled, leaving the source `processing` with
  no job coming. That is the exact trap `/sources/:id/retry` documents and
  guards with one atomic statement; convert now does the same (`state: 'failed'`
  in the `updateMany` WHERE), and only the claimer enqueues. The loser answers
  200 with the source, like every other non-creating branch. Spec REQ-218
  extended; a test asserts {200, 201} and exactly one `ingestQueue.add`.
- **`enqueueOrFail` existed twice**, verbatim, with different return types —
  two copies of the "a queue rejection is written to the source, not thrown"
  invariant (REQ-221), whose message text the specs assert on. Moved to
  `backend/src/lib/enqueue-ingest.ts`; `sources.ts` and `notes.ts` share it.
- **The note editor could silently truncate a note.** It rebuilds `contentRich`
  from extracted text, so a walk that stopped at its 100-level depth bound would
  have written the loss back on save. `extractDocText` now reports `truncated`,
  and the viewer withholds Edit and explains why (REQ-224) — the client half of
  the backend's `note_too_deep` refusal.
- **A11y gaps against the repo's own precedent** (REQ-225): the viewer's content
  textarea had no label at all and its title used a hard-coded id; the notes
  search was placeholder-only with no announced result count, where
  `source-filters.tsx` does both. Fixed, with `useId` throughout.
- **`Field`'s children path dropped the error styling**, so an errored field was
  announced by `aria-invalid` but invisible — it hit `convert-note-dialog`. And
  `TextareaField`'s children path dropped `...props` entirely while `Field`'s
  forwarded them, contradicting the JSDoc contract both share. Both now go
  through one `cloneControl`, and `FieldFrame` is back to a single clone path.
- Nits: `Button`'s `render` path no longer forwards `disabled` onto an `<a>`
  (announced and inert instead); the notes page-title badge reads
  `space.noteCount` rather than the filtered length, which shrank while
  searching and read as though the space lost notes.

Also corrected stale index text claiming the failed predecessor is "freed
before `sources_per_space` is counted" — it is reused, as design.md and REQ-219
have said since the first review pass.

Not changed: `Note` could take a `@@index([spaceId, updatedAt])` to match the
list query, but that needs a migration for a personal-scale table — flagged,
not applied. Verification: backend 200/200, frontend 149/149, both `lint` clean.

## [2026-08-15] create | Assistant reasoning visibility

Investigated "the assistant is slow and does not stream". The transport is fine
— hijack, SSE writes, and the client's chunk reader all check out. Measured the
configured endpoint directly: first `reasoning_content` chunk at 1.2 s (337 of
them), first `content` chunk at 21.6 s. `openai-provider.ts` declares
`thinking: 'none'` and reads only `elementStream`, so all 337 are discarded.
Filed [[plan/assistant-reasoning-visibility/proposal]] (proposed) to surface
reasoning as `thinking` events, show a labelled "Thinking…" with a clamped
tail, and fix two knobs found alongside: `ANSWER_EFFORT` reached nothing, and
`ANSWER_TIMEOUT_MS` bounded only the native tier.

## [2026-08-15] update | Assistant reasoning visibility implemented

Reasoning now streams as `thinking` on the `structured` tier, the pane shows a
labelled "Thinking…" with the reasoning clamped, `ANSWER_EFFORT` reaches the
endpoint as `reasoning_effort`, and `ANSWER_TIMEOUT_MS` bounds the tier. End-to-end
against the live endpoint: first progress 21.6 s → 1.6 s. Verification found a
second, unrelated cause of the same complaint — `await provider.title(...)` sat in
front of `done`, holding the composer disabled 35 s past a finished answer — fixed
here as REQ-232. Spec gains REQ-226 – REQ-232; suites 200 → 207 and 149 → 151, none
edited. Outstanding: nobody looked at the running app (Chrome extension
unavailable), and whether the endpoint honours `reasoning_effort` does not replicate.

## [2026-08-15] update | Review pass on assistant reasoning visibility

Reviewing the uncommitted change caught that its `done`-before-`title` fix was
server-only and therefore user-invisible: `use-ask.ts` settled after its read
loop, which ends on stream close — still after titling. Fixed in the client and
covered by a test driving `done` on a still-open stream. Also removed an orphaned
JSDoc block left over from the `providerOptions` refactor, and corrected
`mergeStreams`' early-break cleanup, which skipped the one iterator most likely
to be mid-read. Frontend 151 → 152. REQ-232 and the plan notes rewritten — they
had recorded the fix as delivered.

## [2026-08-15] update | Assistant screen: hidden conversation list, app-scroll layout

Two operator-requested changes to `/spaces/:id/assistant/:id`. The
previous-conversations `<nav>` is removed — recorded as a `Spec-vs-code` callout
on REQ-170, because the data and its route are untouched but no surface now lists
older threads. And the screen became a chat layout: `AppShell` gains an opt-in
`fill` that pins the frame to `h-svh` and hands the leftover space to the page as
a flex column, so the thread scrolls inside and the composer stays put. Opt-in,
so the library and reader keep scrolling the document. Verified in a real
headless Chrome at 1440×900, 1440×520, 390×844 and with the reader pane open:
document never scrolls, the thread scrolls at 520 px (260→163), and the sources
page still scrolls as before. Suite 152/152 — jsdom has no layout, so it proves
nothing about this and the browser checks are the evidence.

## [2026-08-15] update | Assistant layout: three bugs found by opening the reader

The `fill` layout broke the moment the reader pane opened — the page heading slid
under the fixed header and "Close reader" went with it. Three separate causes,
all found by measuring in a real browser rather than by reading the CSS:

1. **`overflow-hidden` is still a scroll container.** It hides the scrollbar and
   stops the *user*, but the reader's `scrollIntoView` scrolled the frame from
   script — `scrollTop: 66`. Now `overflow-clip`, which is not a scroll container
   at all.
2. **Grid row `auto` + `h-full` is circular.** The percentage resolved against an
   indefinite height, fell back to content height, and the row grew to match:
   1861 px inside a 900 px viewport. The split is flex now, with `flex-1` on the
   cards instead of `h-full` — a share of a known size, no percentage to resolve.
3. **A 1 px `sr-only` escaped its scroll container.** `sr-only` is
   `position: absolute`, and with no positioned ancestor the cited-block label
   anchored to `SidebarInset`, parking one clipped pixel wherever the reader was
   scrolled to — which is what gave (1) something to scroll. The reader's scroll
   region is `relative` now.

Also moved "Close reader" outside the scroller: the reader opens scrolled to the
citation, so a Close control inside it started out of view.

Verified at 1600×900, 1280×800, 1440×520 and 390×844, with and without the pane:
the frame's `scrollHeight` stays at the viewport height, card bottoms and the
composer do not move when the reader opens, and the sources page still scrolls
the document. Suite 152/152 — unchanged, and it caught none of this.

## [2026-08-15] update | Assistant answers reveal at a paced rate

Operator asked for smoother answer generation. Checked the backend route first
and closed it off with evidence: the AI SDK's `partialOutputStream` emits no
finer than `elementStream` for `Output.array` (3 updates vs 2, on an endpoint
sending ~16 raw chunks), so sub-segment text would mean hand-parsing the JSON
again and losing the citation-index enum. Fixed it in the client instead —
`useSmoothedText` paces the reveal on `requestAnimationFrame`, backs out of
half-revealed `[n]` markers, caps frame time so a dropped frame cannot dump the
backlog, and flushes instantly when streaming stops so REQ-232's handoff is not
delayed. Spec'd as REQ-233. Measured in a browser: 2 → 149 distinct rendered
lengths. Frontend 152 → 160.

Noted while verifying: a dev worker left running shares Redis with the backend
suite and can pick up a job a test enqueued — `sources.test.ts`'s retry case
failed once that way and passed on a clean re-run. Worth knowing before treating
a lone red test as a regression.

## [2026-08-15] update | Answer reveal paced to arrival rhythm, not to buffer drain

Follow-up: the paced reveal still froze, and the report placed it at the citation
marker. The measurement from the previous session already contained the answer —
`24841:634` then nothing until `25458:643`, a **617 ms** freeze — and it lands
just after `[n]` because the marker is appended immediately after its segment.
Cause was draining the buffer in 250 ms when segments arrive ~1 s apart, so it
typed fast then waited.

`useSmoothedText` now estimates the arrival gap and paces to finish as the next
one is due, with the held backlog capped so the flush at `done` stays bounded.
Freezes 617 ms → 250–500 ms; rendered steps 149 → 219–308.

**Not solved, and recorded as such in REQ-233's callout:** the provider delivers
~6 segments in the final ~1.4 s after ~20 s of silence, and no client-side pacing
smooths text that has not arrived. Holding back longer only trades freezes for a
bigger ending flush — measured at 229 characters with a 2 s ceiling. Tuning was
done on single noisy samples; the numbers show direction, not precision.

## [2026-08-27] create+update | Plan: source-detail-reader — implemented and verified

The reader did not look like the `source_detail` wireframe, and the analysis
put most of the gap in the data, not the CSS: `extract-pdf.ts` grouped pdf.js
items only by `hasEOL`, one `SourceBlock` per printed line. Rewrote it as a
two-pass extractor — lines with geometry, then paragraphs by baseline gap, font
size, and column edge, with a heading block for a line set ≥ 1.15 × the
document's median size, marked `heading === text` so no column was added. A page
that does not read top-to-bottom keeps per-line blocks. `rematchCitations` now
collapses whitespace, because the reflow turns yesterday's `\n` into a space.
Added `scripts/reprocess-sources.ts` for sources already `ready`.

Frontend: `--font-serif` (Lora) for the reading column, heading blocks as `<h2>`,
`← Library / <space>` breadcrumb without the duplicate back link, a ruled header
with `Edit details · Download · ⋮` (shadcn `dropdown-menu`, first generated
component since the sidebar), pager without "Go". Zoom declined — PRD §8.

Verified (after a review pass that fixed a success-on-error exit in the
script, an `aria-label` that contradicted the visible label, and centred
two-line titles splitting): backend 225, frontend 167, lint and build clean. Reprocessing the one
real PDF in dev took page 1 from 49 blocks to 11 and rematched 25/25 citations —
but only after raising `MAX_LINE_GAP_RATIO` from the designed 1.6 to 1.9: a
browser's print-to-PDF sets leading at 1.63, and the first run left every line
its own block. The fixture PDFs at 14pt-on-12pt never exercised that. Recorded
in the design table. Spec REQ-234–REQ-236; `wireframe/index.md` now lists the
sixth screen. Outstanding: the Chrome extension was not connected, so the page
was not looked at in a browser.

## [2026-08-27] create+update | Plan: space-sidebar-wireframe-parity — implemented and verified

The space rail had the wireframe's structure and shadcn's density: 32px Inter
rows with 16px icons where `source_library` draws 48px JetBrains Mono rows with
24px icons, no "+ Add Source" under the space's name, tighter header and footer.
Fixed at the call site in `space-shell.tsx` — `size="lg"` plus one `ITEM` class
string, a `size-10!` override so the collapsed strip's icons keep the expanded
row's proportion — with `ui/sidebar.tsx` untouched and no literal colour.

Add Source is now in the rail and opens the same `AddSourceDialog` from the
assistant, notes, and reader routes; the library page keeps its own button.
The existing suite caught what the plan missed: REQ-076's archived-space test
failed because the rail offered Add source where the page hides it. The rail
now withholds it for an archived or unloaded space — REQ-237 in
[[specs/spaces/spec]]. Frontend 167 → 171 after a review pass added a
loading skeleton for the row and two tests (list invalidation from the rail,
two buttons on the library page); lint and build clean.
[[wireframe/index]] source_library row updated. Outstanding, again: the Chrome
extension was not connected, so the rail was not looked at in a browser.

## [2026-08-27] create+update | Plan: assistant-pane-reader-header — implemented and verified

Operator reported the assistant's reader pane spending ~40 % of its height on
the full-page header. `ReaderHeader` gains a `compact` variant built to the
`knowledge_assistant` wireframe's one-row pane header; the pane wrapper is the
sole owner of the rule under it. Every REQ-141 field stays on one truncated
line — the operator chose that over trimming the date. Frontend 171 → 173, lint
and build clean; REQ-236 amended in [[specs/library-reader/spec]];
[[wireframe/index]] knowledge_assistant row updated. Outstanding, again: the
Chrome extension was not connected, so the row was not measured in a browser.

## [2026-08-27] create | Plan: assistant-chat-history — proposed

Operator wants the assistant route to show a space's chat history the way
ChatGPT's project page does. Today `/spaces/:id/assistant` redirects to the
newest thread and lists nothing — the REQ-170 *Spec-vs-code* gap recorded when
the side nav was removed on 2026-08-15. [[plan/assistant-chat-history/proposal]]
turns the bare route into a hub (composer + list) and leaves the thread route
alone; [[plan/assistant-chat-history/design]] adds `preview` (last user message,
140 chars) and `messageCount` to `GET /spaces/:id/conversations` in one query,
hides empty threads, and carries the first question to the new thread through
router state so it is asked once. Reverses the 2026-08-15 decision knowingly: a
page, not a side nav. No code changed.

## [2026-08-27] update | Plan: assistant-chat-history — implemented and verified

The bare assistant route is now a history hub: a composer that creates the
conversation and asks on one submit, then every conversation with a turn as a
title / newest-question preview / date row linking to its thread. The redirect to
the newest thread and the empty-thread "New conversation" button are gone; the
thread route gains `← Chats`. `GET /spaces/:id/conversations` carries `preview`
and `messageCount` from one query. REQ-170's *Spec-vs-code* callout closes;
REQ-238 – REQ-241 added to [[specs/assistant/spec]]. Backend 226 (+1), frontend
183 (+10), lint and build clean. [[wireframe/index]] knowledge_assistant row
notes the hub is an addition the wireframe does not draw. Outstanding, again: the
Chrome extension was not connected, so the hub was not looked at in a browser.

## [2026-08-27] update | Plan: assistant-chat-history — scope choice on the hub

Operator asked whether the hub should let a source be picked. It should: the
hub always created a `space` scope, so a source-scoped first question cost a
space-wide answer first — a regression against the old empty-thread flow.
`ScopeSelector` now takes a `ScopeInput` rather than a conversation and the hub
composer creates with the chosen scope; REQ-239 amended in
[[specs/assistant/spec]]. Frontend 184 (+1); one timing-flaky hub assertion made
a `waitFor`. Notes in [[plan/assistant-chat-history/tasks]].

## [2026-08-27] update | Plan: assistant-chat-history — review fixes

A `/review-code` pass over the uncommitted diff. Six findings fixed, none
blocking: composer now waits for the space (a draft could be lost to the
archived swap, §16); archived empty state no longer points at a composer that is
not there; preview truncation by code point; date formatting takes a `locale`
so tests stop depending on the process locale; one `useSpace` call instead of
two on the hub; the pane clears a handed-over question even when read-only.
Five tests added — backend 227, frontend 189, lint and build clean. Flagged and
left for the operator: `frontend/src/features/reader/block.tsx` (staged,
outside this plan) sets the reader body to 16/28 against REQ-236's 18/32.

## [2026-08-27] update | Spec: library-reader — REQ-236 typography matched to code

Housekeeping after the assistant-chat-history review pass flagged
`frontend/src/features/reader/block.tsx` at 16/28 against REQ-236's 18/32. The
change was the operator's own (commit `3fbae00`, one step down on body and `h2`,
made because the same `Block` renders inside the assistant's reader pane), so the
spec was amended to the shipped size with a `Spec-vs-code` callout rather than
the code reverted. Also removed the empty `plan/reader-as-modal/` folder that
had sat without a proposal since 2026-08-14. No code changed.

## [2026-08-27] create | Plan: phase-6-notebook-export — proposed

Phases 0–5 are done; the roadmap's next step is the notebook (PRD §13) and its
export (§14). [[plan/phase-6-notebook-export/proposal]] scopes it to exactly the
PRD's editor features plus autosave, a Research panel, and three export paths;
[[plan/phase-6-notebook-export/design]] decides: no migration (the citation node
copies its locator, so a chip survives note or source deletion), whole-document
`PUT` guarded by `updatedAt` (409 `notebook_conflict` rather than last-write-wins),
a `localStorage` draft under the retry loop, server-side Markdown shared by
download and clipboard, print via `@media print`, and Cmd+B stopped at the
editor so the generated `sidebar.tsx` stays untouched. Tiptap is not yet
installed — this plan adds it. No code changed.

## [2026-08-27] update | Plan: phase-6-notebook-export — implemented and verified

Backend: `GET`/`PUT /spaces/:id/notebook` (lazy upsert; whole-document save
with an `updatedAt` compare-and-set answering 409 `notebook_conflict` with the
server's copy; a node/mark whitelist naming the offending path; 2 MiB body
bound from env) and `GET …/notebook/export.md` (one serialiser, live source
titles, `notebook.exported` activity). Frontend: Tiptap 3 with exactly §13's
features, the citation node carrying its locator, autosave with backoff and a
`localStorage` draft, the Research panel beside a never-remounting editor, the
Export menu, a `@media print` route, a Notebook rail item, ⌘B stopped at the
editor. Two new specs — [[specs/notebook/spec]] REQ-242–255 and
[[specs/export/spec]] REQ-256–262. Backend 227 → 253, frontend 189 → 213,
lint/build clean. The hand test over HTTP found `**Ngủ trưa **[1]` — not
CommonMark — and the serialiser was fixed with a test. Deviation recorded:
`NoteBody` not lifted. Outstanding, again: the Chrome extension was not
connected, so nothing was looked at in a browser.

## [2026-08-27] update | Plan: phase-6-notebook-export — review fixes

`/review-code` over the uncommitted diff found one blocking bug the suite had
missed because every test typed before counting: Tiptap's `setEditable` emits
`update` even when unchanged, so every open `PUT` an identical document and
bumped `updatedAt` under other tabs. Also fixed: a 401 from the out-of-TanStack
save never marked the session lost; a 400 locked the editor until reload;
empty lists and quotes passed the whitelist. Each fix has its test; the
export-menu copy/failure branches and `requestText` gained suites. Backend
253 → 256, frontend 213 → 224. Notes in [[plan/phase-6-notebook-export/tasks]];
REQ-245/251/252 and the export verification amended.

## [2026-08-27] create | Plan: phase-7-home-and-hardening — proposed

Phases 0–6 are done; the roadmap's last row is Phase 7.
[[plan/phase-7-home-and-hardening/proposal]] scopes it to PRD §15 (home +
activity feed — the `Activity` table has eight writers and no reader, and
`note.edited` / `note.converted` are not written), and the §16, §17, §18, §19
audits plus the §21 scenario as checklists with recorded results.
[[plan/phase-7-home-and-hardening/design]] decides: no migration, labels and
`href` resolved at read time; one user-scoped cursor-paginated `GET /activity`;
`note.edited` coalesced by bumping `createdAt` within an env window; home
composed onto the Phase 1 page, not rebuilt; `vitest-axe` in the suite with
the human passes done once; §19 measured, fixed only on a miss; a route-table
ownership test and pino `redact`; HTTPS and encryption at rest as deployment
requirements; Playwright at the root against the local stack (not CI), and the
hand walk in Chrome that three phase closings have deferred. No code changed.

## [2026-08-27] update | Plan: phase-7-home-and-hardening — implemented, reviewed, closed

First pass built `GET /activity`, the `note.edited`/`note.converted` writers,
the home page, and the §17 items; review found two hollow tests
(`ownership-table`, `redaction` asserted `true`), an N+1 resolver, a
`note.edited` that fired on every save, and two files written with literal
`\n`. Second pass fixed all five (route-table walk via `buildApp({ onRoute })`
and an `ownershipGuards` registry; capturing pino stream; batched resolver;
sorted-key diff because jsonb reorders keys), then ran the audits: §16 matrix
with every state named by a test; §18 `vitest-axe` + focus/live-region suites
that found an `autoFocus` focus-return bug in three dialogs and a colour-only
stale marker; §19 search p95 12.4 ms on a seeded 50-source space (five targets
unmeasured — no browser, answer gateway 401); §21 Playwright at the root — 5
of 21 steps pass live, 2 skip on the SSRF guard, the rest blocked at the first
answer — and it caught the first-source Add dialog staying open, now fixed.
New [[specs/home-activity/spec]] REQ-263–281; [[specs/notes/spec]] REQ-271–274.
Backend 256 → 275, frontend 224 → 260; lint/build clean. Left open in
[[plan/phase-7-home-and-hardening/tasks]]: the browser hand walk, Lighthouse,
the answer-timeout spinner, a dev allowlist for the e2e fixture host.

## [2026-08-27] create | Spec: home-activity

[[specs/home-activity/spec]] — REQ-263–281 from the verified Phase 7 behavior,
plus the §16–§21 hardening record as its Verification.

## [2026-08-28] create | Plan: shared-spaces-v1 — proposed

First post-MVP proposal, with a PRD §20 amendment lifting *Shared spaces* and
*Team roles* and keeping *Real-time collaboration* excluded.
[[plan/shared-spaces-v1/proposal]] and [[plan/shared-spaces-v1/design]] record
the 2026-08-28 discussion: `assertOwnership` → `assertAccess` over a
`SpaceMember` table (404 non-member / 403 under-role), three roles, email-bound
invite links (no mail provider exists), private conversations over shared
evidence, per-member resume, actor columns, a space activity tab, and advisory
notebook presence on the existing SSE channel. Multiple notebooks and CRDT were
discussed and declined. No code changed.

## [2026-08-28] update | Plan: shared-spaces-v1 — implemented, verified, closed

Migration `20260828120000_shared_spaces_v1` (SpaceMember, SpaceInvite, four
actor columns, `Space.lastOpenedAt` dropped, backfilled in-order — 61 spaces →
61 owner rows, zero drift). `assertOwnership` → `assertAccess` in one file; the
whole existing suite passed with the rename plus `userId` on three conversation
fixtures. New `routes/members.ts`, space activity feed with actors, presence on
the notebook route, actors on sources/notes/notebook, private conversations,
per-member resume. Frontend: `useSpaceRole` gates every write affordance,
members/invite/activity pages, Home split, "New since your last visit",
presence with Edit anyway, named conflict. Backend 275 → 307, frontend 260 →
279, lint/build clean. `e2e/shared-space.spec.ts` 10/10 against the live stack;
its one finding was a test-timing artefact (the `/open` stamp aborted by an
instant navigation), recorded in [[specs/sharing/spec]]. Deviations in
[[plan/shared-spaces-v1/tasks]]. `CLAUDE.md` and both READMEs now say
`assertAccess`.

## [2026-08-28] create | Spec: sharing

[[specs/sharing/spec]] — REQ-282–REQ-304 from the verified shared-spaces-v1
behaviour; `> [!note] Shared spaces v1` callouts added to auth, spaces,
ingestion, notes, notebook, assistant, and home-activity where a requirement's
meaning widened from "owner" to "member".

## [2026-08-28] update | Plan: shared-spaces-v1 — review fixes

`/review-code` over the uncommitted diff found one blocking defect and three
warnings, all fixed with tests and mutation checks. Blocking: the **invite
token reached the log** — it travels in the URL, Fastify logs `req.url`, and
pino's `redact` cannot address a substring, so a `scrubUrl` serialiser now
writes `/invites/[Redacted]` (REQ-305). Also fixed: the member cap was a
read-then-write, and the mutation check showed the transaction alone stopped
nothing — five of five concurrent invites were granted until a `FOR UPDATE` on
the space row went in (REQ-285); presence pruned an aged-out entry without
telling the channel, so a watching member kept seeing a name that had left
(REQ-306); a Redis blip escaped as a 500 from a notebook route instead of
degrading (REQ-307). Backend 307 → 312. Details in
[[plan/shared-spaces-v1/tasks]] "Review fixes"; [[specs/sharing/spec]] gains
REQ-305–REQ-307 and an amended REQ-285.

Also recorded honestly: the intermittent `reader.test.ts` hook failure is
**not** explained by the running dev worker alone, as the previous entry
implied — it recurred once with every worker stopped, then passed two full runs
in a row. Two concurrent `persistReady` calls for one source are the mechanism;
the trigger is not pinned. Pre-existing, untouched by this plan, worth its own
investigation.


## [2026-08-28] create | Plan: space-audience-style

New plan folder [[plan/space-audience-style/proposal]], status `proposed`. One
owner-written *Audience & style* note per space, after rejecting a free-form
"custom system prompt": narrowing instructions (language, reading level, tone)
compose with §9, widening ones are the §20 modes exclusion in a text box, and a
free-form field cannot tell them apart. The gap is real and visible in the code —
`Answer in English` is hard-coded in both adapter copies of the prompt, and
`Space.objective` reaches no model.

Key decisions in [[plan/space-audience-style/design]]: the note goes in the user
turn, never in `system` — on the trust boundary, not on prompt caching, with the
weaker cache argument recorded and retired; one shared `answer-rules.ts`; a
separate owner-only route because `PATCH /spaces/:id` is `editor`; the cap as an
`AppConfig` key against the `spaces.ts` precedent. Age-appropriate *restriction*
is declined outright — the reader, notebook, and export already show every member
every source, so it would be protection in name only.

## [2026-08-28] update | Plan: space-audience-style — implemented

[[plan/space-audience-style/proposal]] is `done`. `Space.audienceInstruction`, an
owner-only `PUT /spaces/:id/audience` with an `AppConfig` cap, the note rendered
into the **user turn** by both adapters through one shared `answer-rules.ts`, a
precedence clause in the rules, `scopeSnapshot` provenance, a
`space.audience_changed` feed row, and a space-page card that says plainly it is
not an access control. `Answer in English` stopped being a rule.

Backend 312 → 326, frontend 279 → 286, no existing test edited. Two mutation
checks each failed exactly one intended test. The live adversarial check ran
against the configured gateway and is quoted in
[[plan/space-audience-style/tasks]]: a widening note did not buy a confident
answer out of evidence that did not support one; a Vietnamese note produced a
Vietnamese answer. Specs: [[specs/assistant/spec]] REQ-308–312,
[[specs/spaces/spec]] REQ-313–315, [[specs/home-activity/spec]] REQ-316,
[[specs/sharing/spec]] annotated. Outstanding: the `native` tier end-to-end and
its cache measurement, and nobody looked at the card in a browser.

## [2026-08-28] update | Plan: space-audience-style — review fixes

`/review-code` over the staged diff found one blocking defect and three
warnings, all fixed with tests and mutation checks. Blocking: the audience note
was sealed out of `system` but rendered **unfenced** into the structured tier's
user turn, so a 96-character note could forge a `<<<EXCERPT n>>>` fence — a
citation of its index resolves to the *real* passage and stamps that source's
title and locator onto a claim no source makes. `audienceNoteBlock()` now
neutralises angle-bracket runs ([[specs/assistant/spec]] REQ-317). The design's
threat model was right; the first implementation was one layer short of it.

Also fixed: the `space.audience_changed` row sat **outside** the update's
transaction (ticked in `tasks.md` but not done); a no-op save wrote a row;
`scopeSnapshot.audience` was written and never read, so REQ-312 now says
forensics rather than claiming a display this change never built; and unrelated
`prisma format` churn across four untouched models was reverted. Backend
326 → 329. Details in [[plan/space-audience-style/tasks]] "Review fixes".

## [2026-09-07] create | Plan: huggingface-embeddings

Embeddings move off the local Ollama to HuggingFace's serverless Inference API.
`nomic-embed-text` could not come along — it is on the Hub but no provider
serves it (404 from the router), so the model changes too:
`intfloat/multilingual-e5-base`, 768 dims (no migration) and multilingual, which
nomic was not. `embed()` now takes a required task so e5's `query: ` / `passage: `
prefixes cannot be forgotten; a rejected token is fatal like a dimension
mismatch; `/health`'s `ollama` probe becomes `embeddings` and checks the token
via the Hub's free `whoami-v2`, because an unauthenticated route that spends
inference quota is drainable. Backend and frontend suites green, but **no live
call was made** — no token this session — and stored vectors stay stale until
`reprocess:sources --all` runs. [[plan/huggingface-embeddings/proposal]];
`Spec-vs-code` callouts added to [[specs/ingestion/spec]] and
[[specs/assistant/spec]].
