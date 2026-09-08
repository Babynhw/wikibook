---
title: Ingestion — spec
kind: spec
status: current
sources:
  - PRD §5 (adding sources, limits), §6 (processing states, retry, delete), §7 (source library display), §16 (empty states, plain-language errors), §17 (ownership, encryption at rest), §18 (accessibility), §19 (performance), §20 (exclusions)
  - backend/src/routes/sources.ts, backend/src/routes/events.ts
  - backend/src/ingest/ (extract-pdf, extract-web, extract-manual, url-guard, chunk, persist, pipeline, errors)
  - backend/src/lib/storage.ts, backend/src/lib/queue.ts, backend/src/lib/retrieval-scope.ts
  - backend/src/worker.ts, backend/src/plugins/events.ts
  - frontend/src/features/sources/
created: 2026-08-12
updated: 2026-08-28
tags: [ingestion, sources, pipeline, sse, spec]
---

# Spec: Source ingestion

Behavior of adding a PDF, a web link, or pasted text to a space; the queued
pipeline that turns it into retrievable passages; the processing states a user
sees; and retry and permanent delete. Written from the implementation verified
at the end of [[../../plan/phase-2-ingestion/tasks|Phase 2]].

Keywords per RFC 2119. Requirement ids are stable and globally unique across
specs; new requirements append. Sessions, the error envelope, and
`assertOwnership` are specified once in [[../auth/spec]]; the `Space` resource
and its archived state in [[../spaces/spec]]. Neither is restated here.

## Scope

Covers the `Source` and `Passage` resources, the ingest and purge queues, the
space event stream, and the source library UI. Does **not** cover the reader
that opens a passage at its citation (`library-reader`), retrieval or answering
(`assistant`), or notes — each gets its own spec as its phase lands. Passage
text, embeddings, and similarity scores are deliberately absent from every
response shape below: PRD §7 forbids showing them, so no route returns them.

## Adding a source

### REQ-080 — One interface offers all three source kinds

The client MUST present adding a PDF, a web link, and pasted text as one dialog
with three tabs, and MUST NOT offer separate top-level entry points per kind
(PRD §5.3). Each tab MUST keep what the user typed while the dialog is open,
including across a switch to another tab and back.

- GIVEN the Add source dialog is open on the Web link tab with an address typed
- WHEN the user switches to Text and back
- THEN the address is still there, unsubmitted.

### REQ-081 — A web source requires a valid http(s) address

The system MUST accept `POST /spaces/:id/sources` with `{ type: "web", url }`
only when `url` parses as an `http:` or `https:` address, and MUST reject
anything else with 400 and a field-level message on `url`. The client MUST apply
the same rule before sending, with the same wording.

- GIVEN a signed-in owner of a space
- WHEN the address is `ftp://files.example.com/paper.pdf`
- THEN the response is 400 and the message names http(s) as the requirement.

### REQ-082 — A text source requires a title and content

The system MUST accept `{ type: "manual", title, content, author? }` with a
title of 1–200 characters after trimming and non-empty content, MUST store a
blank author as "not set" (`null`), and MUST reject a missing or whitespace-only
title or content with 400 and a field-level message. The entered content MUST be
kept as the source's original text (PRD §5.3).

### REQ-083 — A PDF is uploaded as a stream, and only a PDF

`POST /spaces/:id/sources/upload` MUST accept a single multipart `file` field,
MUST reject anything that is not a PDF with 400, MUST reject an empty file with
400, and MUST enforce `pdf_max_bytes` while streaming rather than trusting a
client-supplied `Content-Length`. Exceeding the cap MUST abort the upload with
413 and MUST leave no partial object behind.

- GIVEN `pdf_max_bytes` is 200
- WHEN a 5 KB PDF is uploaded
- THEN the response is 413 and no object exists under the source's key.

### REQ-084 — A new source starts in `processing` and is recorded

Creating a source MUST answer 201 with the source in state `processing`, MUST
write an `Activity` row of kind `source.added` in the same transaction as the
row, and MUST then enqueue exactly one ingest job for it.

