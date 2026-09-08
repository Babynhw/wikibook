---
title: HuggingFace embeddings — Tasks
kind: plan
status: in-progress
created: 2026-09-07
updated: 2026-09-07
tags: [embeddings, huggingface, tasks]
---

# Tasks: HuggingFace embeddings

Configuration first, then the transport, then the gates: the config change
is the only step that can break Phase 2 and Phase 4, so it lands with the
existing suite as its gate.

## Backend

### P1 — Configuration

- [x] `HF_API_KEY` (optional in the schema, gated at boot — the same shape
      as `ANSWER_API_KEY`, so `buildApp()` still works in tests)
- [x] `HF_BASE_URL` (default `https://router.huggingface.co/hf-inference`)
      and `HF_HUB_URL` (default `https://huggingface.co`)
- [x] `EMBEDDING_MODEL` default becomes `intfloat/multilingual-e5-base`
- [x] `EMBEDDING_QUERY_PREFIX` / `EMBEDDING_PASSAGE_PREFIX`, blank honoured
- [x] `OLLAMA_BASE_URL` deleted from `config.ts`, `.env`, `.env.example`
- [x] `hasEmbeddingProvider` + `embeddingProviderHint` exported

### P2 — Transport

- [x] `embed()` posts to the feature-extraction pipeline and validates a
      bare `number[][]`
- [x] Trailing-slash join, so `/hf-inference` survives the URL construction
- [x] `x-wait-for-model: true` for cold starts
- [x] Bounded retry (3 attempts, 500 ms / 1 000 ms) on 429 and 5xx only,
      via `EmbeddingError.retryable`
- [x] `unauthorized` code for 401/403; 404 explained as "no serverless
      provider for this model"
- [x] Token-level (3-D) responses rejected as `dimension_mismatch`
- [x] `embed(inputs, task)` — `task` required; `persist.ts` passes
      `'passage'`, `retrieval.ts` passes `'query'`

### P3 — Gates

- [x] `index.ts` refuses to boot without `HF_API_KEY`, and exits on
      `unauthorized` as well as `dimension_mismatch`
- [x] `persist.ts` treats `unauthorized` as unretryable
- [x] `/health` probe renamed `ollama` → `embeddings`, using the Hub's
      `/api/whoami-v2` so it spends no inference quota

### P4 — Tests and tooling

- [x] `test/embeddings.test.ts` rewritten for the new shape: prefixes, URL,
      401, 404, 429-retry, budget exhaustion, 3-D rows, 200-with-error
- [x] `scripts/embed-smoke.ts` reports the endpoint alongside the model
- [x] `pnpm --filter backend test` green
- [ ] Verified against the live API with a real token — needs a credential
      this session did not have

## Frontend

- [x] `HealthResponse.ollama` → `embeddings` in `src/lib/api.ts`

## Docs

- [x] `README.md` — Ollama drops out of the prerequisites; the HF token
      takes its place, with the "must have a live serverless provider"
      caveat and the escape hatch (`HF_BASE_URL` → dedicated Endpoint or
      self-hosted TEI)
- [x] `backend/README.md`, `e2e/README.md`, `prisma/schema.prisma` comments
- [x] `.env.example` documents the prefix quoting and lists other served
      768-dim models

## Operator

- [ ] Create a token with *Make calls to Inference Providers* and set
      `HF_API_KEY` in `backend/.env`
- [ ] `pnpm --filter backend embed:smoke` — 768 dimensions from the router
- [ ] `pnpm --filter backend reprocess:sources --all` with the worker
      running: every stored vector is from the old model and is now noise.
      Until this runs, retrieval returns confident nonsense **without any
      error** — the one failure mode here with no automatic signal.
- [ ] Spot-check retrieval quality on a non-English source, and on a source
      with long chunks (e5's window is 512 tokens against nomic's 8 192)

## Cross-references

- [[proposal]], [[design]]
