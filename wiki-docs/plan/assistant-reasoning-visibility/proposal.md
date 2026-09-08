---
title: Assistant reasoning visibility — show the thinking, and shorten it
kind: plan
status: done
created: 2026-08-15
updated: 2026-08-15
tags: [assistant, providers, streaming, latency, reasoning, prd-19]
---

# Proposal: Assistant reasoning visibility

## Problem

An operator running the `structured` tier against a local reasoning model
reported the assistant as "slow, and not streaming at all". Both halves of
that report are true, and neither is a transport bug.

Measured 2026-08-15 against the configured endpoint (`ANSWER_BASE_URL=
http://localhost:20128/v1`, `ANSWER_MODEL=oc-go/qwen3.6-plus`), sending the
same `response_format` the adapter sends, for a one-sentence question:

| Signal | First chunk | Chunks |
|---|---|---|
| `delta.reasoning_content` | **1.2 s** | 337 |
| `delta.content` | **21.6 s** | 16 |
| total | 22.5 s | — |

The endpoint streams, and it starts streaming at 1.2 s. What it streams for
the first twenty seconds is reasoning, on the `reasoning_content` channel.

`backend/src/lib/openai-provider.ts` declares `thinking: 'none'` and consumes
only `result.elementStream`, so every one of those 337 chunks is discarded.
The user sees "Searching your sources…" for 20+ seconds on a question that
the model began working on immediately. A real question — with retrieved
excerpts in the prompt — is slower still.

This is the mirror image of the failure the tier taxonomy was built to catch.
[[../assistant-provider-tiers/proposal]] worried about a provider swap that
*downgrades* a guarantee while the UI keeps rendering as before; here an
adapter under-reports a capability the provider actually has, and the cost
lands on PRD §19, the one section that measures what the user sees rather
than what the system produces.

Two contributing findings from the same investigation:

- **`ANSWER_EFFORT=low` is never sent.** The adapter declares
  `effortLevels: []` and passes no `reasoning_effort`, so the model reasons at
  its default depth regardless of configuration. The knob exists in `.env`,
  in `config.ts`, and in the `scopeSnapshot` — and reaches nothing.
- **`ANSWER_TIMEOUT_MS` applies to one tier only.** It is honoured in
  `anthropic-provider.ts:90`; the OpenAI-compatible path has no timeout at
  all, so an endpoint that stalls stalls until the client gives up.

Everything else on the path was checked and is correct: the route's hijack and
`reply.raw.write` (`routes/conversations.ts:485-517`), the absence of any
compression middleware that would buffer SSE, and the client's chunk-boundary
reader (`frontend/src/features/assistant/sse.ts`). The plumbing was never the
problem, and this proposal changes none of it.

## Goal

**While the model is reasoning, the user can see that it is reasoning** — on
either tier, within a second or two of asking — and the reasoning itself is no
longer left at whatever depth the endpoint defaults to.

## Scope

- `openai-provider.ts` reads reasoning deltas and emits `thinking` events, and
  declares `thinking: 'adaptive'` to match.
- `ANSWER_EFFORT` reaches the OpenAI-compatible endpoint as `reasoning_effort`.
- `ANSWER_TIMEOUT_MS` bounds the OpenAI-compatible request, as it already
  bounds the native one.
- The assistant pane shows a labelled **"Thinking…"** state with a clamped tail
  of the reasoning, replacing today's unlabelled italic dump.
- The live region gains a `thinking` state, still announcing state and never
  reasoning text (REQ-187).

## Out of scope

- **Token-level streaming of answer text on the `structured` tier.** Text still
  arrives per completed segment. That is [[../assistant-provider-tiers/design]]'s
  accepted cost of constrained decoding over a citation-index enum, and REQ-200
  already states it. Changing it means giving up the enum, which is the whole
  grounding guarantee — a different proposal, if ever.
- **Persisting reasoning.** A stored answer keeps its text and citations; the
  reasoning is progress, not product. Nothing in `Message` grows.
- **Reasoning as evidence.** A `thinking` event is not answer text and is never
  citable — REQ-159's rule about answers applies with more force here.
- **The `native` tier's behaviour.** `anthropic-provider.ts` already maps
  `thinking_delta` (line ~158) and already honours the timeout. It is read for
  contrast and left alone.
- Retrieval latency, the ANN-index question, and anything else §19-adjacent
  that [[../phase-4-assistant/proposal]] already settled.

## Acceptance criteria

1. Asking through a reasoning model on the `structured` tier shows a
   **"Thinking…"** state within ~2 s of the request, not after the first
   answer segment.
2. The reasoning text shown is bounded on screen — a 337-chunk reasoning run
   does not push the composer off the viewport or become the page.
3. Setting `ANSWER_EFFORT` changes the request body: `reasoning_effort` carries
   the configured value, verified by inspecting the outgoing request.
4. `capabilities.thinking` reports `adaptive` for the OpenAI-compatible
   provider, so the capability record and the behaviour agree.
5. A model that emits no reasoning at all is unaffected: no "Thinking…" state
   appears and the answer streams exactly as before.
6. Reasoning never reaches the stored answer: the persisted `content` after a
   reasoning run contains answer text only.
7. The screen reader announces a state change, not reasoning tokens (REQ-187).
8. An OpenAI-compatible request that stalls is bounded by `ANSWER_TIMEOUT_MS`
   and surfaces as the ordinary assistant failure with Retry (REQ-188).

## Cross-references

- [[design]] · [[tasks]]
- [[../../specs/assistant/spec]] — REQ-187 (live region), REQ-195/196
  (the port and its capability record), REQ-200/201 (segment streaming and the
  rule that validation must not eat text). New requirements append at REQ-226
  after implementation.
- [[../assistant-provider-tiers/proposal]] — the tier taxonomy this corrects an
  under-report in.
- [[../phase-4-assistant/proposal]] — where §19 and the `thinking` event were
  introduced; its "thinking stays on at `low` effort as a §19 latency decision"
  is the decision the missing `reasoning_effort` had quietly voided.
- PRD §19 (performance: what the user sees), §18 (accessibility), §9 (answers).

## Open questions

- **What vocabulary does `reasoning_effort` take on an arbitrary
  OpenAI-compatible endpoint?** `low|medium|high` is the OpenAI spelling;
  others accept `minimal`, `none`, or a token budget. See [[design]] for why
  the value is passed through unvalidated and what that costs.