### REQ-085 — `sources_per_space` is enforced live from `AppConfig`

The system MUST refuse a source that would exceed `sources_per_space` with 409
`sources_limit`, counting only non-archived sources, and MUST read the limit at
request time so that changing the `AppConfig` row changes behavior without a
restart (PRD §5).

### REQ-086 — `manual_max_chars` is enforced live from `AppConfig`

The system MUST reject pasted text longer than `manual_max_chars` with 400 and a
field-level message naming the limit, read at request time. The limit MUST NOT be
hard-coded in either codebase.

### REQ-087 — A source whose job cannot be queued fails visibly

If enqueuing the ingest job fails, the system MUST mark the source `failed` with
a plain-language message and MUST NOT leave it in `processing` with no job behind
it. The user's recovery is the same Retry action as any other failure.

## Processing

### REQ-088 — Every passage carries an exact location

Extraction MUST record where each passage came from: a structural page number for
a PDF, a paragraph reference (`p12`, or `p12-p14` when paragraphs merge) for web
and pasted text, and the nearest preceding section heading where the source has
one. A PDF page number MUST come from the page being read, never from counting or
estimating (PRD §6).

### REQ-089 — A passage never spans a page boundary or two sources

Chunking MUST NOT merge text across a PDF page boundary, and MUST NOT produce a
passage containing text from more than one source. A paragraph longer than the
target passage length MUST be split with an overlap carried between the pieces
rather than truncated. Every character of the paragraph MUST appear in some
passage regardless of where the split lands — including on whitespace, which is
where a split falls in ordinary prose.

### REQ-090 — Reprocessing replaces passages atomically

Processing a source MUST write its passages, its extracted text, and its state in
one transaction, so a crashed or killed job leaves the source `processing` and
recoverable rather than `ready` with a half-written index. Reprocessing the same
source MUST replace its passages — the passage count and their `ord` sequence MUST
be unchanged for unchanged input, and MUST NOT accumulate duplicates or create a
second source row.

### REQ-091 — Citations survive a reprocess where they can be re-matched

When a source is reprocessed, each existing citation MUST be re-pointed at the
new passage whose text contains its quoted text exactly, and MUST be marked
`stale` with no passage when no such passage exists (PRD §6). A citation MUST NOT
be re-validated against an approximate match.

### REQ-092 — A permanent failure fails immediately, in plain language

The system MUST treat a password-protected PDF, a PDF with no selectable text, a
file that cannot be read as a PDF, a page count over `pdf_max_pages`, and a web
page with no readable article as permanent failures: the source becomes `failed`
with a message a user can act on, and the job MUST NOT consume further retry
attempts (PRD §16 — no stack traces, no internal identifiers).

### REQ-093 — A transient failure retries, and exhaustion still ends in `failed`

The system MUST retry a transient failure (the embedding service unreachable, a
5xx from a web page) up to three attempts with exponential backoff, leaving the
source `processing` between attempts. When the attempts are exhausted the source
MUST be marked `failed` with a plain-language message — a source MUST NOT be left
in `processing` with no job behind it.

- GIVEN the embedding service is down
- WHEN a text source is added
- THEN within seconds the source is `failed` with a "try again" message, and a
  Retry once the service is back delivers it `ready`.

### REQ-094 — `pdf_max_pages` produces a failed source, not a rejected upload

The page limit MUST be enforced during extraction and reported as a failed source
with a message naming the limit, because page count is not knowable at upload
time (PRD §5).

### REQ-095 — Web fetching refuses private and non-http(s) destinations

Fetching a web source MUST reject any scheme other than `http`/`https` and any
address that resolves to a loopback, private, link-local, or multicast
destination, and MUST re-apply that check after **every** redirect. The fetch MUST
be bounded by a byte cap and a timeout.

