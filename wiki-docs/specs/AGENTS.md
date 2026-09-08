# AGENTS.md — specs

Format and workflow for the living specs. Read [[../AGENTS]] first; this file
covers only layer 3 (`specs/`) and the `plan/` folders that feed it.

## What a spec is

**The current truth of what was built**, expressed as behavior. Not a design
doc, not a backlog, not a description of the code's structure. A reader should
be able to check the system against a spec without opening the implementation.

The counterintuitive part, restated because it drives everything below: a spec
is written **after** the code lands and is verified, from what was actually
observed. A requirement nobody exercised is a plan, not a spec — if it must be
recorded anyway, say so in `## Verification`.

## Layout

```
specs/
  AGENTS.md          this file
  <capability>/
    spec.md          the only required file
```

**One spec per capability, not per feature.** Capabilities follow the PRD:
`auth`, `spaces`, `ingestion`, `library-reader`, `assistant`, `notes`,
`notebook`, `export`, `home-activity`. Features arrive through `plan/`
proposals and are absorbed into the capability's existing spec — a single
`specs/spaces/spec.md` covers create, rename, archive/restore, and whatever
research-space behavior comes later.

A capability spanning both codebases is still one spec. Say which side owns
which requirement (a client-only rule reads "The client MUST …") rather than
splitting the file.

## File shape

Frontmatter, then the sections below in this order:

```yaml
---
title: <Capability> — spec
kind: spec
status: current            # current | superseded
sources:                   # PRD sections and the files the spec was read from
  - PRD §4 (research spaces), §16 (empty states)
  - backend/src/routes/spaces.ts
  - frontend/src/features/spaces/
created: YYYY-MM-DD
updated: YYYY-MM-DD        # bump on every edit, without exception
tags: [<capability>, spec]
---
```

| Section | Holds |
|---|---|
| Opening paragraph | What the spec covers and which phase it was written from |
| `## Scope` | Explicitly what it does **not** cover, and which spec does |
| `## <Topic>` … | Requirements, grouped by topic — one `###` per REQ |
| `## Verification` | How each requirement was exercised, and what was not |
| `## Cross-references` | The plan folder, related specs, wireframes |

Keep the RFC 2119 note in the opening paragraph so a reader knows MUST is load-bearing.

## Requirements

### Format

```markdown
### REQ-0NN — A short imperative title

The system MUST <behavior>, and MUST NOT <the thing it is easy to do instead>.

- GIVEN <starting state>
- WHEN <the trigger>
- THEN <the observable outcome>
```

- **RFC 2119 keywords in capitals**: MUST, MUST NOT, SHOULD, MAY. If a sentence
  has no keyword it is context, not a requirement — that is fine, but keep it short.
