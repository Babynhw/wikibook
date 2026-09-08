---
title: HuggingFace embeddings — Design
kind: plan
status: in-progress
created: 2026-09-07
updated: 2026-09-07
tags: [embeddings, huggingface, design]
---

# Design: HuggingFace embeddings

## The transport

One endpoint, for both sides of the retrieval pair:

```
POST {HF_BASE_URL}/models/{EMBEDDING_MODEL}/pipeline/feature-extraction
authorization: Bearer {HF_API_KEY}
x-wait-for-model: true
{ "inputs": ["query: …"] }        →  [[0.01, …768 floats…]]
```

Two details are load-bearing:

- **`HF_BASE_URL` keeps its provider segment.** The default is
  `https://router.huggingface.co/hf-inference`, and a relative `URL` join
  against it would *replace* `/hf-inference` rather than append to it. The
  client appends a trailing slash before joining, and a test asserts the
  resulting URL string rather than trusting the join.
- **The body is a bare `number[][]`,** not an envelope. Ollama returned
  `{ embeddings: [...] }`; nothing here has a key to read, so a
  non-array body is itself the error case — and HuggingFace does sometimes
  answer `200` with `{ error: "…" }`, which is why the array check comes
  before the length check.

`x-wait-for-model: true` makes the router block while a cold model is
placed instead of returning 503 with an `estimated_time` we would only
sleep on ourselves.

## Failure taxonomy

`EmbeddingError.code` decides process lifetime and job retries, so each
code is chosen for what the *caller* must do, not for what went wrong:

| code | when | `index.ts` | `persist.ts` |
|---|---|---|---|
| `unauthorized` | 401/403 | exits | unretryable — fails the source |
| `dimension_mismatch` | wrong width, or token-level rows | exits | unretryable |
| `bad_response` | 4xx, non-JSON, wrong row count | warns | retried by BullMQ |
| `unreachable` | network error, aborted body | warns | retried by BullMQ |

`unauthorized` is new and joins `dimension_mismatch` on the fatal side for
the same reason: a rejected token rejects identically forever, so retrying
it three times per job and marking every source `failed` in turn is pure
noise. The server refuses to boot instead, the way it already refuses
without an answer provider.

`EmbeddingError` also carries a `retryable` flag, set by the transport for
429 and 5xx. It is a property of the occasion rather than of the code: a
`bad_response` from a 400 is settled, one from a 503 is not.

### The two shape errors worth naming

- **404** is the likeliest way a model swap fails, because most Hub models
  have no serverless provider. Its message says so and names the model,
  rather than reading like an outage.
- **Token-level embeddings** — a model served without sentence-pooling
  answers one vector *per token*, which arrives as a well-formed 3-D array.
  Without an explicit check the first row's length is a token count that
  could coincidentally be 768, so this is classified as
  `dimension_mismatch` and explained.

## Retries

Three attempts per `embed()` call, 500 ms then 1 000 ms, only for
`retryable` errors. This sits *inside* BullMQ's own three attempts
deliberately: the shared fleet's 429 clears in under a second, and a job
that gives up and comes back a minute later has already published a
`processing → failed` transition the user saw.

## Task prefixes

`embed(inputs, task)` — `task` is required, not defaulted. Asymmetric
models (e5, bge, nomic) are trained with a prefix on each side, and a
passage embedded as a query scores measurably worse while looking
completely correct: the vector still has 768 dimensions. Making the
argument required means a new call site has to answer the question.

The prefix *strings* are configuration (`EMBEDDING_QUERY_PREFIX`,
`EMBEDDING_PASSAGE_PREFIX`) because they belong to the model, not to us:
bge words its differently and a symmetric model wants neither. Blank is
honoured rather than normalised away — "no prefix" is a real setting. In
`.env` they are quoted, because dotenv strips trailing whitespace from an
unquoted value and the trailing space is part of the prefix.

Changing a prefix invalidates every stored vector exactly as a model swap
does. Both are documented next to each other for that reason.

## Cosine, so normalisation does not matter

Retrieval orders by pgvector's `<=>`. e5 expects cosine similarity and
HuggingFace's pipeline may or may not L2-normalise; `<=>` is invariant to
magnitude either way, so no normalisation step is needed on our side. This
would not hold for `<#>` (inner product).

## `/health` must not spend quota

The old probe listed Ollama's pulled models — free, local. The obvious
translation, embedding a short string, is not: `/health` is
unauthenticated *and* exempt from the rate limiter, so anyone on the
internet could drain the account's inference credits by curling it in a
loop.

The probe calls the Hub's `/api/whoami-v2` with the token instead. It is
free, and it proves the two things that actually break in practice — the
service is reachable and `HF_API_KEY` is still valid. A model that has lost
its serverless provider is *not* covered; that surfaces on the first real
call as the 404 described above. The response field is renamed `ollama` →
`embeddings`, which the frontend's `HealthResponse` follows.

## Re-embedding

`Passage.embedding` stays `vector(768)`, so there is no migration — but
every stored vector came from a different model and is now noise. The
existing `pnpm reprocess:sources --all` re-runs ingestion for every `ready`
source, which re-chunks and re-embeds; no new script is needed. Until it
runs, retrieval returns confident nonsense rather than an error, which is
the one failure mode in this change with no automatic signal.

## Cross-references

- [[proposal]] — why the model changed as well as the provider.
- [[tasks]]
- [[../../specs/ingestion/spec]]
