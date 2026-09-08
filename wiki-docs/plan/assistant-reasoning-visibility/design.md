---
title: Assistant reasoning visibility — design
kind: plan
status: done
created: 2026-08-15
updated: 2026-08-15
tags: [assistant, providers, streaming, latency, reasoning, ai-sdk]
---

# Design: Assistant reasoning visibility

Decisions, each with the alternative it rejects. The port
(`backend/src/lib/answer-provider.ts`) already has a `thinking` event and the
route already forwards it (`routes/conversations.ts:607`); almost everything
here is about the one adapter that never emitted one, and the one screen that
never labelled it.

## What the SDK already does (verified, not assumed)

Read out of `backend/node_modules/` on 2026-08-15, because two of the
decisions below turn on it:

- `@ai-sdk/openai-compatible` maps both `delta.reasoning_content` and
  `delta.reasoning` to `reasoning-start` / `reasoning-delta` stream parts
  (`dist/index.js:812-822`). The channel we are discarding is already
  normalised for us — no vendor-specific parsing is needed.
- It sends `reasoning_effort` in the request body from
  `providerOptions.<providerOptionsName>.reasoningEffort`
  (`dist/index.js:349`, `:578`), where `providerOptionsName` is the `name`
  passed to `createOpenAICompatible` — `'answers'` here, already the key the
  routing guard nests under.
- In `ai@7`, **`fullStream` and `elementStream` each take an independent tee**
  of the same base stream (`dist/index.js:10209` `teeStream()`, `:10228`
  `fullStream`, `:10282` `elementStream`). Consuming both is supported by
  construction, with the buffering caveat the SDK states in that comment.

## Reasoning is read from `fullStream`, merged with `elementStream`

`elementStream` yields validated array elements and nothing else — reasoning
parts do not survive it. So the adapter consumes both tees and merges them
into its one `AsyncIterable<AnswerEvent>`.