The check MUST be made against the address's **numeric value**, not the text of
the host. `URL` canonicalises an IPv6 literal before any guard sees it —
`::ffff:127.0.0.1` becomes `::ffff:7f00:1` and `0:0:0:0:0:0:0:1` becomes `::1` —
so a rule that pattern-matches the hostname string tests a spelling the parser
may never produce. An IPv4 destination carried inside an IPv6 address MUST be
vetted by the IPv4 rules: v4-mapped (`::ffff:0:0/96`), v4-compatible (`::/96`),
NAT64 (`64:ff9b::/96`), and 6to4 (`2002::/16`).

- GIVEN a web source whose address is `http://[::ffff:169.254.169.254]/`
- WHEN the worker fetches it
- THEN the source fails with the private-network message and no request is made.

> [!warning] The guard is check-then-connect, not a pinned address
> `assertSafeUrl` resolves the hostname and `fetch` resolves it again
> independently, so a name that answers with a public address on the first
> lookup and a private one on the second (DNS rebinding) is not stopped. Closing
> it means pinning the vetted address through a custom dispatcher, which is a
> dependency this phase did not take. Literal addresses — the overwhelming case
> for a deliberate attempt — are fully covered, and the worker holds no
> credentials for the private ranges it might reach.

### REQ-096 — Reaching a terminal state is recorded

A source reaching `ready` MUST write an `Activity` row of kind `source.ready`, and
one reaching `failed` MUST write `source.failed`, each in the same transaction as
the state change.

> [!note] Shared spaces v1 (2026-08-28)
> The row's `userId` is the member who added the source (`Source.addedById`),
> not the space owner; the owner only when that account is gone
> ([[../sharing/spec]] REQ-294). Adding a source is editor-level; deleting one
> is the adder's or the owner's (REQ-291).

### REQ-097 — An embedding dimension mismatch is permanent

A dimension mismatch from the embedding model MUST be treated as a permanent
failure rather than retried: the model is misconfigured, and three attempts fail
identically while delaying the message the operator needs. A **rejected
credential** MUST be treated the same way and for the same reason — a token the
embedding service refuses will be refused identically on every attempt.

> [!warning] Spec-vs-code — embeddings moved to HuggingFace (2026-09-07)
> The verification below ran against a local Ollama serving `nomic-embed-text`.
> Embeddings now come from HuggingFace's serverless Inference API with
> `intfloat/multilingual-e5-base`, and each input carries a task prefix
> ([[../../plan/huggingface-embeddings/design]]). The dimension is unchanged at
> 768, so no requirement here changes shape; what changed is the failure surface
> — a 401 is now permanent alongside the dimension mismatch, and a model with no
> serverless inference provider answers 404 rather than "unreachable".
> **Not re-verified against the live API**: this session had no token. Stored
> vectors from the old model are stale until `reprocess:sources --all` runs, and
> that staleness produces wrong retrieval rather than an error.

## Retry and delete

### REQ-098 — Retry is guarded by the source's state, and really re-queues

`POST /sources/:id/retry` MUST answer 409 unless the source is `failed`, and MUST
reset it to `processing` with its error cleared and enqueue the work again. The
re-queue MUST happen even when the source's previous job has already settled — a
200 that queues nothing would leave the source `processing` forever.

- GIVEN a source whose ingest job has already failed and settled in the queue
- WHEN the owner retries it
- THEN a fresh, unstarted job exists for that source.

### REQ-099 — Deleting a source is permanent and confirmed

`DELETE /sources/:id` MUST remove the source row with its passages and citations,
and MUST remove the stored original — after the row, so a dangling object is the
worst case rather than a source whose file silently vanished. The client MUST ask
for confirmation first and MUST say that it cannot be undone (PRD §6).

### REQ-100 — An archived space freezes source writes but not clean-up

Every source write in an archived space — create, upload, and retry — MUST answer
409 with the archived message, while `GET` and `DELETE` MUST stay allowed:
archiving is reversible and MUST NOT become a trap. The client MUST NOT offer Add
source or Retry in an archived space.

### REQ-101 — Only ready, non-archived sources are retrievable

