---
title: Phase 2 — Design
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-12
tags: [phase-2, design, ingestion, bullmq, pdf, embeddings]
---

# Design: Phase 2 — Source ingestion

`Source` and `Passage` already exist with every column this phase needs
(`backend/prisma/schema.prisma:101`, `:132`), including the
`vector(768)` embedding, the `tsvector`, and its GIN index. Phase 2 adds
**no columns**. It does add one migration and several dependencies —
both listed at the end.

## Pipeline

```
POST /spaces/:id/sources          validate → Source(processing) → enqueue
        │                          (limits, ownership, frozen-space check)
        ▼
  BullMQ "ingest" queue  ──▶  worker process
                                 │ 1. load source, re-read limits
                                 │ 2. extract   (pdf | web | manual)
                                 │ 3. chunk     → passages + locators
                                 │ 4. embed     (Ollama, batched)
                                 │ 5. write     (one transaction)
                                 ▼
                            Source(ready) | Source(failed, errorMessage)
```

Steps 2–4 never touch the database except to read; the single write in
step 5 is what makes a crashed job harmless — a source that never
reaches step 5 stays `processing` and is picked up by the same retry
path a user would use.

## API surface

All routes sit behind `requireUser`. Space-scoped routes register
`assertOwnership('space', 'id')`; source-scoped routes register
`assertOwnership('source', 'id')`, which already exists and resolves
through `Source.space.ownerId`
(`backend/src/middleware/assert-ownership.ts:26`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/spaces/:id/sources` | Create a `web` or `manual` source (JSON) |
| `POST` | `/spaces/:id/sources/upload` | Create a `pdf` source (multipart) |
| `GET` | `/spaces/:id/sources` | List the space's sources |
| `GET` | `/sources/:id` | One source, with `state` and `errorMessage` |
| `GET` | `/sources/:id/file` | Stream the preserved original PDF (`Range` forwarded) |
| `GET` | `/spaces/:id/events` | SSE stream of processing-state changes |
| `POST` | `/sources/:id/retry` | Re-enqueue; `409` unless `state = failed` |
| `DELETE` | `/sources/:id` | Permanent delete (PRD §17 cascade) |

Two create routes rather than one content-type-switching route: the
multipart path streams to disk with a byte cap and the JSON path is a
zod body, and merging them would mean a handler that cannot state its
own request schema. The cost is one extra client method.

Writes to a source in an **archived space** answer `409` with the Phase 1
message, inheriting [[../phase-1-spaces/design]]'s frozen-space rule —
including `retry`, which would otherwise let an archived space grow new
passages. `GET` and `DELETE` stay allowed: deleting is how a user cleans
up, and refusing it would make archiving a trap.

## Decisions

### Original files live in an S3-compatible object store (decided 2026-08-12)

§5.1 requires the original upload to be preserved and §17 requires it to
be encrypted at rest.

**Chosen: an S3-compatible object store** — MinIO as a docker-compose
service locally, any S3 API in deployment — behind one `src/lib/storage.ts`
module. Objects are keyed
`spaces/<spaceId>/sources/<sourceId>/original.pdf` and the key is
recorded in `Source.fileKey` (the column already exists). The key is
derived from ids, not from the user's filename — a filename is user
input and has no business in a path; the original filename is stored as
metadata.

Rejected:

- **Postgres `bytea`.** Every 25 MB upload would enter WAL, backups, and
  Prisma's result buffers; a database restore would carry the corpus.
- **The local filesystem.** Simpler for a single VPS, but it ties the
  API and the worker to the same host at exactly the moment this phase
  splits them into two processes, and it pushes §17's encryption at rest
  onto whoever remembers to encrypt the volume.

What this buys, and what it costs:

- **Encryption at rest becomes configuration, not a hope** — bucket-level
  SSE (SSE-S3 or SSE-KMS; MinIO's server-side encryption locally). §17
  is satisfied by a setting that can be asserted, rather than by a host
  property nobody can check from inside the app.
- **The worker no longer shares a disk with the API.** Both hold an S3
  client; neither needs the other's filesystem.
- The cost is a container, a bucket bootstrap step in the README, and
  four credentials in the environment — which must never reach the
  browser (§17), so the client never sees an endpoint or a key.

### Original files are proxied, not presigned (decided 2026-08-12)

`GET /sources/:id/file` streams the object through the API after
`assertOwnership`, forwarding `Range` so a Phase 3 PDF reader can seek.

The alternative — issuing a short-lived presigned URL and redirecting —
is one fewer hop, but it hands the browser a bearer-URL for the object
that works for anyone it is pasted to until it expires, and it exposes
the bucket endpoint. Ownership is a per-request obligation in §17;
proxying keeps it that way. Revisit if the Phase 3 reader shows the hop
costing real latency — the decision is local to one route.

### Object deletion is a queued job, not a best-effort call (decided 2026-08-12)

§17 requires permanent deletion to remove the original file. `DELETE
/sources/:id` deletes the row (passages and citations cascade) and then
enqueues a `purge-object` job carrying the key.

Ordering matters and neither order is free: delete the object first and
a failed transaction leaves a live source pointing at nothing; delete
the row first and a failed `DeleteObject` leaves an orphan the §17
requirement forbids. The row goes first — a dangling object is
recoverable, a source whose file silently vanished is not — and the
queue is what makes the second half durable rather than best-effort. If
the enqueue itself fails, the route deletes inline and logs the key on
failure; that residual window is the one gap, and it is written down
rather than papered over.

### The worker is a separate process (decided 2026-08-12)

`backend/src/worker.ts`, started with its own `pnpm --filter backend
worker` script and its own docker-compose service, sharing `src/lib/`
with the API.

Parsing a 200-page PDF is CPU-bound and synchronous inside pdfjs. In the
API process it would stall the event loop, and §19's "primary screens
interactive within 2.5 s" would be at the mercy of whatever someone
uploaded. A separate process also means the worker can be restarted,
scaled, or crashed without touching sessions.

Cost accepted: two processes in local development (the README gains a
step), and a failure mode where the API is up and the queue is not — so
`/health` gains a queue probe alongside its existing db/redis/ollama
ones, and a source stuck in `processing` is visibly stuck rather than
silently lost.

### Retry reuses the source row; the queue is not the guard (decided 2026-08-12)

§6: "Retrying processing must not create duplicate source records" and
"Reprocessing must replace the previous extraction and retrieval index".

`POST /sources/:id/retry` mutates the existing row back to `processing`
and enqueues it again. The **state is the guard**: the route answers
`409` unless the source is `failed`, so a double-clicked retry enqueues
once. BullMQ's `jobId` deduplication (`jobId: source:<id>`) is a second
line of defence for the window where a job is queued but the row has not
been written yet — deliberately not the primary one, because a
deduplication key that expires when the job completes cannot express
"this source is already being worked on".

Step 5 replaces the extraction inside one transaction: delete every
`Passage` of the source, insert the new set, update `Source.content` and
`state`. There is no window where a source is `ready` with a half-written
index.

### Transient failures retry; permanent ones fail immediately (decided 2026-08-12)

Two error classes in the worker:

- **Retryable** — the embedding service is unreachable, the site
  answered 5xx, a fetch timed out. BullMQ `attempts: 3`, exponential
  backoff. The source stays `processing` between attempts.
- **Permanent** (`UnretryableIngestError`) — corrupted or
  password-protected PDF, no text layer, over the page limit,
  Readability found no article, empty content. The job fails at once and
  the source goes `failed` with the message.

Retrying a corrupted PDF three times with backoff only delays telling
the user. The class distinction is what makes the automatic retry safe
to have at all; without it, "attempts: 3" turns every user error into a
90-second wait.

`Source.errorMessage` is written for humans and is what §16 requires:
plain language, no stack traces, no provider names. The underlying error
goes to the log — with the source id, never the content (§17).

### PDF extraction: `pdfjs-dist`, page by page (decided 2026-08-12)

§5.1 requires page boundaries preserved and page references recorded,
and §6's acceptance criteria re-check that page references are still
accurate after processing. `pdfjs-dist` (legacy build) exposes
`getPage(n).getTextContent()`, so page number is *structural* — a
passage is built inside one page and its `page` cannot drift.

Rejected: `pdf-parse` and friends, which return one text blob; page
number would have to be reconstructed by counting form feeds, which is a
guess, and §6 makes it an acceptance criterion.

Detection rules, in order: `PasswordException` → "This PDF is password
protected."; page count over `pdf_max_pages` → the limit message; total
extracted characters below a small floor → "This PDF has no selectable
text — scanned documents are not supported." (§20 excludes OCR, so this
is a final state, not a TODO); any parse throw → "This file could not be
read as a PDF."

Paragraph resolution *within* a page is a heuristic (line-gap based) and
the PRD only requires page granularity for PDFs — accepted as-is, as
flagged in [[../../README]] §7 risk 1.

### Web extraction: fetch + Readability, with an SSRF guard (decided 2026-08-12)

`undici` fetch (redirects capped at 5, response byte-capped, timeout) →
`jsdom` → `@mozilla/readability` → metadata from the Readability result
plus OpenGraph and `<meta>` tags for publisher, author, and publication
date (§5.2).

**The URL is attacker-controlled input**, and the fetch runs inside the
worker on the server's network. Before every request — and after every
redirect — the host is resolved and rejected if it lands on loopback,
private, link-local, or unique-local ranges, and non-`http(s)` schemes
are rejected outright. §17 says uploaded files must be validated before
processing; a URL deserves the same treatment, and this is the one place
in the MVP where a user can aim the server at an address of their
choosing.

No headless browser: a JavaScript-only or paywalled page fails with
"The article text could not be extracted from this page." and a retry
action ([[../../README]] §7 risk 3). Adding Playwright would mean a
browser in the deployment for a minority of pages.

### Chunking: paragraph-aware, never across a page or a source (decided 2026-08-12)

One chunker, called with a list of already-located blocks
(`{ text, page?, paragraphIndex, heading? }`) produced per source type.
Target ≈1,200 characters with ≈15% overlap, split on paragraph
boundaries and only mid-paragraph when a single paragraph exceeds the
target.

Two hard rules, both structural rather than checked after the fact:

- **A passage never spans two sources** — the chunker is invoked per
  source and takes no source id at all, so mixing is not expressible.
  §6 states this as a requirement; making it unrepresentable is cheaper
  than testing for it.
- **A PDF passage never spans two pages**, which is what keeps `page`
  exact.

Locators: `page` for PDFs; `paragraphRef` (`p12`, or `p12-p14` for a
merged chunk) for web and manual; `sectionHeading` carries the nearest
preceding heading for all three (§6 "section headings should remain
associated with their passages"). `ord` is the passage's position within
its source and is what a Phase 3 reader will scroll by.

### Passages are written with raw SQL (decided 2026-08-12)

`Passage.embedding` and `Passage.tsv` are Prisma `Unsupported(...)`
columns, which Prisma can read around but cannot write. Step 5 uses one
parameterised `INSERT ... SELECT` over `unnest()` per batch, computing
`to_tsvector('english', text)` in the same statement so the FTS vector
can never drift from the text. Vectors are formatted by the existing
`toVectorLiteral()` (`backend/src/lib/embeddings.ts`).

Embedding calls are batched (≈32 passages per request) through the
existing `embed()`, which already validates dimension per vector and
throws `dimension_mismatch` — in the worker that is treated as
permanent, not retryable: no amount of retrying fixes a model swap.

### Still no ANN index (decided 2026-08-12)

The `Passage` schema comment defers the HNSW question to "Phase 2 when
passages are actually written" (`backend/prisma/schema.prisma:146`).
Revisited, and the answer is still no: at §5's ceiling of 50 sources per
space, exact KNN over a few thousand rows is far inside §19's budget,
and a hand-written HNSW index shows up as drift that `prisma migrate
dev` proposes dropping on every later migration. The revisit moves to
Phase 4, where there is a real retrieval query to measure instead of a
guess. The schema comment is updated to say Phase 4 so the deferral does
not become a permanent "later".

### Limits are enforced where they are knowable (decided 2026-08-12)

All four come from `loadLimits()` (`backend/src/config.ts:82`) — no
constants, per PRD §5 and the working agreement.

| Limit | Enforced | Response |
|---|---|---|
| `sources_per_space` | Counted inside the create transaction | `409` |
| `pdf_max_bytes` | While streaming to disk; abort past the cap | `413` |
| `manual_max_chars` | zod, at request validation | `400` |
| `pdf_max_pages` | In the worker, after parsing | `failed` + message |

Page count is not knowable before parsing, so it is the one limit that
produces a failed source rather than a rejected request — a real
asymmetry worth stating, because "limits are validated up front" is the
obvious wrong summary of this table. Sizes are checked *while* streaming,
not from `Content-Length`, which a client controls.

Phase 2 introduces **no new `AppConfig` key**. The web fetch's byte cap
and timeout are env vars, not `AppConfig`: they are safety valves on a
network call, not the operator-tunable product limits §5 enumerates.

### Retrieval eligibility is one exported filter (decided 2026-08-12)

`retrievableSources(spaceId)` in a single module returns the Prisma
where-clause `{ spaceId, state: 'ready', archivedAt: null }`. Phase 4
must build every retrieval query from it.

There is no assistant yet, so this codifies an invariant against a
consumer that does not exist — deliberately. PRD §6/§9/§17 state it
three times, and the failure mode is silent: a retrieval query that
forgets `archivedAt` returns plausible answers from evidence the user
withdrew. Defining the filter now means Phase 4 inherits it instead of
re-deriving it. Notes need no filter — a note is not a `Source` until
§12 conversion makes one.

### State changes are pushed over SSE (decided 2026-08-12)

`GET /spaces/:id/events` is a Server-Sent Events stream, opened while a
space is on screen and carrying one event per source state change:
`{ sourceId, state, errorMessage? }`. Nothing else — no text, no
passages (§17: content stays out of transports that do not need it).

Rejected: polling the list every 2 s while anything is `processing`.
That is fewer moving parts, but it makes "ready" arrive up to two
seconds late for a pipeline whose §19 budget is two minutes, and it
re-fetches the whole list to learn one enum. The deciding argument is
Phase 4: the assistant streams tokens over SSE regardless, so this is
transport that gets built either way — building it here means Phase 4
inherits a tested one instead of this phase inheriting a poller nobody
removes.

The parts that are easy to get wrong:

- **The worker is a different process from the API**, so it cannot write
  to a client's connection. It publishes to a Redis channel
  (`space:<spaceId>`) and the API relays. This is the actual reason SSE
  costs more than polling here, and it is the piece to build first.
- **The subscriber needs its own Redis connection.** An ioredis client
  in subscriber mode refuses ordinary commands, and `app.redis` is the
  BullMQ connection — sharing it would break the queue. A dedicated
  connection is created in the SSE plugin.
- **There is no event replay.** Missing an event while disconnected is
  expected, so the client refetches the source list once on every
  (re)connect, and the stream is a latency optimization over that
  refetch rather than the source of truth. No `Last-Event-ID` buffer:
  replaying would mean retaining per-space history for a payload the
  client can re-derive with one request.
- **Ownership is checked before the stream opens** (`assertOwnership`),
  and the connection is torn down on sign-out.
- **Heartbeat comment every 15 s**, plus `Cache-Control: no-cache` and
  `X-Accel-Buffering: no`, so an idle connection survives a proxy.
- **`EventSource` needs `withCredentials: true`** — the SPA is on `:5173`
  and the API on `:4000`, so the session cookie is a cross-origin one
  and CORS must keep `credentials` enabled for this route.
- **A defined fallback**: if the stream fails to open twice, the client
  falls back to a 5 s poll and stays there for the session. An
  environment that strips SSE must still show a source turning ready —
  §16 requires the processing state to resolve, not to resolve quickly.

Per-user concurrent connections are capped so a leaked tab cannot pin
connections open indefinitely.

### Activity rows: added, ready, failed (decided 2026-08-12)

`source.added` on create, `source.ready` / `source.failed` on
completion, each with `refId = sourceId` — exactly the events §15 lists,
continuing Phase 1's "write history before the feed exists" decision.
The terminal rows are written by the worker in the same transaction as
the state change, so an activity entry can never claim a source is ready
when it is not.

## Frontend

### Live updates

One `EventSource` per open space, opened on mount and closed on unmount.
Each event patches the cached source in the TanStack Query cache rather
than invalidating the list — the payload already carries everything the
list row shows for a state change. Every (re)connect triggers one list
refetch to close the gap the stream cannot (see "State changes are
pushed over SSE" above), and two failed opens drop the feature to a 5 s
poll for the rest of the session.

State changes are announced through an `aria-live="polite"` region and
every state is shown as icon + text, never color alone (§18). The
failure state carries the message and a **Retry** action; §16 requires
Retry wherever retrying is safe.

### Structure

```
src/features/sources/
  use-sources.ts          list / create / upload / retry / delete hooks
  use-source-events.ts    EventSource + cache patching + poll fallback
  add-source-dialog.tsx   three tabs: PDF · Web link · Text
  source-list.tsx         cards: title, type, author, state, date added
  source-state-badge.tsx  icon + text, aria-live announcements
  delete-source-dialog.tsx
```

The Add Source dialog is **one** dialog with three tabs. §5.3 is
explicit that the interface must not offer separate "pasted text" and
"manual source" options, and three top-level buttons would recreate that
split by another name. Upload uses a real `<input type="file">` behind a
labelled button plus a drop target, so the keyboard path is the native
one (§18).

The space shell's disabled Add Source button and its "arrives in the
next phase" hint are removed (`frontend/src/routes/space-page.tsx:125`);
the empty-source-library copy stays, since an empty library is still a
§16 state.

Layout follows the `source_library` mockup's card grid
([[../../wireframe/index]]) — layout only. Its status pills, tags, grid/
list toggle, sort, and trash are §20 exclusions or Phase 3 work.

## New dependencies and migration

**Backend:** `bullmq`, `@fastify/multipart`, `pdfjs-dist`,
`@mozilla/readability`, `jsdom`, `@aws-sdk/client-s3`,
`@aws-sdk/lib-storage`. **Frontend:** none — `EventSource` is native.

**Infrastructure:** a `minio` service in `docker-compose.yml` plus a
one-shot bucket-create step, and a `worker` service.

**Env:** `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (MinIO), plus
`INGEST_CONCURRENCY` (default 2), `WEB_FETCH_TIMEOUT_MS`,
`WEB_FETCH_MAX_BYTES`, `SSE_MAX_CONNECTIONS_PER_USER`.

**Migration:** none for columns. One migration adds the trigram/index
work only if Phase 3 needs it — Phase 2 writes `tsv` into the existing
GIN-indexed column and changes no DDL. The only schema-file edit is the
`Passage` comment moving its ANN revisit from Phase 2 to Phase 4.

## Testing

- **Backend** (`backend/test/`): limits (each of the four, including
  `AppConfig` override taking effect without a restart), ownership 404
  for a foreign source, `401` unauthenticated, `409` retry on a
  non-failed source, `409` writes into an archived space, and permanent
  delete removing the object + passages + citations.
- **Storage** (`backend/test/storage.test.ts`): run against a real MinIO
  rather than a mocked S3 client — the failure modes worth catching (the
  byte cap tripping mid-upload, aborting the partial, `Range` through
  the proxy route) are exactly the ones a mock invents away.
- **SSE** (`backend/test/events.test.ts`): ownership 404 before the
  stream opens, an event published to the Redis channel by a fake worker
  arriving at a subscribed client, the heartbeat, and the per-user
  connection cap.
- **Pipeline** (`backend/test/ingest/`): the worker's job handler called
  directly with a stubbed `embed()` and stubbed fetch — a small
  text-based PDF fixture (page references asserted against known
  content), a password-protected fixture, a text-layer-free fixture, an
  HTML fixture through Readability, and manual text. Reprocess is
  asserted by running the handler twice and checking the passage count
  and `ord` sequence are unchanged, not doubled.
- **Citation staleness**: rows are hand-seeded through Prisma (Phase 4
  owns the only real producer), then a reprocess is run and the
  re-match / mark-stale outcome asserted.
- **SSRF guard**: unit tests over the host check — loopback, RFC1918,
  link-local, and a redirect that lands on one.
- **Frontend** (Vitest + Testing Library): the three tabs' validation,
  input preserved on failure, a stubbed `EventSource` moving a card from
  processing to ready, the refetch on reconnect, the fallback to polling
  after two failed opens, the failed card's message and Retry, and the
  delete confirmation.

## Cross-references

- [[proposal]] — scope and acceptance criteria.
- [[tasks]] — work breakdown.
- [[../phase-1-spaces/design]] — the frozen-archived-space rule and the
  inert Add Source button this phase activates.
- [[../phase-0-foundation/design]] — schema, Redis, embeddings client,
  `loadLimits()`.
- [[../../specs/spaces/spec]] — space behavior these routes sit inside.
- [[../../wireframe/index]] — `source_library` layout reference.
