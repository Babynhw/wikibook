---
title: Assistant provider tiers — Design
kind: plan
status: done
created: 2026-08-13
updated: 2026-08-13
tags: [assistant, providers, design, structured-outputs, streaming]
---

# Design: Assistant provider tiers

Nothing about the citation rules changes. `documentIndex → Passage`, the
drop-and-count, and the locator copied from the row stay exactly where
Phase 4 put them — outside every adapter. This design is only about what
an adapter has to do to *produce* a `documentIndex`, and about the two
places a router makes the existing code tell a small lie.

## Decisions

### A provider is usable when it has what it needs (decided 2026-08-13)

```
ANSWER_PROVIDER=anthropic | openai-compatible     (default anthropic)
ANSWER_BASE_URL=                                  optional
ANSWER_API_KEY=                                   ANTHROPIC_API_KEY is a deprecated alias
```

The boot gate stops asking for one named variable and asks whether the
selected provider is *usable*:

| Provider | Usable when |
|---|---|
| `anthropic` | a key is set — the hosted API and the Anthropic Skin both authenticate |
| `openai-compatible` | a base URL is set; **a key is optional** |

The optional key is not laziness: a local Ollama, vLLM, or LM Studio has no
auth at all, and requiring a placeholder would be a lie the operator has to
maintain. A hosted OpenAI-compatible endpoint that needs a key and does not
get one fails on the first question with a §16 message, which is the same
path any provider outage takes.

`ANTHROPIC_API_KEY` keeps working as an alias so an existing `.env` does
not break on a pull. It is documented as deprecated, not silently
supported.

### `native` reaches the Anthropic Skin by base URL alone (decided 2026-08-13)

OpenRouter's Anthropic Skin "behaves exactly like the Anthropic API" and
passes advanced features through, so the existing adapter needs one
constructor argument and no other change. That is the whole reason to keep
`native` rather than move everything to `structured`: citations stay
structural, `citations_delta` keeps streaming token-by-token, and §19's
budget is unaffected.

> [!warning] Unverified, and it fails quietly
> Citations passthrough is **not documented** on the Skin — the endpoint's
> API-reference page 404s, and the integration guide names thinking blocks
> and tool use but not citations. If citations do not survive the proxy,
> every answer comes back with zero of them, which this system reports as
> an *ungrounded* answer (REQ-160) — indistinguishable on screen from
> "the evidence does not cover this". Verify with one request carrying a
> `document` block before trusting a deployment, and treat a run of
> all-ungrounded answers as this failure until proved otherwise.

### The citation field is an enum of indexes, not of passage ids (decided 2026-08-13)

The `structured` adapter constrains the answer to:

```jsonc
{ "segments": [ {
    "text":  "Participants described withdrawal as socially costly",
    "cite":  0,          // enum: 0 … n-1, or null for an uncited segment
    "quote": "socially costly"   // or null
} ] }
```

