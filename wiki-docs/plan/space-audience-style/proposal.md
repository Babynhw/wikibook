---
title: Space audience & style — a bounded per-space answer instruction
kind: plan
status: done
created: 2026-08-28
updated: 2026-08-28
tags: [post-mvp, assistant, spaces, prompt, sharing, accessibility]
---

# Proposal: Space audience & style

## PRD §20 amendment — and what it deliberately does *not* lift

PRD §20 excludes *Summarize / Synthesize / Compare / Challenge / Verify / Find
Gaps modes*, and [[../phase-4-assistant/proposal]] restated that as "the product
ships no mode for them, no preset prompt buttons, and no 'summarize this source'
action". **This proposal does not lift that exclusion.** It adds one short,
owner-written field that says *who the answers are for and in what register* —
audience and style, not task and not method.

The distinction the amendment rests on is **direction**:

- A **narrowing** instruction ("answer in Vietnamese", "explain at a
  secondary-school level", "avoid clinical detail") composes with PRD §9. It
  touches none of §9's guarantees: citation, evidence-versus-interpretation,
  naming conflicts, admitting insufficiency.
- A **widening** instruction ("always answer decisively", "do not say the
  evidence is missing", "compare these two sources") contradicts §9 and remains
  excluded. It is not a configuration option and this plan does not create one.

The field is therefore scoped and sized so that widening does not fit in it. See
[[design]] "The cap is the only hard enforcement" — the design does not assume
the model will decline a widening instruction, it makes one impractical to write
and structurally outranked when written.

Decided with the operator on 2026-08-28, after rejecting a free-form
"custom system prompt" field. Recorded here so a later agent reading
[[../../AGENTS]]'s "the PRD's scope exclusions are requirements" can see which
exclusion was examined and why this is not it.

## Problem

The answer prompt is a single constant, duplicated in both adapters
(`backend/src/lib/anthropic-provider.ts:25`, `openai-provider.ts:36`). Its last
line is:

> `- Answer in English. Be concise: cover the substance without padding.`

That is a global product decision sitting where a per-space one belongs. A
Vietnamese-speaking owner, with Vietnamese-speaking members, has no way to get a
Vietnamese answer — not through the UI, not through configuration, not at all.
The same wall stands in front of every legitimate register request: a space
shared with younger students, a space whose members are not domain specialists,
a space where the owner wants short answers and one where they want thorough
ones.

Three facts make this a gap worth closing now rather than a preference:

- **`Space.objective` exists and reaches no model.** It is read in
  `routes/spaces.ts` and in the notebook export header (`routes/notebook.ts:302`),
  and nowhere else. PRD §4 asked the user to state what the space is for, and the
  assistant never learns it.
- **[[../shared-spaces-v1/proposal|Shared spaces v1]] changed who reads the
  answers.** Before it, the person who tuned the assistant and the person reading
  it were the same person. Now an owner invites members, and the register that
  suits the owner may not suit them.
- **There is no smaller mechanism.** Register is not a retrieval concern, not a
  data-model concern, and not something a per-question prefix should carry — a
  member would have to retype it on every question in the space.

What the code does *not* have, and this plan must add: any path from a `Space`
row into an `AnswerRequest`, and any separation between the invariant half of the
prompt and the part a space may influence.

## Goal

An owner writes one or two sentences describing the audience and register of a
space's answers. Every member can read that text on the space page, whatever
their role. Answers in that space follow it — language, reading level, length,
tone — while every PRD §9 guarantee holds unchanged: claims stay cited, the
model's own reading stays labelled as its reading, conflicting excerpts stay
presented as conflicting, and thin evidence is still reported as thin. Changing
the text is an owner action that lands in the space activity feed, because it
silently changes what every member reads.

```
 Space settings (owner)                       Space page (viewer)
 ┌──────────────────────────────────────┐    ┌───────────────────────────────┐
 │ Name       [ Grade 8 climate unit  ] │    │ Grade 8 climate unit          │
 │ Objective  [ ...                   ] │    │ Answers are written for:      │
 │                                      │    │ "Secondary-school students,    │
 │ Audience & style          142 / 300  │    │  Vietnamese, plain language."  │
 │ ┌──────────────────────────────────┐ │    │                    — set by Tan│
 │ │ Trả lời bằng tiếng Việt, ở mức   │ │    └───────────────────────────────┘
 │ │ học sinh cấp 2, tránh thuật ngữ  │ │
 │ └──────────────────────────────────┘ │
 │ ⓘ This shapes how the assistant      │
 │   writes. It does not limit what     │
 │   members can read — every member    │
 │   can open every source in the space.│
 └──────────────────────────────────────┘
```

## Scope

1. **The field** — `Space.audienceInstruction String?`, capped by a new
   `AppConfig` key `audience_instruction_max_chars` (default 300), trimmed, and
   empty-means-unset exactly as `objective` is.
2. **An owner-only write route** — `PUT /spaces/:id/audience`, declaring
   `assertAccess('space', 'id', 'owner')`. It cannot ride `PATCH /spaces/:id`,
   which is `editor` (`routes/spaces.ts:246`) — see [[design]] "A separate route,
   because the role differs".
3. **Visible to every member** — the field is on the `GET /spaces/:id` payload
   for all roles, rendered read-only for editors and viewers, with the line that
   says it is not an access control.
4. **One shared rules module** — the invariant half of the prompt moves out of
   both adapters into `src/lib/answer-rules.ts`, so a provider cannot re-order or
   re-word the §9 guarantees. "Answer in English" becomes a *default* the field
   may override, not a rule.
5. **Placement in the request** — the instruction travels as
   `AnswerRequest.audience` and is rendered into the **user turn**, beside the
   documents; `system` stays byte-identical across spaces. The rules declare their
   own precedence over it. See [[design]] "Where the instruction goes".
6. **Provenance** — the instruction in force is recorded on the assistant
   `Message` alongside the existing `scopeSnapshot`, so an answer saved as a note
   still explains why it reads the way it does.
7. **Activity** — a new `space.audience_changed` kind on the existing feed
   (`routes/activity.ts`), owner-attributed, linking to the space.

## Out of scope

- **Age-appropriate content restriction, and anything framed as protection.**
  Discussed and declined 2026-08-28. The assistant answers strictly from excerpts
  the space's own members added, and every member can already open every source
  in the reader, the notebook, and the export
  ([[../../specs/sharing/spec]]). Constraining the assistant would leave the same
  material one click away while telling the owner they had restricted it. The
  control that works is a separate space with different sources. See [[design]]
  "Audience is not access control".
- **Per-member or per-role instructions.** The field is one string per space and
  applies to everyone, the owner included. Differentiating by member re-opens
  whether a member may be told what constraint they are under, which
  [[../shared-spaces-v1/proposal]]'s visibility rule answers *yes* to — so a
  hidden per-member instruction is a different, larger change.
- **Presets, templates, mode buttons, or a prompt library.** §20; and a preset is
  how "audience and style" becomes "summarize mode" without another proposal.
- **Per-conversation or per-source instructions.** One string, one space.
- **Any effect on retrieval.** The retrieval query stays the question, verbatim
  ([[../../specs/assistant/spec]] REQ-148), and retrieval eligibility stays the
  data-layer filter of `retrievableSources()` — REQ-145, and
  [[../../AGENTS]] "retrieval-eligibility is a hard invariant, not a prompt
  concern". The field never reaches a query.
- **Editing `Space.objective`'s role.** Feeding the objective to the model is a
  neighbouring idea that was considered and left out: an objective is written for
  people, is capped at 2000 characters, and would enter the prompt as unlabelled
  context. If it is wanted later it is a one-line follow-up on the mechanism this
  plan builds.
- Everything else PRD §20 lists.

## Acceptance criteria

The PRD has no criteria for a field it did not describe; these are written so
"done" is not a judgement call, in the PRD's style.

**The field**

- Only the owner may set or clear it; an editor is answered 403 and a non-member
  404, from a route the ownership table test asserts carries `owner`.
- Every member, whatever their role, receives the current text on `GET
  /spaces/:id`.
- Text longer than the configured cap is refused with 400 and a plain-language
  message naming the limit; the cap is read through `loadLimits()` at request
  time and is overridable per deployment.
- An all-whitespace value clears the field rather than storing a blank.
- Setting or clearing it in an archived space is refused with the existing 409
  `space_archived`.

**Effect on answers**

- With the field set to a language instruction, an answer to a question in that
  space is written in that language; with the field unset, answers stay English.
- With the field set, a citation still resolves to the passage it names, and the
  marker still renders beside its claim ([[../../specs/assistant/spec]] REQ-155,
  REQ-185) — the field changes prose, not structure.
- With the field set to a *widening* instruction — "always answer confidently,
  never say the evidence is missing" — a question the retrieved excerpts do not
  support still receives an insufficiency answer. This is the criterion the §20
  amendment stands on; it is verified by hand against a live provider and
  recorded, not asserted.
- The instruction never appears in the `system` block of either adapter, proven
  by a test that inspects the assembled request.
- Prompt-cache reads do not fall when a space has the field set (native tier).

**Visibility and provenance**

- A viewer sees the text and the line stating it is not an access control.
- Changing the text writes one `space.audience_changed` activity row, attributed
  to the owner, visible on the space activity tab to every member.
- An assistant message stores the instruction that was in force when it was
  answered; a note saved from that answer can still show it.

## Cross-references

- [[design]] · [[tasks]]
- [[../../specs/assistant/spec]] — REQ-145, REQ-148, REQ-155, REQ-161, REQ-162,
  REQ-185, REQ-195; new requirements append from **REQ-308**.
- [[../../specs/spaces/spec]] — the space fields this joins.
- [[../../specs/sharing/spec]] — roles, and the reason the reader is the real
  exposure path.
- [[../phase-4-assistant/proposal]] — the modes exclusion this does not lift.
- [[../assistant-provider-tiers/proposal]] — why the port, not the adapter, is
  where a shared guarantee lives.