Retrieval eligibility MUST be one exported filter — `retrievableSources(spaceId)`
— restricted to sources in that space with `state = 'ready'` and no `archivedAt`.
Failed, processing, and archived sources MUST NOT reach retrieval, and later
phases MUST build every retrieval query from that filter rather than re-deriving
it (PRD §6/§9/§17).

## Live state

### REQ-102 — A space has one ownership-checked event stream

`GET /spaces/:id/events` MUST answer 404 for a space the user does not own and 401
when unauthenticated, both before any stream is opened. An open stream MUST send a
keep-alive at least every 15 seconds, MUST be capped per user so a leaked tab
cannot pin connections open, and MUST be torn down when the user signs out.

### REQ-103 — An event carries state, and nothing else

A state-change event MUST contain only `{ sourceId, state, errorMessage? }`. Source
text, extracted content, passages, and storage details MUST NOT cross the channel
(PRD §17).

### REQ-104 — The client patches from events and refetches on connect

The client MUST open one stream per open space and apply each event to the cached
source rather than refetching the library per transition. Because the stream has
no replay, the client MUST refetch the source list once on every connect and
reconnect. After two failed opens it MUST fall back to a 5-second poll for the rest
of the session, and MUST say that live updates are unavailable — the library MUST
still reach `ready` without the stream (PRD §16).

### REQ-105 — Every state is icon plus text, and changes are announced

The client MUST show a non-ready state as an icon **and** text, never by color
alone, and MUST announce a state change through a polite live region. It MUST NOT
announce the states already on screen when the library first renders (PRD §18).

### REQ-106 — A failed source shows why, with Retry beside it

The client MUST render a failed source's `errorMessage` and a Retry action on the
card, so recovery does not require reading a log or reloading (PRD §6/§16).

### REQ-107 — The library shows what a source is, and no internals

The library MUST show each source's title, kind, author when known, date added,
and state when it is not ready. It MUST NOT show passage or chunk counts,
embeddings, similarity scores, or where the file is stored (PRD §7).

### REQ-108 — Originals are proxied per request, never presigned

`GET /sources/:id/file` MUST stream the preserved original through the API with
`Range` forwarded, behind the same ownership check as every other source route,
and MUST NOT hand out a presigned or direct storage URL — ownership is a
per-request obligation and a presigned URL works for whoever it is pasted to.
No response MUST contain a storage endpoint, bucket name, object key, or
credential (PRD §17).

### REQ-109 — Stored originals are encrypted at rest

The object store holding uploaded PDFs MUST have server-side encryption enabled
and MUST NOT be publicly readable (PRD §17). The local bucket is created with
both settings by the compose bootstrap, so the property can be asserted rather
than assumed. Any code path that creates the bucket instead of the bootstrap —
`ensureBucket()`, which the API and worker call when the one-shot init has not
run — MUST set default encryption itself: a fallback that creates a plain bucket
turns this requirement into a property nobody can check.

## Verification

Verified 2026-08-12 against the running stack: Postgres, Redis, and MinIO via
docker compose, Ollama on the host with `nomic-embed-text`, the API on `:4000`,
and the ingestion worker as a second process.

Backend — 22 tests across `test/sources.test.ts`, `test/sources-queue.test.ts`,
`test/storage.test.ts`, `test/events.test.ts`, `test/url-guard.test.ts`,
`test/retrieval-scope.test.ts`, and `test/ingest/{chunk,extract-pdf,extract-web,pipeline}.test.ts`
(suite total 63 → 87):

- Creation, validation, and the four limits, each with the `AppConfig` row
  changed mid-suite to prove nothing is hard-coded (REQ-081/082/083/084/085/086).
- `storage.test.ts` runs against real MinIO, not a mocked S3 client: the byte cap
  tripping mid-upload leaves no object, `Range` survives the proxy route, `remove`
  is idempotent, and metadata round-trips (REQ-083/108).
