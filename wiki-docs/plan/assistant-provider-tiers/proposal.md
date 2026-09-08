---
title: Assistant provider tiers — native and structured
kind: plan
status: done
created: 2026-08-13
updated: 2026-08-13
tags: [assistant, providers, citations, openrouter, ollama]
---

# Proposal: Assistant provider tiers — keep `native`, add `structured`

## Problem

Phase 4 shipped one adapter and said so deliberately: "a port with one
implementation is a guess, and only a second real provider turns it into a
contract" ([[../phase-4-assistant/design]] "The provider is a port, not an
SDK wrapper"). The `capabilities` record and the three-tier taxonomy were
written from provider documentation, and nothing has exercised them.

Two things changed. The operator wants to run the assistant through
OpenRouter, and OpenRouter turns out to have **two** faces:

- an **Anthropic Skin** at `https://openrouter.ai/api` that "behaves
  exactly like the Anthropic API" and passes advanced features through —
  so tier `native` reaches it with a base URL and nothing else;
- an **OpenAI-compatible** `/api/v1/chat/completions`, which is the only
  way to reach a non-Claude model, and which has no citation channel at
  all.

So the second implementation now has a caller, and the tier taxonomy has
to survive contact with one. The risk this closes is specific: a
provider swap that silently downgrades grounding from structural to
conventional while the UI keeps rendering `[1]` exactly as before.

## Goal

One deployment can answer through Claude's native Citations, or through
any OpenAI-compatible endpoint, and **an answer always records which of
those produced it.**

```
ANSWER_PROVIDER=anthropic            ANSWER_PROVIDER=openai-compatible
ANSWER_BASE_URL=…/api  (Skin)        ANSWER_BASE_URL=…/api/v1  (OpenRouter)
        │                                    │  …or Ollama, vLLM, LM Studio
        ▼                                    ▼
  citations: 'native'                  citations: 'structured'
  quote:     'extracted'               quote:     'generated' → substring-verified
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
        documentIndex → Passage, out-of-range dropped,
        locator copied from the row   ← unchanged, outside both adapters
                       ▼
        scopeSnapshot.citationMode + .model (as *served*, not as asked)
```

## Scope

1. **Provider-agnostic answer configuration** — `ANSWER_PROVIDER`,
   `ANSWER_BASE_URL`, `ANSWER_API_KEY`, with `ANTHROPIC_API_KEY` accepted
   as a deprecated alias so an existing `.env` keeps working.
2. **`native` reaches a base URL** — the existing adapter takes
   `baseURL`, which is all the Anthropic Skin needs.
3. **A `structured` adapter** for any OpenAI-compatible endpoint: passages
   sent as labelled excerpts, the answer constrained to a JSON schema
   whose citation field is an **enum of the document indexes actually
   sent**, streamed.
4. **The served model is recorded, not the requested one** — a router does
   model mapping and provider failover, so `scopeSnapshot.model` must name
   what answered.
5. **The tier is visible in the data** — `scopeSnapshot.citationMode`
   already exists; this is the change that makes it carry more than one
   value.

## Out of scope

- **A `marker` adapter.** No caller needs it: OpenRouter's chat completions
  and Ollama both support a JSON schema, which is strictly stronger.
- **A user-facing model or effort selector.** Still a separate feature
  that would widen §5's closed list of runtime limits
  ([[../phase-4-assistant/design]] "Configuration and secrets").
- **A separate provider for conversation titles.** `TITLE_MODEL` stays on
  the answer provider's endpoint. Pointing titles at a different host is a
  smaller change that can follow.
- **Embeddings.** Frozen by `vector(768)` with no backfill; changing that
  model means a migration and a full re-embed, and "switch answer
  providers" never includes it.
- **Provider-side retrieval** (`file_search` and its kind) — still
  rejected, and for the same reason: it takes `retrievableSources()` out
  of our hands.
- **Token-level streaming on the `structured` tier.** Segment-level is
  what this ships; see [[design]] for the cost and the revisit.

## Acceptance criteria

- With `ANSWER_PROVIDER=anthropic` and no base URL, behaviour is
  byte-identical to Phase 4: every assistant test still passes unchanged.
- With a base URL set, the `native` adapter talks to it and citations still
  resolve to passages.
- With `ANSWER_PROVIDER=openai-compatible`, a question is answered,
  citations resolve to real passages, and an index outside the set sent is
  dropped and counted — the same rule, enforced in the same place.
- A `structured` answer's quote is either found in its passage or stored
  empty; it is never shown unverified.
- `scopeSnapshot.citationMode` reads `structured` for those answers and
  `native` for the others, and `scopeSnapshot.model` names the model that
  actually served the request.
- A server that ignores the JSON schema and answers prose produces **zero
  citations and an ungrounded answer** — never a citation attributed by
  guesswork.
- The server refuses to boot with no key, whichever provider is selected,
  and the message names the variable to set.

## Cross-references

- [[design]] — the schema, the streaming decision, and what the two tiers
  do and do not guarantee.
- [[tasks]] — work breakdown.
- [[../phase-4-assistant/design]] — the port, the tier taxonomy, and the
  "one adapter ships" decision this reverses.
- [[../../specs/assistant/spec]] — REQ-154–157 (the citation rules both
  tiers obey), REQ-171 (the snapshot), REQ-195 (the port).
- PRD §9 (assistant), §17 (secrets), §19 (performance).
