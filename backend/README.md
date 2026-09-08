# backend

Fastify 5 + TypeScript API for WikiBookLM. Prisma 7 over PostgreSQL 16 with
pgvector; Redis backs the ingestion queue from Phase 2 onward.

## Scripts

| Script | Does |
|---|---|
| `pnpm dev` | `tsx watch src/index.ts` on `:4000` |
| `pnpm dev:worker` | `tsx watch src/worker.ts` — the ingestion worker, a separate process |
| `pnpm worker` / `pnpm start:worker` | The worker without watch / from `dist/` |
| `pnpm build` | `tsc` to `dist/` |
| `pnpm lint` | Type-check only |
| `pnpm test` | Vitest suites (needs Postgres, Redis, and MinIO running) |
| `pnpm prisma:migrate` | `prisma migrate dev` |
| `pnpm prisma:seed` | Seeds `AppConfig` limits |
| `pnpm embed:smoke` | Embeds a sample string via HuggingFace and prints the dimension |

## Layout

```
prisma/schema.prisma      Full domain model (all phases)
prisma.config.ts          Prisma 7 config: schema path, migrations, seed, datasource
src/config.ts             zod-parsed env + AppConfig limits loader (cached)
src/app.ts                Plugin and route registration
src/index.ts              Bootstrap: limits → embedding check → listen
src/worker.ts             Ingestion worker entrypoint (separate process)
src/plugins/              prisma, redis, queues, events (SSE fan-out), session, error-handler
src/routes/               health, auth, spaces, sources, citations, conversations, events, notes, notebook
src/middleware/           assert-ownership
src/ingest/               extract-{pdf,web,manual}, url-guard, chunk, persist, pipeline, errors
src/lib/                  embeddings (HuggingFace), storage (S3), queue (BullMQ), retrieval-scope, errors
src/notebook/             validate-doc (the editor's node/mark whitelist), markdown (the §14 serialiser)
src/generated/prisma/     Generated client — not committed, run prisma:generate
test/                     auth, ownership, health, spaces, sources, storage, events, ingest/
```

`src/ingest/pipeline.ts` is the whole ingestion path in one readable function
(extract → chunk → embed → one transactional write) and takes its dependencies
as arguments, so the suites drive it directly without a running worker.

`auth-hardening.test.ts` is separate from `auth.test.ts` on purpose:
`@fastify/rate-limit` keeps one in-memory bucket per route per app instance, and
`/auth/register` allows 10/minute — merging the suites would start returning 429.

## Conventions

- **Every resource route registers `assertAccess(resource, param, minRole)`.**
  Access resolves through the owning `Space`'s `SpaceMember` rows
  (`src/middleware/assert-access.ts`): a non-member answers 404, never 403, so
  existence is not leaked (PRD §17); a member below `minRole` answers 403
  `insufficient_role`. Reads default to `viewer`; every write must say `editor` or
  `owner` — `test/ownership-table.test.ts` walks the route table and fails on one
  that does not. Conversations and messages are additionally private to the
  member who started them (another member's is 404). Add a resolver when a new
  resource type appears.
- **Errors never leak internals.** Throw the helpers in `src/lib/errors.ts`;
  anything else becomes a generic 500 with the detail logged server-side (PRD §16).
- **Routes are typed with `FastifyPluginAsyncZod`** so zod schemas drive both
  validation and response serialization.
- **Prisma 7 needs a driver adapter.** Build clients through
  `createPrismaClient()` in `src/lib/prisma.ts`, never `new PrismaClient()`.
- **`prisma migrate dev` does not regenerate the client** in Prisma 7 — run
  `pnpm prisma:generate` after schema changes.
- **Limits come from `AppConfig`**, read via `loadLimits()`. Never hard-code a
  limit that PRD §5 says is configurable.
- **A uniqueness pre-check is advisory, not a guarantee.** Two concurrent requests
  both pass it; catch the Prisma `P2002` as well and answer it exactly as the
  pre-check does. A response that differs under concurrency leaks existence.
- **Password reset delivery is console-only** while `hasEmailProvider`
  (`src/config.ts`) is false, and the server refuses to start in production in that
  state. Flip the flag and drop the logging branch when a provider lands.
- **Route option objects are per route, never shared.** `@fastify/rate-limit`
  *pushes* its hook into `routeOptions.onRequest`, so one `{ onRequest: [...] }`
  object spread across several routes collects every route's limiter and applies
  them all to each. Hence `ownedSpace()` / `ownedSource()` are factories: sharing
  one silently capped searching at the write routes' 60/minute.
- **A reader block is the unit a citation highlights.** `SourceBlock` rows are
  written in the same transaction as a source's passages, and each `Passage`
  records the `startBlockOrd`/`endBlockOrd` it was built from, so a highlight is a
  range lookup rather than a text match (PRD §8). Anything that rewrites passages
  rewrites blocks with them.
- **Retrieval reads through `retrievableSources()`** (`src/lib/retrieval-scope.ts`).
  Failed or archived sources must never reach retrieval, and an inline
  `state: 'ready'` filter is how that invariant rots (PRD §6/§9/§17).
- **Only `src/lib/storage.ts` knows S3 exists.** Object keys are derived from ids;
  the user's filename lives in object metadata. Originals are proxied through
  `GET /sources/:id/file`, never presigned — §17 makes ownership a per-request
  obligation, and a presigned URL works for whoever it is pasted to.
- **Ingestion failures split in two** (`src/ingest/errors.ts`): an
  `UnretryableIngestError` marks the source `failed` with a plain-language message,
  everything else rethrows and lets BullMQ retry. That branch is the worker's only
  decision.
- **The worker logs source ids, never source content** (PRD §17), and the Redis
  event channel carries `{ sourceId, state, errorMessage? }` and nothing else.

## Environment

See `.env.example`. `EMBEDDING_DIM` must match the `vector(...)` dimension in
`schema.prisma` — the server exits at startup if the configured model returns a
different dimension.

## Deploying

The following are deployment requirements, not code in this repository (PRD §17):

- **HTTPS at the reverse proxy.** TLS terminates at the load balancer or reverse
  proxy (nginx, Caddy, Traefik, cloud LB). The backend runs plain HTTP behind it;
  `trustProxy` is enabled in production so `req.ip` and `secure` cookies resolve
  correctly.
- **Encryption at rest.** Postgres (or the managed equivalent) must use storage
  encryption; the S3-compatible object store (MinIO, R2, S3) must use server-side
  encryption. The application does not encrypt individual fields — it would break
  Postgres FTS and pgvector (PRD §9).
- **Secure cookies.** `SESSION_COOKIE_NAME` defaults to `sid`. In production the
  cookie is set with `secure: true`, `httpOnly: true`, and `sameSite: 'lax'` by
  the session plugin; this requires a valid TLS certificate at the proxy.
- **Secrets management.** Provider keys (`ANSWER_API_KEY`, `ANTHROPIC_API_KEY`)
  are read from environment in `src/config.ts` and never reach the client bundle.
  The frontend reads no `VITE_*` variable at all (the API is same-origin under
  `/api`); `frontend/src/lib/public-env.test.ts` fails if one is added without
  being named in its allow-list.

For the full security checklist see `wiki-docs/specs/home-activity/spec.md` §17
Verification.