`cite` is an **index into the documents this request sent**, because that
is the only thing an adapter is given. The port deliberately never hands an
adapter a `passageId` ([[../phase-4-assistant/design]] "The provider is a
port, not an SDK wrapper"), so keeping the enum as indexes means
`answers.ts` resolves both tiers with *literally the same code* — the drop
rule, the locator copy, and the quote verification are not re-implemented
per tier, they are simply reached by a different route.

Under a strict schema an unknown index cannot be generated at all. The drop
rule still runs: a server that ignores the schema is not bound by the enum,
and that case is exactly what the rule exists for.

`quote` is requested and `capabilities.quote` is `'generated'`, so
REQ-157's substring check runs in production rather than only in a test. A
small model that paraphrases loses its quote and keeps its citation, which
is the correct trade — an unverifiable quote presented as the source's
words is fabricated evidence.

### Streaming is per segment, not per token (decided 2026-08-13)

A structured answer arrives as JSON being generated, so there is no token
to render until a string closes. The adapter scans the accumulating buffer
and, each time a segment object completes, emits that segment's text as a
`delta` and its `cite` as a `citation`.

The cost, stated: **text appears a sentence at a time.** First visible
content is the first completed segment rather than the first token, and
there is no thinking summary to show before it, because
`capabilities.thinking` is `'none'` on this tier. For §19's "begins
displaying within 8 s" a sentence is still content, and on a local model a
first sentence lands in about a second.

Rejected for now: extracting the partial text of the *open* segment by
tracking JSON string state, which would restore token-level streaming for
~20 more lines of fiddly escape handling. Worth doing if the first-segment
latency measures badly; not worth the risk before it has been measured.

The scanner is a **pure function over the buffer** — brace matching that
respects string state and escapes — so it is unit-testable without a
server, which is most of why it is written this way rather than as a
streaming JSON parser dependency.

> [!warning] Reversed 2026-08-13 — the AI SDK does exactly this
> The hand-written scanner is replaced by the AI SDK's
> `Output.array()` + `elementStream`, whose documented behaviour is to
> "receive each fully completed and validated element as it is generated"
> — the same contract, plus per-element schema validation the scanner did
> not have. `segments.ts` and its twelve tests are deleted, along with the
> SSE line reader and the finish-reason mapping in the adapter.
>
> The dependency argument above was wrong in one direction and right in
> another. Wrong: a *general* streaming-JSON parser would have been the
> wrong tool, but this is not one — it is a provider abstraction whose
> array-streaming primitive happens to be exactly the required shape.
> Right: the risk of putting a normalizing layer underneath is real, which
> is why it is taken **only on this tier** (below).
>
> What is accepted with it: a fast-moving dependency, and one behavioural
> subtlety worth stating in its own right (see "Validation must not eat
> answer text").

### The `native` tier deliberately does *not* move to the AI SDK (decided 2026-08-13)

`@ai-sdk/anthropic` does expose citations, but its support is recent and
partial: the parsing that landed covers **search-result blocks and
custom-content documents** (`search_result_location`,
`content_block_location`), and this adapter sends **plain-text documents**,
whose citations are `char_location` — which no source found confirms is
parsed. There are also open reports of citations being *stripped* from a
response, and of empty citations on Bedrock.

The deeper reason is structural, not a bug count: **a normalizing SDK
exists to flatten provider differences**, and that is precisely the wrong
property for the one provider-specific feature this product's guarantee
rests on. If `document_index` does not survive the abstraction, the
`native` tier degrades to guesswork — and it degrades *silently*, as
uniformly ungrounded answers.

If it is ever worth moving, the route is to send each passage as a
**custom-content document** with a single content block, so the citation
arrives as a block index rather than a character offset. That is a change
to the request shape and needs verifying against a live call first.

### Validation must not eat answer text (decided 2026-08-13)

`elementStream` yields only elements that **validate**, which introduces a
failure mode the hand-written scanner did not have: a strict `cite` enum
would reject a segment whose index is out of range, and the whole
element — **including its text** — would silently vanish from the answer.
That is strictly worse than the behaviour it replaces, where the text
survived and only the citation was dropped.

So the element schema keeps the enum (it is what guides constrained
decoding) but **coerces an invalid `cite` to "uncited" rather than failing
the element**. Text is never lost, and REQ-155's drop rule stays the single
place that decides whether an index is real — which is the same reason the
adapter reports an index instead of resolving one.

### The SDK downgrades the schema unless told the endpoint supports it (found 2026-08-13)

`@ai-sdk/openai-compatible` sends `response_format: {type: 'json_object'}`
and **drops the schema entirely** unless the provider is constructed with
`supportsStructuredOutputs: true`. It logs a warning rather than failing, so
the `cite` enum would silently never reach the model and constrained
decoding would be lost — leaving only the drop rule between a bad index and
a persisted citation.

Found by inspecting the request body, not from the documentation. With the
flag set, `cite` serialises as `anyOf: [{const: 0}, {const: 1}, {type:
'null'}]`, which is the enum by another spelling. The test asserts the
*content* of the schema rather than its path, so it catches the downgrade
whatever shape a future SDK version emits.

### A server that ignores the schema produces prose and zero citations (decided 2026-08-13)

Not every OpenAI-compatible endpoint honours `response_format`. The adapter
decides mode from the first non-whitespace character: `{` means JSON, and
anything else means the server answered prose, which is streamed as
ordinary deltas with **no citations at all**.

If the buffer opens with `{` and never parses, the buffer is emitted as one
delta at the end and still no citations. The answer is then ungrounded,
which is honest: the alternative is attributing a claim by guesswork, and
that is the one thing this whole design exists to prevent.

To keep a router from landing on such a provider in the first place, the
adapter sends OpenRouter's `provider: { require_parameters: true }` routing
guard by default, so the router only chooses providers that actually
support the requested `response_format`. `ANSWER_PROVIDER_ROUTING=false`
turns it off for a server that rejects unknown fields. The default is *on*
because a loud 400 is easier to diagnose than a silent downgrade to prose.

### The snapshot records the model that served, not the one requested (decided 2026-08-13)

A router does model mapping and provider failover, so
`env.ANSWER_MODEL` is what we *asked for* and can differ from what
answered. The port gains one event:

```ts
| { type: 'model'; id: string }
```

Both adapters emit it — Anthropic from `message_start`, OpenAI-compatible
from any chunk's `model` — and `runAnswer` carries it into the outcome as
`servedModel`. The route writes `scopeSnapshot.model = servedModel ??
requested`.

This is a correctness fix to Phase 4, not a new feature: without it
`scopeSnapshot` describes something other than the thing that produced the
answer, which is precisely what the snapshot exists to prevent
([[../../specs/assistant/spec]] REQ-171).

## Testing

- **The segment scanner** — deleted with the swap to `elementStream`; its
  twelve cases (chunk boundaries at every split point, unbalanced braces
  and escaped quotes inside `text`, a partial segment, a non-integer and an
  out-of-range `cite`, prose) become the SDK's contract rather than ours.
  What replaces them is a test that an out-of-range `cite` **keeps its
  segment's text** and loses only the citation, because that is the one
  behaviour the SDK's validation could take away.
- **The `structured` adapter** against a stubbed `fetch`: the request
  carries one labelled excerpt per passage and an enum of exactly the sent
  indexes; `require_parameters` present; deltas and citations emitted per
  segment; `model`, `usage`, and `stop` mapped.
- **Schema ignored** — a prose response yields deltas and **zero**
  citations; the stored answer is ungrounded.
- **The rules are not re-implemented** — an out-of-range `cite` from the
  structured adapter is dropped by the same test-covered path as the
  native one, and a paraphrased `quote` is stored empty.
- **Both tiers end-to-end through the route**, asserting
  `scopeSnapshot.citationMode` reads `native` / `structured` and
  `scopeSnapshot.model` names the served model, not the requested one.
- **Phase 4 unchanged** — with `ANSWER_PROVIDER` unset, every existing
  assistant test passes untouched. That is the regression gate for the
  config refactor.

## Cross-references

- [[proposal]] — scope and acceptance criteria.
- [[tasks]] — work breakdown.
- [[../phase-4-assistant/design]] — the port, the tiers, and the decision
  this reverses.
- [[../../specs/assistant/spec]] — REQ-154–157, REQ-171, REQ-195.
