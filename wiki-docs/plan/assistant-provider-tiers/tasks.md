---
title: Assistant provider tiers — Tasks
kind: plan
status: done
created: 2026-08-13
updated: 2026-08-13
tags: [assistant, providers, tasks]
---

# Tasks: Assistant provider tiers

Config first, then the port, then the adapter: the config refactor is the
only step that can break Phase 4, so it lands with the existing suite as
its gate before anything new is added.

## Backend

### P1 — Provider-agnostic configuration

- [x] `ANSWER_PROVIDER` (`anthropic` | `openai-compatible`, default
      `anthropic`), `ANSWER_BASE_URL`, `ANSWER_API_KEY`
- [x] `ANTHROPIC_API_KEY` accepted as a deprecated alias for
      `ANSWER_API_KEY`
- [x] `ANSWER_PROVIDER_ROUTING` (default `true`) — OpenRouter's
      `require_parameters` guard ([[design]] "A server that ignores the
      schema")
- [x] `hasAnswerProvider` becomes a per-provider usability check: a key for
      `anthropic`, a base URL for `openai-compatible` with the key optional
- [x] The boot gate names the variable to set for the selected provider
- [x] `.env.example` and `README.md` document both providers, the Skin base
      URL, and that a local endpoint needs no key
- [x] **Gate: the whole Phase 4 suite passes with nothing set** — the
      config refactor is behaviour-preserving by default

### P2 — The port carries the served model

- [x] `AnswerEvent` gains `{ type: 'model'; id: string }`
- [x] `runAnswer` records `servedModel` on the outcome
- [x] The ask route writes `scopeSnapshot.model = servedModel ?? requested`
- [x] The `native` adapter emits it from `message_start`

### P3 — `native` reaches a base URL

- [x] `createAnthropicProvider` takes an optional `baseURL` and passes it to
      the SDK — all the Anthropic Skin needs
- [x] A run of all-ungrounded answers is documented as the signature of
      citations not surviving a proxy ([[design]] callout)

### P4 — The segment scanner

- [x] A pure function over an accumulating buffer, returning completed
      segment objects and the new cursor
- [x] Brace matching that respects string state and backslash escapes, so a
      `{` or a `"` inside `text` cannot end a segment early

### P5 — The `structured` adapter

- [x] `POST {baseURL}/chat/completions`, `stream: true`, OpenAI shape
- [x] Passages sent as labelled excerpts, one per document, carrying the
      source title and locator label
- [x] `response_format: json_schema`, `strict: true`, `cite` an **enum of
      exactly the indexes sent** plus null ([[design]] "The citation field
      is an enum of indexes")
- [x] `provider: { require_parameters: true }` when
      `ANSWER_PROVIDER_ROUTING`
- [x] Per-segment `delta` + `citation` events; `model`, `usage`, `stop`
      mapped
- [x] `capabilities`: `citations: 'structured'`, `quote: 'generated'`,
      `thinking: 'none'`, no effort levels
- [x] Prose fallback: a response not opening with `{` streams as deltas with
      **zero** citations; a buffer that never parses is emitted once, still
      with none
- [x] A title is generated through the same endpoint

### P6 — Selection

- [x] `plugins/answers.ts` builds the provider named by config
- [x] No route, no `answers.ts` rule, and no client code changes — if any
      of them does, the port was the wrong shape

### P7 — Tests

- [x] `test/segments.test.ts` — the scanner's six cases from [[design]]
- [x] `test/openai-provider.test.ts` — request shape, enum contents,
      routing guard, per-segment events, mapped stop reasons
- [x] Schema ignored → prose deltas, zero citations, ungrounded answer
- [x] An out-of-range `cite` is dropped by the **existing** path; a
      paraphrased `quote` is stored empty
- [x] Route-level: `citationMode` and the served `model` in
      `scopeSnapshot`, for both tiers
- [x] Mutation checks: drop the enum from the schema; keep the requested
      model in the snapshot; treat a prose response as citable. Each must
      fail a named test, and is not done until reverted and green

### P8 — Swap the `structured` tier onto the AI SDK (2026-08-13)

Reverses [[design]] "Streaming is per segment" on its dependency point, and
is a **behaviour-preserving refactor**: the 175-test suite is the gate, and
it must pass without a test being rewritten to fit the new code.

- [x] `ai` + `@ai-sdk/openai-compatible` added
- [x] `openai-provider.ts` rebuilt on `streamText` +
      `Output.array({ element })` + `elementStream`
- [x] The element schema keeps the `cite` enum for constrained decoding but
      **coerces an invalid index to "uncited" instead of failing the
      element**, so validation can never delete answer text
      ([[design]] "Validation must not eat answer text")
- [x] `segments.ts` and `test/segments.test.ts` deleted
- [x] The SSE line reader, chunk parsing, and finish-reason mapping deleted
      in favour of the SDK's stream and finish reason
- [x] Served model still reported; `usage` still mapped; the prose fallback
      for a schema-ignoring server still produces **zero** citations
- [x] `ANSWER_PROVIDER_ROUTING` still reaches the endpoint (OpenRouter's
      `require_parameters`) through provider options
- [x] A new test: an out-of-range `cite` keeps its segment's text and drops
      only the citation
- [x] `native` is untouched — no AI SDK anywhere near it ([[design]] "The
      `native` tier deliberately does *not* move")

## Exit criteria

- [x] Every acceptance criterion in [[proposal]] is exercised by test where
      possible, by hand otherwise, and anything unverified is written down —
      except the two below, which need a live endpoint
- [x] Phase 4's suite passes unchanged with no new configuration
- [x] A `structured` answer's citations resolve to real passages through
      `GET /citations/:id/target`, the same assertion the `native` tier
      already passes
- [x] `scopeSnapshot` distinguishes the two tiers and names the served model
- [x] [[../../specs/assistant/spec]] amended: REQ-195 (the port now has two
      implementations), REQ-171 (served model), and new REQs for provider
      selection and the prose fallback
- [x] `index.md` updated, `log.md` appended, `tasks.md` ticked,
      `status: done`
- [ ] **Outstanding carried forward:** citations passthrough on the
      Anthropic Skin, and the §19 first-token measurement on both tiers —
      both need credentials this session did not have
- [x] P8's gate: the suite passes with **no test rewritten to fit the new
      implementation**, apart from the deleted scanner cases and the two
      assertion changes the notes explain


## Implementation notes (2026-08-13)

Backend 161 → 175 tests, frontend untouched at 121. Both lint clean.

- **The config refactor is behaviour-preserving, and that is the load-bearing
  claim.** With nothing new set, all 151 Phase 4 tests pass unmodified, and the
  frontend suite did not change at all — no route, no rule in `answers.ts`, and no
  client code moved to add a second tier. That is the evidence the port was the
  right shape rather than an assertion that it was.
- **The scanner's first version had the wrong anchor.** It scanned for the first
  `{` in the buffer, which is the *wrapper* — and the wrapper brace-matches to the
  very end of the answer, so the whole response was consumed as one unparseable
  object and no segment was ever emitted. Every scanner test failed at once, which
  is the good failure. It is now anchored just inside the `segments` array.
- **A mutation check found a hole in a test for the second time this branch.**
  Removing string-state tracking from the brace matcher passed all twelve scanner
  tests: the "braces inside text" case used `{"a": 1}`, whose braces *balance*, so
  naive depth counting accidentally landed on the right closing brace. Replaced
  with unbalanced cases — a lone `}`, a lone `{`, an escaped quote before a brace —
  and the mutation now fails three tests. The lesson generalises: a test for
  "structure inside a string is not structure" must use *unbalanced* structure.
- **The ask rate limit was reached by the test suite, not by a bug.** Adding two
  route-level tests pushed `answers.test.ts` to 21 asks against a 20-per-minute
  cap, and the 429 arrives as a JSON envelope rather than a stream — surfacing as
  "no `done` event" in an unrelated-looking test several cases later.
  `ANSWER_RATE_PER_MINUTE` is now configuration (a cost valve, not a §5 product
  limit) and the test env raises it, so the limiter still runs rather than being
  switched off.
- **Prose fallback is a real branch, not a theoretical one.** The adapter decides
  JSON vs prose from the first non-whitespace character, and a JSON body that is
  simply the wrong shape falls through to emitting the raw buffer with zero
  citations. Both paths are tested, because a router landing on a provider that
  ignores `response_format` is the likely failure, not an exotic one.
- **Outstanding, and why.** No OpenRouter or hosted-endpoint credential existed in
  this session, so two things are untested against a live server: whether
  Anthropic's citations survive the Anthropic Skin (REQ-197 — and this one fails
  *quietly*, as uniformly ungrounded answers), and whether a real endpoint honours
  the strict schema in practice (REQ-198 — the adapter is tested against a stub).
  The §19 first-token measurement is unmeasured on both tiers for the same reason.
  A single request carrying a `document` block settles the first question.


## Implementation notes — P8 (2026-08-13)

Backend 175 → 165 tests (twelve scanner cases deleted, two behaviour cases
added), frontend untouched, lint clean. `native` was not touched.

- **Doing the wiki first paid for itself.** Writing the amendment surfaced the
  validation trap *before* any code existed: `elementStream` yields only elements
  that validate, so a strict `cite` enum would have dropped whole segments —
  text included — for a bad index. That is strictly worse than the scanner it
  replaced. Caught on paper, fixed in the schema, and now pinned by a test and a
  mutation check rather than discovered as "answers are missing sentences".
- **The SDK silently downgrades the schema.** `@ai-sdk/openai-compatible` sends
  `response_format: {type:'json_object'}` and drops the schema unless the provider
  is built with `supportsStructuredOutputs: true`; it warns rather than failing.
  Without the flag the `cite` enum never reaches the model. Found by printing the
  request body, not from docs — and now covered by a mutation check.
- **`elementStream` completes empty rather than throwing** when the response is
  not the requested shape. The prose fallback had to move out of the catch block
  and become an explicit "no elements arrived" branch, which also had to
  distinguish *prose* from *well-formed but empty* — otherwise an empty answer that
  hit the token cap reported `end` instead of `truncated`, and the user would have
  been shown braces. Both cases are now tested.
- **Two assertions changed, and neither weakened.** The wrapper key is the SDK's
  (`elements`, not our `segments`), and the enum's position in the request body is
  the SDK's business — so that test now searches the schema for its *content*
  instead of walking a fixed path, which is both honest and version-proof.
- **What went away:** `segments.ts` (~150 lines), its twelve tests, the SSE line
  reader, chunk parsing, and finish-reason mapping. What arrived: two dependencies
  and one non-obvious provider flag.
- **Still unverified against a live endpoint** — unchanged from before: whether a
  real server honours the strict schema, and the §19 first-token measurement.