**Rejected: consume `fullStream` alone and parse the array by hand.** It would
mean re-implementing what `Output.array()`'s transform already does — including
the coercion that REQ-201 exists to protect ("a citation index outside the range
sent MUST cost only the citation, never the sentence carrying it"). That scanner
was written once, in the first version of this adapter, and
[[../assistant-provider-tiers/design]] records why it was deleted. Bringing it
back to reach a reasoning channel that the SDK already normalises would trade a
verified rule for a hand-rolled one.

**Cost accepted:** the tee buffers for whichever reader is slower, so both must
be drained concurrently — a merge that drains one and then the other would
deadlock on a long answer. The merge helper is therefore a genuine concurrent
race, not a sequential drain, and that is the part to get right.

**Ordering.** The merge yields whichever iterator produces first; it does not
impose an order between reasoning and text. On the measured endpoint reasoning
strictly precedes content, but that is a property of one model, not of the
protocol, and interleaved output must not corrupt either channel. `answers.ts`
already keeps them apart: `thinking` is yielded and never accumulated into
`text` (`lib/answers.ts:154-156` vs `:158-161`), which is what makes
acceptance criterion 6 hold without a second guard.

## `thinking` becomes `'adaptive'`, and the salvage paths stay silent

`capabilities.thinking` moves from `'none'` to `'adaptive'` on this provider.
The taxonomy's whole purpose is that the record and the behaviour agree; an
adapter that emits `thinking` while declaring `none` is the same quiet lie as
one that declares a citation tier it does not deliver, just pointing the other
way.

`'adaptive'` rather than a new `'passthrough'` value: the depth genuinely varies
with `reasoning_effort` and with the model behind the endpoint, which is what
`adaptive` already means for the native tier.

A model that emits no reasoning yields no `thinking` events, so the declaration
is a statement about the channel, not a promise that every answer uses it. The
UI keys off events received, never off `capabilities` — which is what makes
acceptance criterion 5 fall out for free.

The prose-salvage and JSON-salvage branches (`openai-provider.ts:280-312`) are
untouched. They run after the stream is exhausted, and reasoning is not answer
text: a response that produced only reasoning and no content is still a failure,
and salvaging reasoning into the answer would be exactly the attribution-by-
guesswork that REQ-199 refuses.

## `ANSWER_EFFORT` is passed through, not validated

The configured value goes into `providerOptions.answers.reasoningEffort`
verbatim, beside the existing `provider.require_parameters` guard.

**Rejected: validating it against `capabilities.effortLevels`.** There is no
list to validate against. OpenAI spells the levels `low|medium|high` (plus
`minimal`), other endpoints accept `none`, and some take a thinking-token
budget instead. A hard-coded allow-list would reject a value that the
operator's endpoint accepts, on the strength of a vendor's vocabulary we do
not know we are talking to.

**Cost accepted, and it is a real one:** a typo in `ANSWER_EFFORT` is now the
endpoint's problem, not ours, and may surface as an opaque 400. That is worse
for a mistyped value and better for a correct-but-unfamiliar one, and only the
second kind is silent today.

`effortLevels` therefore stays `[]` on this provider, and gains a comment
saying that empty means **"not enumerable, passed through"** rather than
**"not supported"**. That overload is a wart. It is left as a wart rather than
widened into a third state, because one provider's unknown vocabulary is not
enough evidence to reshape a port — noted in [[proposal]]'s open questions so
the next provider decides it with two data points instead of one.

## `ANSWER_TIMEOUT_MS` bounds this tier too

The native tier passes it to the Anthropic client's own `timeout`
(`anthropic-provider.ts:90`). There is no equivalent client option here, so the
abort signal already threaded through `answer()` gets a timer: the adapter races
the caller's signal against a deadline and aborts on either.

Composed rather than replaced — the caller's signal is how a closed tab stops
paying for tokens (`routes/conversations.ts:513`), and that must keep working.
A timeout fires as an ordinary `AnswerProviderError`, which the route already
turns into the §16 failure with Retry, so no new error path appears.

## The UI: a labelled "Thinking…", with the reasoning clamped

Today `assistant-pane.tsx:147-149` renders `pending.thinking` as bare italic
text, falling back to "Searching your sources…". With 337 reasoning chunks that
paragraph grows without bound, pushes the composer off screen, and — worse —
reads as though it were the answer, because nothing on screen says it is not.

The replacement is one block with two parts: a persistent **"Thinking…"** label
with a motion cue, and beneath it the *tail* of the reasoning, clamped to about
three lines and following the newest text. Decided with the operator on
2026-08-15.

**Rejected: a bare "Thinking…" with no reasoning at all.** It is honest but
tells the user nothing about whether the model is making progress on *their*
question, and a 20-second wait with a static label reads as a hang.

**Rejected: a `<details>` disclosure, default-closed.** Cleanest visually, but
it hides the progress signal §19 asks for behind a click, and adds disclosure
state plus its a11y contract for content that is transient by construction —
it disappears the moment the first answer segment arrives.

Two things the block must be, because the failure mode is mistaking it for the
answer:

- **Visually subordinate** — the answer renders through `AnswerMessage`; this is
  a status affordance in `on-surface-variant`, and must not acquire the answer's
  card, its citations, or its actions.
- **Transient** — it is replaced by the answer the moment `pending.text` is
  non-empty, which is already how the branch at `assistant-pane.tsx:123` works.
  Nothing about it is persisted, so a reload shows the answer and no trace of
  the reasoning.

"Searching your sources…" keeps its place as the pre-first-event state. The
three states the pane now distinguishes are **searching** (nothing received
yet, which is also retrieval), **thinking** (reasoning received, no text), and
**answering** (text received) — and that ordering is exactly what the measured
1.2 s / 21.6 s split makes visible.

## The live region announces a state, never the reasoning

REQ-187 already forbids re-announcing streamed text; reasoning is the same
hazard an order of magnitude worse — 337 mutations of an `aria-live` region for
one question. So the region gains "Thinking" as a third announced *state*
(`assistant-pane.tsx:70-80`), and the reasoning text itself is excluded from
it. The visible tail is presentation; the announcement is status.

## What is deliberately not changed

- **Segment-level answer streaming.** Out of scope in [[proposal]], restated
  here because it is the obvious next thing to reach for once reasoning is
  visible: the enum over document indexes is the grounding guarantee, and
  token-level text on this tier means giving it up.
- **The route.** It already forwards `thinking` and already stamps
  `firstTokenAt` on the first `thinking` *or* `delta`
  (`routes/conversations.ts:607-612`) — which means the §19 first-token metric
  becomes truthful as a side effect of this change, having previously measured
  the first *answer* token on a reasoning model.
- **`answers.ts`.** It keeps reasoning out of `text` already. The only edit it
  might have wanted — a guard against a future adapter accumulating thinking
  into the answer — is a test, not code.
