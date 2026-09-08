---
title: Assistant reasoning visibility — tasks
kind: plan
status: done
created: 2026-08-15
updated: 2026-08-15
tags: [assistant, providers, streaming, reasoning]
---

# Tasks: Assistant reasoning visibility

One change, two codebases. Backend makes the reasoning channel exist; frontend
makes it legible. Neither half is useful alone — the backend without the
frontend replaces a 20-second "Searching your sources…" with a 20-second
unlabelled wall of italic text.

## Backend

- [x] Add a merge helper that drains two async iterables concurrently and
      yields whichever produces first. It must not drain one before the other:
      the SDK's tee buffers for the slower reader
      (`ai/dist/index.js:10209`), so a sequential drain deadlocks a long answer.
- [x] In `openai-provider.ts`, consume `result.fullStream` alongside
      `result.elementStream`, filtering for `reasoning-delta` parts and
      yielding `{ type: 'thinking', text }`. Leave `elementStream`'s handling
      of elements exactly as it is — REQ-201's coercion lives in that transform.
- [x] Set `capabilities.thinking` to `'adaptive'` on this provider.
- [x] Send `ANSWER_EFFORT` as `providerOptions.answers.reasoningEffort`,
      beside the existing `provider.require_parameters` guard. Passed through
      unvalidated — see [[design]] "passed through, not validated".
- [x] Leave `effortLevels: []` and comment that empty means *not enumerable*,
      not *not supported*.
- [x] Bound the request with `ANSWER_TIMEOUT_MS` by composing a deadline with
      the caller's abort signal. The caller's signal must keep working on its
      own — it is how a closed tab stops paying for tokens.
- [x] Confirm the salvage branches are unreachable from reasoning: a response
      of pure reasoning and no content stays a failure, and reasoning is never
      salvaged into answer text (REQ-199).

### Backend tests (`test/openai-provider.test.ts`)

- [x] `reasoning_content` deltas become `thinking` events, and no `delta`.
- [x] Interleaved reasoning and content keep both channels intact — the merge
      must not drop, duplicate, or reorder within a channel.
- [x] A stream with no reasoning produces no `thinking` events at all
      (acceptance criterion 5).
- [x] The captured request body carries `reasoning_effort` from the configured
      effort. The stub already captures bodies (`sent` in its `stub()` helper).
- [x] A stalled response aborts at `ANSWER_TIMEOUT_MS` as an
      `AnswerProviderError`.

### Backend tests (`test/answers.test.ts`)

- [x] A run whose provider emits reasoning yields it as `thinking` and the
      final `outcome.text` contains **none** of it (acceptance criterion 6).
      This is the guard `answers.ts` gets instead of code.

## Frontend

- [x] Replace the italic `pending.thinking` paragraph
      (`assistant-pane.tsx:144-150`) with a "Thinking…" block: a persistent
      label with a motion cue, plus the reasoning tail clamped to ~3 lines and
      following the newest text.
- [x] Keep "Searching your sources…" as the state before any event arrives, so
      the pane distinguishes **searching → thinking → answering**.
- [x] Keep the block visually subordinate to `AnswerMessage` — status
      affordance in `on-surface-variant`, no card, no citations, no actions. It
      must never read as the answer.
- [x] Add "Thinking" as a third announced state in the live region
      (`assistant-pane.tsx:70-80`), and keep reasoning text out of it
      (REQ-187).
- [x] Tokens only — no literal colours, per `frontend/CLAUDE.md`.

### Frontend tests (`assistant-pane.test.tsx`)

- [x] A stream that sends `thinking` before any `delta` renders the "Thinking…"
      label, not the searching copy.
- [x] The label is replaced by the answer once the first `delta` arrives.
- [x] The live region announces a state and never the reasoning text.

## Verification by hand

The measurement is the point of the change, so it is not optional:

- [x] Re-run the timing measurement through the app rather than curl, on the
      configured endpoint, and record **time to the "Thinking…" state** and
      **time to first answer segment** in the implementation notes. The
      baseline to beat is the 1.2 s / 21.6 s split in [[proposal]].
- [x] Inspect one outgoing request body and confirm `reasoning_effort`.
- [x] Ask one question with `ANSWER_EFFORT` at two different values and record
      whether the reasoning time actually moves — this is the only evidence
      that the passed-through value is understood by this endpoint.
- [x] Confirm a stored answer's `content` after a reasoning run carries no
      reasoning.
- [ ] **Not done.** Look at the running app. The Chrome extension was not
      connected, which is the same reason [[../space-sidebar/tasks]] shipped
      unseen. The full stack *was* run and the stream driven against the real
      model, so everything but the pixels is verified — but this change is
      entirely about what a person sees during a 20-second wait, and jsdom has
      neither layout nor time. Carried into the spec as an outstanding warning.

## Exit criteria

- [x] All eight acceptance criteria in [[proposal]] met, with the two
      measurements recorded. Criterion 2 (bounded on screen) is met in the
      markup and the stylesheet but was not *seen* — see the unticked item above.
- [x] `pnpm --filter backend test && pnpm --filter frontend test` green, with
      totals before → after in the implementation notes.
- [x] Both codebases lint and typecheck clean.
- [x] `## Implementation notes (date)` added below, listing every deviation
      from [[design]] — including any that seem too small to record.