- `pipeline.test.ts` drives the whole path per source kind: located passages and
  the `source.ready` activity, reprocess idempotency, citation re-match versus
  stale, structural PDF page numbers, a transient embedding failure leaving the
  source `processing` and recovering on retry, a permanent extraction failure
  publishing `failed`, and a dimension mismatch treated as permanent
  (REQ-088/090/091/092/093/096/097).
- `chunk.test.ts` covers the page-boundary rule, the target length, the
  over-long-paragraph overlap, and heading association (REQ-088/089).
- `url-guard.test.ts` covers the scheme allowlist, each rejected address family,
  hostname resolution, and a redirect into a private range (REQ-095).
- `events.test.ts` covers the pre-stream 404/401, delivery of a published event,
  the heartbeat, the per-user cap, and sign-out teardown (REQ-102/103).
- `sources-queue.test.ts` burns a job's attempts with a throwing worker and then
  asserts a retry produces a fresh, unstarted job (REQ-098).
- `retrieval-scope.test.ts` asserts the filter's shape, including a test whose
  only job is to fail if the `archivedAt` clause is dropped (REQ-101).

Frontend — 19 tests across `features/sources/{add-source-dialog,source-list,use-source-events}.test.tsx`
plus the amended `routes/space-page.test.tsx` (suite total 63 → 82): the three
tabs and their validation with input preserved across a failure and a tab switch
(REQ-080/081/082), multipart upload with no hand-written content type (REQ-083),
the card's fields and the absence of §7 internals (REQ-107), the icon+text badge
and the polite announcement on transition (REQ-105), the failure message with
Retry (REQ-106), read-only behavior in an archived space (REQ-100), delete
confirmation including that cancelling sends nothing (REQ-099), the proxied
original's URL (REQ-108), and — through a hand-written `EventSource` — the
processing → ready patch with no extra fetch, the refetch on connect and
reconnect, the poll fallback after two failed opens, and the no-`EventSource`
environment (REQ-103/104).

By hand through the API, with the worker running (the PRD §21 scenario step
"observe source processing and recover from a failure"): register → create a
space → open an SSE stream → add pasted text, a web article
(`https://example.com/`), and a 24-page text PDF → all three reached `ready` and
each transition arrived on the stream carrying only `{sourceId, state}`. Then
Ollama was stopped and a fourth source added: it reached `failed` with
"Processing failed after repeated attempts." in 4 seconds, retry answered 409 on
a `processing` and on a `ready` source and 200 on the failed one, and with Ollama
back the source reached `ready`. Deleting the PDF answered 204, `GET` then
answered 404, and the object was gone from the bucket (`NoSuchKey`), whose
`sse-s3` auto-encryption was confirmed with `mc encrypt info` (REQ-093/098/099/109).

**Performance (PRD §19).** The 24-page text PDF went from upload to `ready` in
about 1 second (3 seconds wall-clock for the batch of three sources sharing one
worker), against the two-minute budget. Measured once, on a warm Ollama.

Two behaviors were mutation-checked, each making exactly the intended test fail:
removing the page-boundary flush in `chunk.ts` (the `chunkBlocks` boundary test —
which is how the leftover mutation described in the implementation notes was
found), and skipping the settled-job removal before enqueuing (the
`sources-queue` retry test). The `archivedAt` clause in `retrievableSources` and
the retry state guard are each named by a dedicated test, per the plan.

> [!warning] The stream was exercised through a stub, not a browser
> `use-source-events.test.tsx` drives a hand-written `EventSource`, and the real
> one was exercised only through `curl` against the API. Nothing in the suite
> would catch a browser-specific `EventSource` problem — a proxy that buffers,
> or a cookie the browser declines to send cross-origin. The SPA reaches the API
> through the Vite proxy, so the stream is same-origin in development and
> `withCredentials` is belt-and-braces there.

> [!warning] REQ-094 is asserted at the extractor, not end to end
> The `pdf_max_pages` message is covered by `extract-pdf.test.ts`, which calls the
> extractor directly with a lowered limit. No test uploads an over-long PDF and
> watches the source turn `failed`, so the wiring between the limit and the state
> rests on the shared code path the other permanent failures use.

