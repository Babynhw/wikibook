---
title: Phase 2 — Tasks
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-12
tags: [phase-2, tasks]
---

# Tasks: Phase 2 — Source ingestion

Backend first (T1–T8) so the frontend builds against real routes and a
real queue. Estimated 2 weeks ([[../../README]] §6).

The order inside the backend is deliberate: storage, the queue, and the
event fan-out (T1–T2b) before extraction (T4), because a pipeline that
cannot persist anything cannot be tested end to end — and because the
worker → Redis → SSE path is the piece most likely to be wrong, so it is
worth having before there is real work flowing through it.

## Backend (`backend/`)

### T1 — Object storage

- [x] `minio` service + one-shot bucket-create step in
      `docker-compose.yml`; bucket has server-side encryption enabled
      (PRD §17), and the README gains the bootstrap step
- [x] `src/lib/storage.ts` — the only module that knows S3 exists:
      `put(stream, key, contentType)`, `get(key, range?)`,
      `remove(key)`, `keyFor(spaceId, sourceId)`
      ([[design]] "Original files live in an S3-compatible object store")
- [x] `put` uses `@aws-sdk/lib-storage` and enforces a byte cap through a
      counting stream — never trusts `Content-Length`; passing the cap
      aborts the multipart upload so no partial object is left behind
- [x] Keys are derived from ids only; the user's filename is stored as
      object metadata, never used in a key
- [x] `S3_*` credentials, `INGEST_CONCURRENCY`, `WEB_FETCH_TIMEOUT_MS`,
      `WEB_FETCH_MAX_BYTES`, `SSE_MAX_CONNECTIONS_PER_USER` added to
      `src/config.ts` and `.env.example`; nothing S3 is ever serialized
      to a client response (PRD §17)

### T2 — Queue and worker process

- [x] `src/lib/queue.ts` — BullMQ `ingest` queue on the existing Redis
      connection (`jobId: source:<sourceId>`, `attempts: 3`, exponential
      backoff) and a `purge-object` queue for deferred object deletion
      ([[design]] "Object deletion is a queued job")
- [x] `src/worker.ts` — separate entrypoint, `worker` script in
      `package.json`, service in `docker-compose.yml`
- [x] `/health` gains a queue probe next to db / redis / ollama
- [x] Worker logs carry the source id and never source content (PRD §17)

### T2b — Event fan-out and SSE

- [x] Worker publishes `{ sourceId, state, errorMessage? }` to the Redis
      channel `space:<spaceId>` on every state change — and nothing else;
      no text or passages cross this channel (PRD §17)
- [x] `src/plugins/events.ts` — a **dedicated** Redis subscriber
      connection (ioredis subscriber mode refuses ordinary commands, and
      `app.redis` belongs to BullMQ), fanning out to local subscribers
- [x] `GET /spaces/:id/events` — SSE behind
      `[app.requireUser, assertOwnership('space', 'id')]`;
      `Cache-Control: no-cache`, `X-Accel-Buffering: no`, 15 s heartbeat,
      per-user connection cap, teardown on sign-out and on close
- [x] CORS keeps `credentials` for this route — `EventSource` sends the
      session cookie cross-origin only with `withCredentials`

### T3 — Source routes

- [x] `src/routes/sources.ts` registered in `src/app.ts`; space-scoped
      routes use `assertOwnership('space', 'id')`, source-scoped routes
      `assertOwnership('source', 'id')`
- [x] `POST /spaces/:id/sources` — zod-validated `web` and `manual`
      bodies; manual requires title + non-empty content, optional
      author; web requires a valid http(s) URL
- [x] `POST /spaces/:id/sources/upload` — `@fastify/multipart`, PDF
      only, streamed through `storage.put`
- [x] `GET /spaces/:id/sources` — list with title, type, author, state,
      `errorMessage`, `createdAt`
- [x] `GET /sources/:id`, and `GET /sources/:id/file` streaming the
      object through the API with `Range` forwarded — never a presigned
      redirect ([[design]] "Original files are proxied, not presigned")
- [x] `POST /sources/:id/retry` — `409` unless `state = failed`; resets
      to `processing` and enqueues
- [x] `DELETE /sources/:id` — permanent: the row goes in a transaction
      (passages and citations cascade), then a `purge-object` job removes
      the stored original; a failed enqueue falls back to an inline
      delete and logs the key (PRD §17)
- [x] Every write answers `409` with the Phase 1 archived message when
      the owning space is archived — `retry` included; `GET` and
      `DELETE` stay allowed ([[design]] "API surface")
- [x] Rate-limit the create and upload routes (`global: false`, as in
      `routes/spaces.ts`)

### T4 — Extractors

