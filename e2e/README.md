# e2e — PRD §21 acceptance walk

Two Playwright specs against a **running local stack**, each with fresh accounts
per run. `mvp-scenario.spec.ts` walks the twenty-one steps of PRD §21 in order.
`shared-space.spec.ts` (shared spaces v1) puts an owner, an editor, and a viewer
in three browser contexts: invite links, roles, attribution, notebook presence
and the named conflict, the space feed, removal and leaving — it never asks the
assistant, so it needs no answer provider and runs in about ten seconds.
Chromium only. It is **intentionally not in CI**: it needs a real answer
provider (a few cents per run), so it is run by hand before closing a phase and
before any release, and its result is recorded in the spec's Verification
section (`wiki-docs/specs/home-activity/spec.md`).

## What must be running

Everything the README's Quick start brings up, plus a pulled embedding model and
a configured answer provider. Playwright starts nothing itself — there is no
`webServer` block on purpose, so the spec stays a test and not an orchestrator.

| Piece | How | Where the spec expects it |
|---|---|---|
| Postgres (pgvector), Redis, MinIO | `docker compose up -d` (or `pnpm db:up`) | `:5432`, `:6379`, `:9000` — via the backend |
| Schema + `AppConfig` limits | `pnpm db:migrate && pnpm db:seed` | — |
| A HuggingFace Inference API token | create one at <https://huggingface.co/settings/tokens> with *Make calls to Inference Providers* | `HF_API_KEY` (no default — the server refuses to boot without it) |
| Answer provider | in `backend/.env`: `ANSWER_PROVIDER=anthropic` + `ANSWER_API_KEY=…`, or `ANSWER_PROVIDER=openai-compatible` + `ANSWER_BASE_URL=…` (see `backend/.env.example`) | the API refuses to start without one |
| Backend API | `pnpm --filter backend dev` | `:4000` |
| Ingestion worker | `pnpm --filter backend dev:worker` — a **separate process**; without it every source sits in `processing` | — |
| Vite dev server | `pnpm --filter frontend dev` | `:5173`, proxying `/api` → `:4000` |

`pnpm dev` from the repository root runs the API, the worker, and Vite together.
Check before running:

```sh
curl -s http://localhost:4000/health     # every dependency "ok" — "degraded" means something above is missing
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/
```

## Running

```sh
pnpm e2e                          # = playwright test -c e2e/playwright.config.ts
E2E_BASE_URL=http://localhost:5173 pnpm e2e   # the default; set for another port
pnpm exec playwright show-report e2e/playwright-report
```

First time only: `pnpm exec playwright install chromium`.

Output goes to `e2e/test-results/` and `e2e/playwright-report/` (both
git-ignored). A failed step keeps a screenshot; a retried run keeps a trace.

## Fixtures (`fixtures/`)

- `marlow-lighthouse.pdf` — a 3-page text PDF built with
  `backend/scripts/pdf-fixture-builder.ts` (9 blocks, 3 passages through the real
  extractor). The upload route titles it `marlow-lighthouse`.
- `article.html` — the web-article source, served by `fixture-server.ts`, an
  `http` server the spec starts in `beforeAll`. It can be switched to answer 500
  for the failure-recovery step (the worker treats 5xx as transient, exhausts its
  three attempts, and marks the source failed; Retry then succeeds).
- `manual-text.ts` — the pasted-text source, the hand-written note that gets
  converted, and the four questions. All facts are fictional and disjoint, so a
  scoped question has one source that can answer it.

### The web-source steps and the SSRF guard

The ingestion worker's SSRF guard (`backend/src/ingest/url-guard.ts`) refuses
loopback, RFC 1918, link-local, and unique-local addresses — correctly, per
PRD §17 — so a fixture server on `127.0.0.1` or a `192.168.x.x` LAN address is
rejected before it is ever fetched ("points to a private network"). The worker
can only reach the fixture server through an address the guard accepts:

- set `E2E_FIXTURE_HOST` to a public hostname or IP that resolves to this machine
  (a DNS record, or a tunnel forwarding to `E2E_FIXTURE_PORT`), or
- have a global IPv6 address on the machine; `fixture-server.ts` picks it up.

With neither, steps 4 and 6 are **skipped with that reason** in the report, not
passed. The clean fix is a backend one — a dev-only allowlist in the guard,
which is outside this folder's scope and recorded as an open item.

## Reading the spec

Each `test('NN …')` is one §21 bullet, in the PRD's order. Ingestion is waited on
by polling `GET /api/spaces/:id/sources` through the page's own session (so the
test asks the same backend the UI does) and then asserting the UI after a
reload. Assistant steps assert shape only: an answer rendered, ≥ 1 citation
marker whose click lands on a `[data-cited="true"]` block in the reader, and the
insufficient-evidence footer on the off-topic question — never wording. The
viewport is 1200 px so a citation navigates to the reader route rather than the
side pane. "Leave and return" is `page.reload()` on every area. Export asserts the
download event, a `*-notebook.md` filename, and the file's contents; the print
route is asserted to render and to call `window.print()` (stubbed).