Not covered by an automated test: REQ-109 (bucket encryption is compose
configuration, checked by hand with `mc`); the purge queue's inline-delete
fallback in REQ-099 (the enqueue failure it recovers from was not simulated); and
the visual pass — as in Phase 1, no agent looked at the rendered library, so
layout and token adherence rest on human review.

## Post-phase review (2026-08-12)

A code review of the phase found two defects that the suite above passed over,
both because the fixture avoided the failing shape. Fixed, with a test named for
each:

- **`chunkBlocks` truncated an over-long paragraph** instead of splitting it,
  whenever the split landed on whitespace: the trimmed piece came up a character
  short of the target, which the loop read as "this was the tail". A 5,999-char
  paragraph of ordinary spaced prose produced one 1,199-char passage and silently
  dropped the other 80% — a REQ-089 violation invisible to the old test, whose
  fixture was `'y'.repeat(2400)` and so could never split on a space. The loop now
  decides from the raw slice and trims only the emitted text
  (`chunk.test.ts` "keeps the whole paragraph when a split lands on whitespace").
- **The SSRF guard's IPv4-mapped branch was unreachable**, so
  `http://[::ffff:169.254.169.254]/` and `http://[::ffff:127.0.0.1]/` were
  fetched. The branch matched a dotted quad, but `URL` had already rewritten the
  host to the hex form `::ffff:7f00:1`. The guard now parses IPv6 into its eight
  groups and vets any embedded IPv4 through the v4 rules, closing NAT64 and 6to4
  with it (REQ-095; `url-guard.test.ts` "rejects an IPv4 destination wearing an
  IPv6 encoding"). The residual DNS-rebinding gap is recorded under REQ-095.

Four gaps in the same pass are now closed rather than noted:

- REQ-087 had no test at all — an enqueue failure leaving a source stuck in
  `processing` would have shipped silently. `sources.test.ts` stubs a throwing
  `ingestQueue.add` and asserts the source lands `failed`, with a `source.failed`
  activity and a Retry that works.
- REQ-100 named upload alongside create and retry, but only create and retry were
  covered; the upload case is now asserted, and the route refuses before the body
  reaches the object store rather than uploading and compensating.
- REQ-109's `ensureBucket()` fallback created a bucket with no encryption. It now
  sets default SSE, so the requirement holds on the path the compose bootstrap
  did not take.
- `/auth/reset` closed no streams: it keyed the teardown on `request.user`, which
  is null on the unauthenticated link-click path — the one case the requirement
  exists for. It now uses the token's owner (`events.test.ts`).

Also fixed, from the same review: `/health` returned a success `detail`
regardless of `exposeDetail`, so the queue probe published its depth to
anonymous callers in production; S3 credentials carried deployable defaults
(`wikibooklm-secret`), now required in production the way `DATABASE_URL` is; and
completed purge jobs accumulated in Redis.

> [!note] The integration tests were run on 2026-08-12 (Phase 3)
> They had never executed — Docker was unavailable in the session that wrote them.
> Run against the compose stack during Phase 3, they pass. The one failure was a
> test-suite fault, not a source bug: the suite had grown to an eleventh
> `registerUser`, one past `/auth/register`'s 10/minute cap, so its last test got a
> 429 where it expected a session. Those tests now share one account and isolate by
> space instead ([[../../plan/phase-3-library-reader/tasks]]).

## Cross-references

- [[../../plan/phase-2-ingestion/proposal]] · [[../../plan/phase-2-ingestion/design]] ·
  [[../../plan/phase-2-ingestion/tasks]] — the change this spec was written from.
- [[../spaces/spec]] — the `Space` resource, its archived state, and the source
  counts the library feeds.
- [[../auth/spec]] — sessions, the error envelope, and `assertOwnership`, which
  every route here registers.
- [[../../wireframe/index]] — the `source_library` mockup this layout follows;
  its status pills, tags, grid/list toggle, sort, and trash are §20 exclusions or
  later phases.