- [x] `src/ingest/extract-pdf.ts` — `pdfjs-dist`, page by page; returns
      located blocks with `page`; maps `PasswordException`, no-text-layer,
      over-`pdf_max_pages`, and parse failures to `UnretryableIngestError`
      with the plain-language messages in [[design]]
- [x] `src/ingest/extract-web.ts` — capped/timeout fetch → `jsdom` →
      `@mozilla/readability`; captures title, publisher, author,
      publication date when available; preserves the original URL
- [x] `src/ingest/url-guard.ts` — scheme allowlist and
      loopback/private/link-local rejection, re-checked after **every**
      redirect ([[design]] "Web extraction")
- [x] `src/ingest/extract-manual.ts` — normalizes entered text into
      paragraph blocks; the entered content is the original (PRD §5.3)
- [x] `src/ingest/errors.ts` — `UnretryableIngestError` vs retryable;
      the worker's only branch point

### T5 — Chunking

- [x] `src/ingest/chunk.ts` — takes located blocks, returns passages;
      takes no source id, so a passage cannot mix sources ([[design]])
- [x] Never merges across a PDF page boundary
- [x] Emits `ord`, `page`, `paragraphRef` (`p12` / `p12-p14`),
      `sectionHeading` from the nearest preceding heading

### T6 — Embed and persist

- [x] `src/ingest/persist.ts` — batched `embed()` (≈32 per call), then
      one transaction: delete existing passages, `INSERT ... SELECT`
      over `unnest()` with `to_tsvector('english', text)` computed in
      the same statement, update `Source.content` and `state`
- [x] `dimension_mismatch` from `embed()` is treated as permanent
- [x] Citations of the reprocessed source: re-match by exact quoted text
      where possible, otherwise `stale = true` (PRD §6)
- [x] `source.ready` / `source.failed` `Activity` written in the same
      transaction as the state change; `source.added` written with the
      source in T3

### T7 — Retrieval eligibility

- [x] `src/lib/retrieval-scope.ts` — exported
      `retrievableSources(spaceId)` → `{ spaceId, state: 'ready',
      archivedAt: null }`, with the comment saying Phase 4 must build
      every retrieval query from it (PRD §6/§9/§17)
- [x] `backend/CLAUDE.md` records the rule

### T8 — Tests

- [x] `test/sources.test.ts` — the four limits (incl. an `AppConfig`
      change taking effect without a restart), foreign-source 404,
      unauthenticated 401, retry 409, archived-space 409, delete removes
      object + passages + citations
- [x] `test/storage.test.ts` — against a real MinIO, not a mocked S3
      client: the byte cap tripping mid-upload leaves no object, `Range`
      survives the proxy route, `remove` is idempotent
- [x] `test/events.test.ts` — ownership 404 before the stream opens, an
      event published to `space:<id>` reaching a subscribed client, the
      heartbeat, and the per-user connection cap
- [x] `test/ingest/*.test.ts` — PDF fixtures (text-based with known page
      content, password-protected, no text layer), an HTML fixture, and
      manual text, with `embed()` and fetch stubbed
- [x] Reprocess: run the handler twice, assert passage count and `ord`
      sequence are unchanged and that no duplicate `Source` appears
- [x] Citation staleness against hand-seeded citation rows
- [x] `url-guard` unit tests, including a redirect into a private range
- [x] Mutation checks: break the page-boundary rule in `chunk.ts`, drop
      `archivedAt` from `retrievableSources`, and remove the retry-state
      guard — each must fail exactly one named test

## Frontend (`frontend/`)

### T9 — Data layer

- [x] `src/features/sources/use-sources.ts` — list / create / upload /
      retry / delete hooks
- [x] `use-source-events.ts` — one `EventSource` per open space
      (`withCredentials`), patching the cached source on each event
      rather than invalidating the list
- [x] One list refetch on every (re)connect — the stream has no replay,
      so the refetch is what closes the gap
      ([[design]] "State changes are pushed over SSE")
- [x] After two failed opens, fall back to a 5 s poll for the session
- [x] Upload posts `FormData` through the existing `api` client with
      cookies preserved

### T10 — Add Source and the list

- [x] `add-source-dialog.tsx` — one dialog, three tabs (PDF · Web link ·
      Text). Not three separate entry points (PRD §5.3)
- [x] Client-side validation mirrors the server's; input is preserved on
      failure (PRD §16)
- [x] `source-list.tsx` — title, type, author, state when not ready,
      date added, and nothing from §7's "must not display" list
- [x] `source-state-badge.tsx` — icon + text (never color alone) and an
      `aria-live="polite"` announcement on state change (PRD §18)
- [x] Failed card shows `errorMessage` plus **Retry**;
      `delete-source-dialog.tsx` confirms before deleting (PRD §6)
- [x] `space-page.tsx`: the disabled Add Source button and its
      "next phase" hint are removed; the empty-library §16 state stays

### T11 — Frontend tests