- [x] `specs/assistant/spec.md` updated from **verified** behaviour, appending
      from REQ-226 (current highest is REQ-225). Expect requirements for: the
      reasoning channel is surfaced, reasoning is never answer text and never
      evidence, the capability record matches the behaviour, effort reaches the
      endpoint, and the pane's three states. Bump `updated`.
- [x] REQ-187's live-region requirement amended in place if the third state
      changes its wording — same id, bumped `updated`.
- [x] `status: done` on all three plan files; `index.md` plan row updated;
      `log.md` appended.

## Implementation notes (2026-08-15)

Backend 200 → 207, frontend 149 → 152. No existing test was edited. Both
codebases typecheck clean.

> A review pass after this was first written up as finished caught a real defect
> in it — see "Caught by review" below. The notes have been corrected rather than
> appended to, so nothing here reads as delivered that was not.

### Deviations from [[design]]

- **`result.stream`, not `result.fullStream`.** The design named `fullStream`
  from reading the SDK's implementation; the *type* declaration marks it
  `@deprecated` in `ai@7` and points at `stream`, which is the same getter
  (`fullStream` returns `this.stream`). Behaviourally identical, including the
  tee. Named here because the design's SDK section will otherwise read as wrong
  to the next person who greps for it.
- **The timeout also bounds `title()`.** The design only said "the request". A
  title is a provider call on the same endpoint and stalls the same way, so it
  got the same bound — one line, but a scope addition rather than an omission.
- **`ANSWER_TIMEOUT_MS` is pinned to 1500 ms in `vitest.config.ts`.** The
  timeout can only be asserted by letting it fire: `AbortSignal.timeout` is
  native and `vi.useFakeTimers` does not reach it. Pinned in the same place, and
  for the same reason, as the two config pins already there.

### Found during verification, fixed here: `done` waited for the title

Measuring end-to-end turned up a **second**, independent cause of "the assistant
is slow" that has nothing to do with reasoning:

```
thinking  first= 2.32s  count=291
delta     first=21.64s  count=2
done      first=56.71s          <- 35s after the answer was complete
```

`await provider.title(...)` sat between the stored answer and `done`, under a
comment reading "off the critical path". It was not: the finished answer sat on
screen with the composer disabled for 35 seconds while a *second* call to the
same reasoning model wrote six words. Titling now follows `done` — **and the
client now settles on `done` rather than on the close**, which is the half that
actually delivers it (see "Caught by review" above). The `title` event still
arrives afterwards and refreshes the conversation list.

This is outside [[proposal]]'s stated scope and was taken anyway, because it was
the other half of the reported symptom and the fix is an ordering change. Spec'd
as REQ-232 with a `Spec-vs-code` callout, since the code asserted the behaviour
it did not have.

### Caught by review: the `done` fix did not reach the UI

The server change below was written up as "the composer is released 35 s
earlier". It was not. `use-ask.ts` settled — `setStatus('idle')`, hand off to the
stored thread — **after its read loop ended**, and the loop only ends when the
server closes the stream, which is after titling. So `done` arriving at 21.1 s
instead of 56.7 s changed an SSE timestamp and nothing a person could see.

Proved with a test before believing it: drive `done` on a stream that is
deliberately left open, then assert Ask is enabled. It failed. The client now
settles in the `done` branch, guarded by a `finished` flag so the post-loop path
stays correct for a stream that closes without one.

The lesson worth keeping: the end-to-end measurement was taken with `curl`, which
made the server-side event ordering look like the whole story. A measurement that
does not go through the client cannot verify a claim about the client.

### Measurements, against the live endpoint

`ANSWER_BASE_URL=http://localhost:20128/v1`, `ANSWER_MODEL=oc-go/qwen3.6-plus`,
end-to-end through the route with real retrieval:

| | before | after |
|---|---|---|
| first progress event | 21.6 s | **1.6 s** |
| `done` | 56.7 s | **21.1 s** |
| first answer text | 19.7–21.6 s | unchanged (model-bound) |

Both answers were grounded, with a citation resolved to the seeded source.

### `reasoning_effort` ships; its effect does not replicate

Confirmed in the outgoing body at all three levels. Whether the endpoint honours
it could not be shown — reasoning-event counts across runs:

| effort | run 1 | run 2 |
|---|---|---|
| low | 290 events / 20.5 s | 292 / 19.9 s, 294 / 19.6 s |
| medium | 743 / 46.8 s | 147 / 11.6 s |
| high | 354 / 24.4 s | — |

`low` is reproducible; `medium` varies 4× between identical runs, which is wider
than any gap between levels. So: the value reaches the endpoint, and nothing can
be concluded about what it does there. Recorded in the spec's REQ-229 callout
rather than asserted either way.

### Mutation checks

Three, each confirming the new tests are load-bearing rather than restatements:

- Dropping the `reasoning-delta` branch fails exactly the two reasoning tests.
- Removing `reasoningEffort` from the body fails exactly the effort test.
- Restoring the old `title`-before-`done` order fails exactly REQ-232's test.

### For whoever picks this up

- The reasoning-visible change makes §19's `firstTokenMs` log field honest for
  the first time on a reasoning model: it stamps on the first `thinking` *or*
  `delta`, and previously only ever saw the latter.
- `TITLE_MODEL` is set to the same reasoning model in the operator's `.env`,
  which is why titling took 35 s. Now that it is off the critical path it costs
  nothing visible, but a small non-reasoning model would still be the right
  setting.
