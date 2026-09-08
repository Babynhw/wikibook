# WikiBookLM

A personal research workspace: organize evidence sources, ask citation-grounded
questions, save answers as notes, and draft findings in a notebook.

Phases 0–4 are implemented — monorepo and local infrastructure, session auth,
research spaces, source ingestion (PDF / web link / pasted text through a queued
pipeline with live processing states), the source library and reader, and the
citation-grounded assistant (hybrid retrieval, streamed answers, citations that
open the exact passage). See
[`wiki-docs/plan/`](wiki-docs/plan/) for the plans this repository implements and
[`wiki-docs/README.md`](wiki-docs/README.md) for the full architecture and
7-phase roadmap.

## Prerequisites

| Tool | Version used |
|---|---|
| Node.js | 22 |
| pnpm | 10 |
| Docker (with Compose) | 29 |
| [HuggingFace](https://huggingface.co) account | for an Inference API token |

Embeddings are **not** local — the backend calls HuggingFace's serverless
Inference API. Create a token with the *Make calls to Inference Providers*
permission at <https://huggingface.co/settings/tokens> and set it in
`backend/.env`:

```
HF_API_KEY=hf_…
```

The server refuses to start without it: there is no unauthenticated path to the
Inference API, and every ingest and every question needs an embedding.

## Quick start

```sh
pnpm install

# Postgres (pgvector) on :5432, Redis on :6379, MinIO on :9000 (console :9001).
# A one-shot `minio-init` container creates the private `wikibooklm` bucket and
# turns on server-side encryption (PRD §17) — no manual bucket step needed.
docker compose up -d

# Backend configuration
cp backend/.env.example backend/.env
# Then configure an answer provider — the API refuses to start without a usable
# one, because an assistant with no provider cannot answer anything (PRD §9):
#   ANSWER_PROVIDER=anthropic          + ANSWER_API_KEY=…       (Claude, or its Skin)
#   ANSWER_PROVIDER=openai-compatible  + ANSWER_BASE_URL=…      (Ollama needs no key)
# Embeddings are a separate provider (HF_API_KEY) and are also required to boot.

# Apply the schema and seed the runtime limits (PRD §5)
pnpm db:migrate
pnpm db:seed

# API on :4000, ingestion worker, frontend on :5173
pnpm dev
```

Upgrading a database that already has sources: the Phase 3 migration adds the
reader's `SourceBlock` rows and does **not** backfill them, because rebuilding
them means re-running extraction. Sources ingested before it still open in the
reader — the highlight falls back to the recorded page or paragraph — but they
have no text to page through, so re-add them (or `docker compose down -v` and
start fresh) while the project is still pre-release.

The ingestion worker is a **separate process** from the API (a 200-page PDF
parse must not stall the request loop) and `pnpm dev` runs both. Sources sit in
`processing` forever if only the API is up — `GET /health` probes the queue so
that shows up as `degraded` rather than as silence.

Open <http://localhost:5173>, create an account, and the home screen shows live
service health read from the API.

## Layout

```
backend/     Fastify + Prisma API (see backend/README.md)
frontend/    Vite + React SPA (see frontend/README.md)
wiki-docs/   Project knowledge wiki: plans, designs, specs
  wireframe/ Sample screen designs — see wiki-docs/wireframe/index.md
docker-compose.yml
```

Screen designs for the phases still to come live in
[`wiki-docs/wireframe/`](wiki-docs/wireframe/index.md): a `screen.png` and a
standalone `code.html` per screen (login, source library, knowledge assistant,
saved notes, research notebook). They are a **visual reference only** — the PRD
decides scope, `frontend/DESIGN.md` decides tokens, and the mockups deliberately
show several things the MVP must not have. Read
[`wireframe/index.md`](wiki-docs/wireframe/index.md) before building from them.

## Root scripts

| Script | Does |
|---|---|
| `pnpm dev` | Runs the API, the ingestion worker, and the frontend concurrently |
| `pnpm build` | Type-checks and builds both packages |
| `pnpm lint` | Type-checks both packages |
| `pnpm test` | Runs both test suites (backend needs Postgres + Redis up; frontend needs neither) |
| `pnpm db:up` / `pnpm db:down` | Starts / stops Postgres, Redis, and MinIO |
| `pnpm db:migrate` | `prisma migrate dev` in `backend/` |
| `pnpm db:seed` | Seeds `AppConfig` limits |

## Verifying the setup

```sh
curl -s http://localhost:4000/health          # db / redis / queue / embeddings, each probed
pnpm --filter backend embed:smoke             # 768-dim vector from HuggingFace
pnpm --filter backend test                    # needs Postgres, Redis, and MinIO up
pnpm --filter frontend test                    # session guard, forms, api client
```

`GET /health` returns 200 when Postgres is reachable and reports each dependency
individually; a missing Redis or queue, or an unreachable HuggingFace, shows as
`degraded` rather than a hard failure, so you can work on parts of the system in isolation.

The backend suite talks to real infrastructure on purpose: `storage.test.ts`
runs against MinIO rather than a mocked S3 client, because the byte cap and the
`Range` proxy are exactly the behavior a mock would invent.

Two things fail the suite for reasons that are not the code. **Stop the ingestion
worker first** — a worker attached to the same Redis consumes the jobs the ingest
tests enqueue, and both processes then write the same `SourceBlock` rows, failing a
unique constraint inside `persist.ts`. And the suite loads `backend/.env`, so the
assistant variables the tests depend on are pinned in `vitest.config.ts` rather than
read from your own configuration.

## Notes for the next phase

- Password reset emails have no provider yet: the reset token is written to the
  server log. Choosing a provider is an open decision (Phase 0 proposal).
- `Passage.embedding` is `vector(768)`, matching `intfloat/multilingual-e5-base`.
  Changing the embedding model — or either task prefix — requires a full re-embed
  (`pnpm --filter backend reprocess:sources --all`), and a different dimension
  requires a migration too; the server refuses to start if the model's dimension
  disagrees with `EMBEDDING_DIM`.
- Only models with a **live serverless inference provider** work as
  `EMBEDDING_MODEL`. Most of the Hub has none, `nomic-ai/nomic-embed-text-v1.5`
  included — asking for one returns a 404 that names the model. Point `HF_BASE_URL`
  at a dedicated HF Inference Endpoint or a self-hosted
  [TEI](https://github.com/huggingface/text-embeddings-inference) to run a model
  nobody serves; the request shape is identical.
- No ANN (HNSW) index exists on `Passage.embedding`, and Phase 4 settled that
  rather than deferring it again: measured at the §5 ceiling (50 sources, 300
  passages) hybrid retrieval is p75 52 ms, ~34 ms of which was the embedding call
  against a local Ollama — a hosted embedding call is slower, which widens the
  margin over exact KNN rather than narrowing it. See the comment in `backend/prisma/schema.prisma`.
- The assistant answers through one of two citation tiers, selected by
  `ANSWER_PROVIDER`: `anthropic` (Claude's native Citations — also how you reach
  OpenRouter's Anthropic Skin, by setting `ANSWER_BASE_URL`) or
  `openai-compatible` (a JSON schema of our own, for OpenRouter's chat
  completions, Ollama, vLLM, or LM Studio). Embeddings are a separate provider
  either way (`HF_*`). `backend/.env.example` has the combinations.
- Two things are **unverified** for want of credentials: §19's 8 s
  time-to-first-token on either tier, and whether Anthropic's citations survive a
  proxy such as the Anthropic Skin — that one fails *quietly*, as a run of
  uniformly ungrounded answers. Also unverified by CI: the model-behaviour
  claims (honest insufficiency, conflicting evidence presented without
  resolution). See `wiki-docs/specs/assistant/spec.md` → Verification for the
  questions to ask, and record the results there.