- [x] Tab validation, preserved input on failure, a stubbed
      `EventSource` moving a card from processing to ready, the refetch
      on reconnect, the poll fallback after two failed opens, failed card
      renders message + Retry, delete confirmation is required
- [x] Tests cite REQ ids once the spec is written (the convention in
      [[../../specs/AGENTS]])

## Exit criteria

- [x] Every acceptance criterion in [[proposal]] is exercised — by test
      where possible, by hand otherwise, and anything unverified is
      written down rather than dropped
- [x] The §21 scenario reaches "Observe source processing and recover
      from a failure": PDF, web article, and manual source all added to
      one space, one made to fail, retried, and delivered ready
- [x] A text-based PDF of ordinary size processes within two minutes
      (PRD §19), measured once and recorded
- [x] No hard-coded limit anywhere in the ingestion path; changing an
      `AppConfig` row changes behavior within the cache TTL
- [x] Failed and archived sources are provably absent from
      `retrievableSources`
- [x] A source reaching `ready` updates an open space view without a
      reload, and still resolves with the event stream blocked
- [x] Deleting a source leaves no object in the bucket; no storage
      endpoint or credential appears in any client response (PRD §17)
- [x] `specs/ingestion/spec.md` written from the verified behavior,
      `index.md` updated, `log.md` appended, `tasks.md` ticked and
      `status: done`

## Implementation notes (2026-08-12)

Every task above is implemented and verified; the behavior that was actually
verified is written up in [[../../specs/ingestion/spec]]. The deviations from
[[design]] and the things a later phase needs to know:

- **The worker is a host process, not a compose service.** T2 asked for a
  `worker` service in `docker-compose.yml`. Compose holds infrastructure only —
  there is no Dockerfile for either package, and the API itself runs on the host
  under `tsx` — so a containerized worker would have been the only app code in
  compose, needing a build, a mounted source tree, and `host.docker.internal` to
  reach Ollama. Instead `pnpm dev` runs the API, the worker (`pnpm dev:worker`),
  and the SPA together, and `/health`'s queue probe is what makes a missing
  worker visible. Revisit when the project gains real container images.
- **`chunk.ts` was left with a mutation-check edit in it.** The page-boundary
  flush had been deleted and replaced with `// mutated: boundary flush removed`,
  which was a syntax error — so `test/ingest/pipeline.test.ts` could not even
  load, and eight tests never ran. Restored, and `test/ingest/chunk.test.ts` now
  covers the rule directly (it is the test the mutation was supposed to fail).
  A mutation check is not finished until the mutation is reverted and the suite
  is green again.
- **Retry did not re-queue anything.** Found by running the pipeline for real,
  not by the suite: BullMQ keeps settled jobs, and `add` with an existing `jobId`
  is a silent no-op, so `POST /sources/:id/retry` answered 200, set the source to
  `processing`, and queued nothing — every retry after the first job settled left
  the source stuck. `enqueueOrFail` now removes the settled job before adding
  (an *active* job refuses removal, which is the double-click case we want to
  leave alone), and `test/sources-queue.test.ts` is the regression.
- **The worker no longer forces jobs to `failed` itself.** Calling
  `job.moveToFailed()` inside the processor fought BullMQ for the job lock and
  logged `Missing lock ... moveToFinished` on every permanent failure. A permanent
  failure now returns normally (the source is already `failed` with its message)
  and an exhausted transient failure rethrows so BullMQ records it.
- **`dimension_mismatch` is mapped in `persist.ts`**, where `embed()` is called,
  rather than in the worker's branch point — it is the only embedding error that
  is permanent, and the mapping belongs next to the call that can raise it.
- **The list badges only non-ready states.** A library of green ticks is noise;
  `SourceStateBadge` renders for `processing`/`failed` and a separate always-mounted
  `SourceStateAnnouncer` owns the polite announcement, so reaching `ready` — the
  transition worth hearing — is still announced after the badge disappears.
- **Each card links "Open the original"** — the proxied `GET /sources/:id/file`
  for a PDF, the source URL for a web link. Otherwise the proxy route built in T3
  would have no caller until the reader lands in Phase 3.
- **Two toolchain fixes came with this phase.** `prisma`'s bundled studio pulls
  `@types/react` 19 into the workspace, and pnpm hoisted it where react-router's
  own `.d.ts` files found it first — `pnpm --filter frontend lint` was already
  failing with "cannot be used as a JSX component" on untouched Phase 0/1 files.
  Root `pnpm.overrides` pin the types to 18 and `.npmrc` keeps them out of the
  hoisted tree.
- **`GET /health` gained a `queue` probe**, and `frontend/src/lib/api.ts`'s
  `Health` type with it. Nothing renders it yet — the home screen's health panel
  is Phase 6 — but the type would otherwise be a lie.
