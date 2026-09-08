---
title: Phase 1 — Research spaces
kind: plan
status: done
created: 2026-08-11
updated: 2026-08-11
tags: [phase-1, spaces, crud, archive]
---

# Proposal: Phase 1 — Research spaces

## Problem

Phase 0 left a running API with authenticated users and a full Prisma
schema, but no owned resources: a signed-in user reaches a home screen
that shows a health probe and nothing else. Every later phase hangs off a
`Space` — sources, conversations, notes, and the notebook are all
space-scoped (PRD §2) — so nothing can be built until a user can create
one and open it.

`assertOwnership` exists but is exercised only by unit tests; Phase 1 is
the first phase where it guards real routes, which makes it the phase
that proves the ownership invariant end-to-end (PRD §17).

## Goal

A signed-in user can create a research space, edit its name and
objective, archive and restore it, and open it into a workspace shell
that shows the correct new-space empty states.

```
sign in → no spaces (empty state) → create space → space shell
        → rename / edit objective → archive → restore (content intact)
        → sign in again → most recently opened space is resumable
```

## Scope

1. **Space CRUD** — create (name required, objective optional but
   prompted), read one, list, rename, edit objective (PRD §4).
2. **Archive / restore** — reversible, never destructive; archived
   spaces leave the active list and their content is returned unchanged
   on restore (PRD §4).
3. **Last-opened** — `lastOpenedAt` is stamped when a space is opened;
   active spaces are sorted most-recently-opened first, and the returning
   user can resume the most recent one (PRD §3, §4).
4. **New-space state** — the space shell renders an empty source
   library, empty conversation area, empty note collection, a blank
   notebook, an Add Source action, and the prompt explaining that
   evidence sources are required before the assistant can answer
   (PRD §4, §16).
5. **Ownership** — every space route registers `assertOwnership`;
   another user's space answers 404, never 403 (PRD §17).
6. **`space.created` activity rows** — written now so the Phase 7 feed
   has history rather than starting empty (PRD §15).

## Out of scope

- **Source ingestion** (Phase 2) — the Add Source action is present per
  §4's new-space state but disabled with an explanatory hint until the
  ingestion capability exists.
- **The library, assistant, notes, notebook editor, export, activity
  feed UI** — Phases 3–7. Phase 1 renders their empty states only.
- **Deleting a space.** PRD §4 requires archive/restore and never
  mentions deletion; adding a destructive operation the PRD does not ask
  for needs its own proposal (and §17's "deleting a source removes file,
  text, index, and citations" cascade thinking).
- **Space sharing, roles, cross-space anything** — §20 exclusions.
- **Tags, folders, or space statuses** — §20 exclusions, and they appear
  in the mockups; see [[../../wireframe/index]].

## Acceptance criteria

Directly from PRD §4, plus the §3 criterion this phase completes:

- Creating a space immediately adds it to the user's space list, with
  the name required and the objective optional.
- Changes to the space name and objective persist after refresh.
- Archived spaces are removed from the active list.
- Restoring a space returns all associated content unchanged (verified
  by attaching rows to the space before archiving, since Phase 1 has no
  UI that creates sources or notes yet).
- Active spaces are sorted most-recently-opened first; a returning user
  can resume their most recently opened space (PRD §3).
- A newly created space shows every empty state listed in §4's
  new-space state, including the evidence-sources prompt.
- A request for another user's space answers 404; an unauthenticated
  request answers 401.
- Space limits are not hard-coded: the phase introduces no new numeric
  limit, and any it needs later is read through `loadLimits()` (PRD §5).

## Cross-references

- [[design]] — technical decisions for this phase.
- [[tasks]] — work breakdown, split by codebase.
- [[../phase-0-foundation/proposal]] — the foundation this builds on.
- [[../../specs/auth/spec]] — ownership and session rules this phase
  first applies to a real resource.
- [[../../wireframe/index]] — layout reference for the workspace shell.
- PRD `../../../RAG Workspace - PRD.docx` §2 (data objects), §3
  (resume last-opened), §4 (research spaces), §15 (activity), §16
  (empty states), §17 (ownership), §20 (exclusions).