- **GIVEN/WHEN/THEN is optional** and belongs where the behavior is testable and
  the wording alone could be read two ways. A one-line invariant ("passwords MUST
  be stored only as argon2id hashes") does not need one.
- **Describe observable behavior, not implementation.** Status codes, response
  shapes, and what the user sees are behavior; class names and file layout are not.
  Naming a specific mechanism is right when the mechanism *is* the requirement
  (`assertOwnership` must be registered; argon2id must be the hash).
- **Seed requirements come from the PRD's per-section acceptance criteria.** Cite
  the section: "(PRD §4)".

### Ids

- `REQ-NNN`, **globally unique across every spec** — the index's "REQ range"
  column is what makes an id resolvable without a filename.
- **Stable forever.** Never renumber, never reuse a retired id. A requirement
  that goes away is deleted with a note in the phase's `log.md` entry; its id
  stays burnt.
- **New requirements append.** `auth` reserved a block per section
  (001–004 accounts, 010–019 sessions, 020s sign-in, 030s reset, 040s ownership,
  050s errors) and appended late additions out of order (REQ-054 sits beside
  REQ-050 by topic); `spaces` numbered contiguously from REQ-055. Both are
  acceptable — contiguous is the default, blocks are worth it only when a
  capability is large enough that the gaps carry meaning.
- Amending an existing requirement keeps its id and bumps `updated`.

## Callouts

Obsidian callouts, used sparingly — a callout is for something a reader would
otherwise get wrong.

```markdown
> [!warning] Spec-vs-code
> What the spec intended, what the code does, and why they differ.
```

| Callout | Use for |
|---|---|
| `> [!warning] Spec-vs-code` | **Mandatory** whenever a spec is edited to match code that diverged from it. Never silently rewrite the requirement — record the original intent alongside the reality. |
| `> [!warning] <title>` | A caveat about the verification itself (an unverified surface, a known gap). |
| `> [!note] <title>` | A deliberate temporary state — a stopgap, a feature present but inert until a later phase — with what will replace it. |

A plain blockquote (no callout marker) is the right home for rationale that
explains why a requirement looks like an omission.

## Verification

The section that keeps a spec honest. Record:

- **The date and what it ran against** — "verified 2026-08-11 against the running
  stack (Postgres via docker compose, API on `:4000`, SPA on `:5173`)".
- **Which test file covers which REQ ids**, and the suite totals before → after.
- **What was checked by hand** rather than automatically.
- **What is not covered**, by id, and why. This list is the most useful thing in
  the file; it becomes the next phase's cleanup.
- **Mutation checks**, where they were done: re-introduce a defect one at a time
  and confirm exactly the intended test fails. A test that passes with the bug
  restored is a restatement of the code, not a regression test — say which
  behaviors were proven load-bearing this way.

## Change proposals (`plan/`)

Every non-trivial change starts as a folder, **one per change even when it spans
both codebases**:

```
plan/<change-name>/
  proposal.md     Problem · Goal · Scope · Out of scope · Acceptance criteria · Cross-references
  design.md       The decisions: what was chosen, the alternatives, and why
  tasks.md        Work breakdown split by codebase, then Exit criteria
  research.md     Optional — see below
```

Shared frontmatter: `title`, `kind: plan`, `status` (`proposed` → `done`),
`created`, `updated`, `tags`.

- **`proposal.md`** is about *what and why*. Acceptance criteria are copied from
  the PRD's own criteria wherever they exist, so "done" is not a judgement call.
  "Out of scope" is a real section: naming the §20 exclusions and the neighbouring
  phases is what stops scope drift.
- **`design.md`** is about *how*, and is mostly a record of decisions. Each
  decision names the alternative it rejected and the cost it accepted — that is
  the part nobody can reconstruct later. Decisions with a lasting consequence get
  a dated heading ("Notebook is lazy-created (decided 2026-08-11)").
- **`tasks.md`** is checkboxes grouped `## Backend` / `## Frontend` (or by whatever
  boundary the change has), ending in `## Exit criteria`. After implementation it
  gains an `## Implementation notes (date)` section listing every deviation from
  `design.md` and anything a later phase must know. Nothing is a deviation
  "too small to record": the notes are read by whoever is confused in three phases' time.
- **`research.md`** when a decision needs evidence first — library comparisons,
  provider trade-offs, spikes. Skip it when the choice is obvious; a research file
  written to look thorough is noise.

### Feature workflow

1. **Research** (optional) — write `research.md` if a decision is blocked on
   evidence. Discuss findings before choosing.
2. **Propose** — create the plan folder; add it to `index.md`; append `create` to
   `log.md`. Status `proposed`.
3. **Implement** — in the codebases, in their own session. Wiki tasks never write
   to `../backend/` or `../frontend/`, and code sessions do not rewrite specs
   mid-flight.
4. **Verify** — run the acceptance criteria, by hand as well as by test. Record
   what could not be verified instead of quietly dropping it.
5. **Close** — tick `tasks.md`, set `status: done`, add the implementation notes,
   write or update `specs/<capability>/spec.md` from the verified behavior, update
   `index.md`, append `update` (and `create` for a new spec) to `log.md`.

Skip the plan folder entirely for 1–2 line bug fixes, config tweaks, and
behavior-preserving refactors — but still append to `log.md`.

## Commands

There is no spec tooling; a spec is prose, and these are the checks worth running
by hand.

```bash
# Which REQ ids exist, and where — the check against a duplicate or a gap
grep -rn "^### REQ-" wiki-docs/specs/

# The highest id in use, so a new requirement appends
grep -rho "REQ-[0-9]\{3\}" wiki-docs/specs/ | sort -u | tail -1

# Requirements a test names — the ids below are covered, the rest are the gap
grep -rn "REQ-[0-9]\{3\}" backend/test/ frontend/src/

# Specs that were edited without bumping frontmatter
grep -rn "^updated:" wiki-docs/specs/*/spec.md

# Every unresolved caveat across the wiki
grep -rn "^> \[!" wiki-docs/
```

Verifying a spec means running the suites it cites and re-reading its
`## Verification` section against what they actually cover:

```bash
pnpm --filter backend test && pnpm --filter frontend test
```

## Boundaries

**Always**

- Write the spec from verified behavior, after implementation.
- Bump `updated` on every spec edit.
- Add a `> [!warning] Spec-vs-code` callout when the spec is changed to match code.
- Record what is *not* covered, by REQ id.

**Never**

- Renumber or reuse a REQ id.
- Split one capability across two specs, or one change across two plan folders.
- Add a requirement for a feature PRD §20 excludes — an exclusion is a
  requirement, and a spec is not the place to relitigate it.
- Describe code structure where behavior is what matters.

## Cross-references

- [[../AGENTS]] — the wiki's five layers and the operations that touch them.
- [[auth/spec]] · [[spaces/spec]] — the two specs these conventions were drawn from.
- [[../index]] — the catalog every new spec is registered in.
