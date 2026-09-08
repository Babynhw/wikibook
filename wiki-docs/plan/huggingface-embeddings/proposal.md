---
title: HuggingFace embeddings — replace the local Ollama client
kind: plan
status: in-progress
created: 2026-09-07
updated: 2026-09-07
tags: [embeddings, ingestion, retrieval, huggingface, providers]
---

# Proposal: embeddings move from a local Ollama to HuggingFace

## Problem

Since Phase 0 the embedding client has talked to an Ollama running
natively on the operator's host ([[../phase-0-foundation/design]]), and
`README.md` lists Ollama as a prerequisite alongside Node and Docker. That
made every developer machine and every deployment carry a model server
whose only job is to turn 1 200-character chunks into 768 floats — the one
dependency that cannot be brought up with `docker compose up -d`.

The operator asked to reach the same class of model through HuggingFace
instead, so that nothing but Postgres, Redis and MinIO has to run locally.

## The constraint that shapes the answer

`nomic-embed-text` **cannot** simply be pointed at HuggingFace. The Hub
serves the weights, but `nomic-ai/nomic-embed-text-v1.5` has no serverless
inference provider at all — its `inferenceProviderMapping` is empty, and a
call to the router's feature-extraction pipeline for it returns 404. Most
of the Hub is in that position; being on the Hub and being *served* are
different things.

So "use HuggingFace" forces a second decision: either keep the model and
pay for a dedicated Inference Endpoint (or self-host TEI — which is the
local model server again, wearing a different name), or keep the
serverless API and change the model.

## Decision

Serverless, and change the model to **`intfloat/multilingual-e5-base`**:

- **768 dimensions**, so `Passage.embedding` stays `vector(768)` and no
  migration is needed — the cheapest possible swap on the data layer.
- **Multilingual**, which `nomic-embed-text` is not. Sources and questions
  in this workspace are not reliably English, and the previous model was
  answering non-English queries out of an English-trained space.
- **Live on `hf-inference`**, verified against the Hub API rather than
  assumed.

The trade is a 512-token input window against nomic's 8 192. Chunks are
`CHUNK_TARGET_CHARS = 1_200`, which fits for English and sits near the
edge for Vietnamese; the model truncates rather than fails, so the failure
mode is a long chunk losing its tail, not an error. Revisit the chunk
target if retrieval quality drops on non-English sources.

## Goal

One deployment embeds through HuggingFace with a token and nothing else
installed, and every input carries the task prefix its model was trained
with.

```
ingest:    passage: <chunk>  ─┐
                              ├─► POST {HF_BASE_URL}/models/{model}/pipeline/feature-extraction
retrieval: query:   <question>┘         │  Bearer HF_API_KEY, x-wait-for-model
                                        ▼
                              number[][] — one row per input, 768 wide
                                        │
                    dimension checked ──┴── token-level shape rejected
                                        ▼
                              pgvector `<=>` (cosine — normalisation-independent)
```

## Scope

1. **Configuration** — `HF_API_KEY`, `HF_BASE_URL`, `HF_HUB_URL`,
   `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_PASSAGE_PREFIX`;
   `OLLAMA_BASE_URL` is deleted, not deprecated.
2. **Transport** — `src/lib/embeddings.ts` speaks the feature-extraction
   pipeline instead of Ollama's `/api/embed`, with a bounded retry for the
   shared fleet's 429/5xx.
3. **Task prefixes** — `embed()` takes a required `EmbeddingTask`, so a
   new call site has to declare which side of the pair it is on.
4. **Boot and health gates** — a missing or rejected token stops the
   server; `/health`'s `ollama` probe becomes `embeddings` and validates
   the token without spending inference quota.
5. **Re-embed** — every stored vector is invalidated by the model change.

## Non-goals

- No multi-provider abstraction. The answer providers earned a port
  because two of them ship; there is exactly one embedding backend, and
  `HF_BASE_URL` already covers a dedicated Endpoint or a self-hosted TEI,
  which speak the same request shape.
- No change to chunking, retrieval SQL, or the HNSW decision.
- No new `AppConfig` key: this is infrastructure, not a §5 product limit.

## Cross-references

- [[design]] — the transport, the failure taxonomy, and why the token is
  a boot gate.
- [[tasks]]
- [[../../specs/ingestion/spec]] — embedding is the last stage before
  `ready`; its verification record predates this change.
- [[../../specs/assistant/spec]] — retrieval embeds the question.
- [[../phase-0-foundation/design]] — where the Ollama client came from.
