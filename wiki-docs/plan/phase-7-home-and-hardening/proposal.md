---
title: Phase 7 — Home, activity & hardening
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [phase-7, home, activity, states, accessibility, performance, security, e2e]
---

# Proposal: Phase 7 — Home, activity & hardening

## Problem

Phases 0–6 built every capability the PRD names, but the roadmap's last row —
"Home + activity feed, error/empty states (§16), a11y audit (§18), perf (§19),
security review (§17), E2E scenario (§21)" — is the one that turns a set of
features into a product someone can be left alone with. Concretely:

- **The activity table has writers and no reader.** Eight `Activity` kinds are
  written today (`space.created`, `source.added`, `source.ready`,
  `source.failed`, `note.saved_answer`, `note.created`, `note.deleted`,
  `notebook.exported`) and two the PRD §15 asks for are not (`note.edited`,
  `note.converted` — conversion writes only the new source's `source.added`).
  No route returns any of them; the home page (`frontend/src/routes/home-page.tsx`)
  is the Phase 1 space list with Active/Archived tabs. §15's "most recently
  opened space", "last updated time" and "recent activity" are absent.
- **§16's twelve states were built one phase at a time.** Each phase shipped
  its own loading/empty/error copy; nobody has checked the set against the
  PRD list, nor that every error keeps typed content and offers Retry only
  where a retry is safe.
- **§18 has never been audited as a whole.** Individual specs assert
  `<label>`s, Escape on dialogs, and `aria-live` regions (ten files use them),
  but the 320 px floor, "status not by colour alone", and focus management
  across the note drawer / confirm dialogs have not been walked end to end.
- **§19 has no numbers.** The targets are written down; nothing has measured
  them.
- **§17 is mostly in place and partly infrastructural.** `assertOwnership`,
  upload validation, `retrievableSources()`, permanent delete, and a
  provider-hiding error handler exist. Not yet done: a route-table check that
  *every* space-scoped route registers ownership (today each spec tests its
  own), pino redaction so request bodies with note/notebook/conversation
  content never reach logs, and the two deployment items (HTTPS, encryption
  at rest) written down as deployment requirements rather than assumed.
- **§21 has never been run in a browser.** `log.md` records three phases
  closing with "the Chrome extension was not connected, so nothing was looked
  at in a browser". The scenario exists only as unit suites.

## Goal

A signed-in user lands on a home that says where they were (the most recently
opened space, one click away), how each space is doing (source and note
counts, last updated), and what happened recently across all their spaces
(newest first, every entry opening the thing it names). Every state in §16
exists, reads plainly, keeps the user's text, and offers Retry exactly when
safe. The app is walked once by keyboard, once by screen reader, once at
320 px, and once through all twenty-one steps of §21 in a real browser — and
what was found is fixed or recorded. The §19 numbers are measured and written
into the specs. The §17 checklist has a line per item, each pointing at a test
or a deployment requirement.

```
 /
 ┌─────────────────────────────────────────────┬──────────────────────────┐
 │ Welcome, Tan                    [New space] │ Recent activity          │
 │                                             │ ● Source ready · Smith…  │
 │ ┌─ Continue ──────────────────────────────┐ │   in Climate policy · 2m │
 │ │ Climate policy · 12 sources · 4 notes   │ │ ● Note saved · "Carbon…" │
 │ │ updated 2 h ago            [Open space] │ │   in Climate policy · 1h │
 │ └─────────────────────────────────────────┘ │ ● Space created · Sleep  │
 │ Active | Archived                           │   yesterday              │
 │ ▸ space rows (name · counts · updated)      │ ● Notebook exported …    │
 └─────────────────────────────────────────────┴──────────────────────────┘
        GET /spaces (exists)                 GET /activity?cursor=  (new)
```

## Scope

1. **Activity feed** (PRD §15) — `GET /activity` for the signed-in user
   across all spaces, newest first, cursor-paginated, each entry resolved to a
   human label and a link target; two missing writers (`note.edited`,
   coalesced; `note.converted`); a home panel that renders it with its own
   loading/empty/error states.
2. **Home** (PRD §15) — a "Continue" card for the most recently opened active
   space (counts + last updated), the existing list gaining "last updated",
   the activity panel beside it. The Active/Archived tabs stay as built.
3. **State audit** (PRD §16) — a matrix of the twelve required states against
   the code and the tests that name them; fix every gap (missing state, error
   that drops typed content, Retry offered where a retry is unsafe or absent
   where it is safe, provider wording leaking through).
4. **Accessibility audit** (PRD §18) — keyboard walk of every primary flow,
   screen-reader pass over processing/save announcements, 320 px pass, focus
   management of the note drawer and every confirm dialog, colour-only status
   check; an automated axe pass over the main screens in the test suite so
   the audit does not rot.
5. **Performance measurement** (PRD §19) — measure the six targets on the
   built bundle against the dev stack with a seeded 50-source space; record
   numbers; fix only what misses a target.
6. **Security review** (PRD §17) — a route-table test proving every
   space-scoped route registers `assertOwnership`; pino `redact` for content
   fields; a secrets-in-bundle check; the HTTPS and encryption-at-rest items
   written as deployment requirements in the backend README; a one-line
   verdict per §17 bullet in the spec.
7. **End-to-end scenario** (PRD §21) — Playwright installed at the root,
   one spec that walks §21 in order against the local dev stack, plus the
   same walk done by hand in Chrome once, with what was seen recorded.

## Out of scope

- Everything PRD §20 excludes. The home wireframe vocabulary ("Workspace")
  is a layout hint only ([[../../wireframe/index]]); no reading statuses, tags,
  trash, or dashboards.
- **Per-space activity views** or an activity page with filters. §15 asks for
  recent activity on the home screen; the feed is one list, paginated.
- **Notebook edits as activity.** §15's list has "notebook exported" and no
  "notebook edited"; autosave fires every 1.5 s and would drown the feed.
- **Retention or purging** of `Activity` rows. The table is indexed on
  `(userId, createdAt)`; growth is a later concern and is recorded as an open
  question, not built.
- **Performance work beyond a missed target.** §19 asks for numbers; this
  phase produces them. Bundle splitting, caching layers, or query tuning
  happen only where a measurement fails.
- **CI for the E2E suite.** The scenario needs Postgres, Redis, Ollama, and an
  answer provider. It runs locally against `docker-compose`; CI keeps the
  unit suites. A fake answer provider for CI is noted as future work.
- **Mobile layouts** beyond §18's 320 px usability floor. "Usable" means every
  control reachable and readable; it does not mean a redesigned navigation.

## Acceptance criteria

Copied from the PRD where it has them; the audits state what "done" means
since the PRD states only the requirement.

**§15 Home and recent activity**

- Activity is ordered newest first.
- Activity items open the relevant space, source, conversation, note, or
  notebook.
- One user's activity is never visible to another user.
- The home screen displays active spaces, the most recently opened space,
  source count, note count, last updated time, and recent activity.
- Recent activity includes: space created; source added; source processing
  completed or failed; answer saved as a note; note created, edited, or
  converted; notebook exported.

**§16 States**

- Each of the twelve listed states is reachable in the UI and named by a test.
- Every error message explains the problem in plain language, preserves
  user-entered content, offers Retry when retrying is safe, and exposes no
  stack trace or provider detail.

**§18 Accessibility**

- All primary flows complete by keyboard alone; focus is visible throughout.
- Dialogs close with Escape and return focus to their opener; the note drawer
  traps and returns focus.
- Processing and save-state changes are announced (live regions verified with
  VoiceOver once, and by the axe/role tests thereafter).
- No status is conveyed by colour alone.
- Every primary screen is usable at 320 px with no horizontal scroll.
- The axe pass over the primary screens reports zero violations at the
  `wcag2a`/`wcag2aa` tags.

**§19 Performance** — each of the six targets has a measured number in
[[../../specs/home-activity/spec|the spec]]'s Verification section, with the
method; any miss has either a fix in this phase or a recorded deviation.

**§17 Security** — each of the ten bullets has a verdict line: a test name,
a code location, or a deployment requirement in `backend/README.md`.

**§21 End-to-end** — the twenty-one steps pass in Playwright against the local
stack, and the same walk has been done once by hand in Chrome with findings
recorded in `tasks.md`'s implementation notes.

## Cross-references

- [[design]] — the decisions; [[tasks]] — the split.
- [[../../README#6-lộ-trình-triển-khai-7-giai-đoạn|Roadmap row 7]].
- [[../phase-1-spaces/proposal]] — the home page as built (space list, tabs);
  [[../../specs/spaces/spec]] REQ-056 (`space.created` activity), REQ-065
  (archived spaces are read-only, which decides whether an activity link into
  an archived space is live).
- [[../../specs/ingestion/spec]] (`source.added`, `source.ready`,
  `source.failed`), [[../../specs/notes/spec]] REQ-210 and the saved-answer,
  delete, and convert requirements, [[../../specs/export/spec]]
  (`notebook.exported`) — the writers this phase reads.
- [[../../specs/auth/spec]] — `api.ts` error handling that the §16 audit
  checks every feature against.
- New spec on close: `specs/home-activity/spec.md` (the capability
  [[../../AGENTS]] already names), carrying the §15 REQs and the §16–§19, §21
  audit results as Verification.
