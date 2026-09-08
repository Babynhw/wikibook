---
title: Phase 7 — Home, activity & hardening — design
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [phase-7, home, activity, states, accessibility, performance, security, e2e, design]
---

# Design: Phase 7 — Home, activity & hardening

Decisions, each with the alternative it rejected and the cost it accepts.
[[proposal]] says what and why; [[tasks]] splits the work.

## Activity feed

### No migration; labels are resolved at read time (decided 2026-08-27)

`Activity { id, userId, spaceId?, kind, refId?, createdAt }` stays as it is.
`GET /activity` resolves each row to `{ id, kind, createdAt, space: { id, name,
archivedAt } | null, target: { type, id, title } | null, href }` by batching
one `findMany` per target type over the page's `refId`s (sources, notes,
notebooks, spaces). A `refId` whose row no longer exists yields
`target: null` and a label such as "a source that has since been deleted";
the entry still renders, with the space link only.

*Rejected:* a `title` (or `payload Json`) column written with each row. It
makes the read a single query and survives deletion, at the cost of a
migration, a stale title after every rename, and eight writers to change.
*Rejected:* dropping rows whose target is gone. Then "source added" followed by
a permanent delete leaves a feed that never mentioned the source; the audit
trail reads better with a greyed entry.

*Cost:* up to four extra queries per page (bounded by page size, indexed by
primary key); a renamed note shows its current title, not the one it had when
the activity happened. Nothing in §15 asks for the historical title.

### One route, user-scoped, cursor-paginated (decided 2026-08-27)

`GET /activity?limit=20&cursor=<createdAt>_<id>` — `requireUser`, filter
`userId = request.user.id`, order `createdAt desc, id desc`, page size clamped
to 1–50 (default 20), opaque cursor made of the last row's `(createdAt, id)`.
This is the whole of §15's "one user's activity is never visible to another":
the query never takes a space id, so there is no ownership check to forget.

*Rejected:* `GET /spaces/:id/activity`. §15 places activity on the home
screen, across spaces; a per-space feed would need a second aggregation route
anyway. *Rejected:* offset pagination. New rows arrive constantly; an offset
skips or repeats an entry on every "Load more".

*Cost:* no per-space view. If one is wanted later it is the same handler with
a `spaceId` filter behind `assertOwnership`.

### Link targets by kind (decided 2026-08-27)

| kind | href | when target is gone |
|---|---|---|
| `space.created` | `/spaces/:spaceId` | space deleted → no link |
| `source.added` · `source.ready` · `source.failed` | `/spaces/:spaceId/sources/:refId` | source deleted → space link only |
| `note.saved_answer` · `note.created` · `note.edited` · `note.converted` | `/spaces/:spaceId/notes?note=:refId` | note deleted → space link only |
| `note.deleted` | `/spaces/:spaceId/notes` | — (never had a live target) |
| `notebook.exported` | `/spaces/:spaceId/notebook` | — |

`href` is computed on the server so the client renders one `<Link>` per row
and the mapping lives next to the resolver it depends on. An archived space
(REQ-065) stays linkable: it is read-only, not hidden. `note.saved_answer`
links to the note, not the conversation — the note is what the user made, and
it carries its source conversation.

*Rejected:* letting the frontend map kinds to routes. Two places would know
the route table; the resolver already knows which target exists.

### Two missing writers; edits coalesce (decided 2026-08-27)

- `note.converted` is written in the convert transaction alongside the new
  source's `source.added` (the one [[../../specs/notes/spec]] already
  requires). The feed shows both entries — one names the note, one the source
  — which is what happened.
- `note.edited` is written by `PATCH /notes/:id` when title or body changed,
  **coalesced**: if the newest activity for `(userId, kind='note.edited',
  refId)` is younger than `ACTIVITY_COALESCE_MINUTES` (env, default 10), its
  `createdAt` is bumped to now instead of inserting. A note edited over an
  hour shows as one entry that keeps floating to the top, not sixty.

*Rejected:* an entry per `PATCH`. The note editor saves on blur and on a
debounce; a working session would be the entire feed. *Rejected:* no
`note.edited` at all. §15 names it. *Rejected:* putting the window in
`AppConfig`. `AppConfig` is for PRD §5 limits the user can change at runtime;
this is a tuning constant, same reasoning as `NOTEBOOK_BODY_LIMIT_BYTES` in
[[../phase-6-notebook-export/design]].

*Cost:* bumping `createdAt` means an activity's timestamp is "last edit in
this burst", not "first edit". The label says "edited" and the time is when
the edit happened, so this reads correctly.

## Home

### Compose, do not rebuild (decided 2026-08-27)

`home-page.tsx` keeps its header, tabs, list, dialog, and states. Three
additions: a `ContinueCard` for the first active space (already the most
recently opened — `GET /spaces` orders by `lastOpenedAt desc`) showing counts
and "Updated <relative time>"; the list rows gain the same "Updated" text; an
`ActivityPanel` beside the list, rendered from `useActivity()` (TanStack
`useInfiniteQuery`, `getNextPageParam` = cursor), with "Load more", its own
empty state ("Nothing yet — create a space or add a source to see activity
here"), and its own error + Retry. On a viewport below `md` the panel stacks
under the list.

*Rejected:* a separate `/activity` route. §15 puts it on the home screen.
*Rejected:* a new `GET /home` aggregating spaces + activity in one call. Two
cached queries with independent states are simpler to reason about, and the
space list already exists with its own tests.

*Cost:* two requests on home load. Both are small and cached by TanStack.

### Relative time comes from one helper (decided 2026-08-27)

`frontend/src/lib/relative-time.ts` — `Intl.RelativeTimeFormat` for "2 m ago"
… "yesterday", absolute date beyond 7 days, `<time dateTime=…>` with the full
timestamp as `title`. Used by the card, the list, and the feed. No date library
is added.

## §16 State audit

### A matrix, then fixes; no new abstraction (decided 2026-08-27)

`tasks.md` carries the twelve states as rows: where the state renders, which
test names it, whether typed content survives, whether Retry is offered and
whether it is safe. Each gap becomes a checkbox under the owning feature
folder. Retry is "safe" when the action is idempotent or guarded (space
create is not — a retry could duplicate — so its error offers "Try again"
only by re-submitting the still-filled form, which is the form itself, not a
Retry button; source retry is guarded by state per
[[../../specs/ingestion/spec]]; notebook and note saves are compare-and-set).

*Rejected:* a shared `<AsyncState>` component to unify all twelve. The states
differ in copy, in what "retry" means, and in where typed content lives; a
generic component would hide the distinctions the audit exists to check.

## §18 Accessibility

### axe in the unit suite, humans for the rest (decided 2026-08-27)

`vitest-axe` (axe-core) runs over the rendered primary screens — home, space
library, reader, assistant, notes, notebook — in the existing frontend suite
with mocked `api.ts`, asserting no `wcag2a`/`wcag2aa` violations. The
keyboard walk, VoiceOver pass, and 320 px pass are done by hand in Chrome
once, findings become checkboxes, and each fix gets a role/focus test so the
finding cannot return silently. `@testing-library/user-event` (already present)
drives the keyboard tests.

*Rejected:* Playwright + `@axe-core/playwright` as the only a11y check. It
runs only against the full stack, so it would run rarely. *Rejected:* a
manual-only audit. It would be true for one afternoon.

*Cost:* axe on jsdom misses contrast (needs layout) and some focus-order
issues. Contrast is checked by hand once against `DESIGN.md`'s tokens.

### 320 px means no horizontal scroll and every control reachable (decided 2026-08-27)

The rail collapses (it already does below `md`), toolbars wrap, tables become
stacked rows, and the notebook's Research panel becomes a sheet. Nothing is
hidden; nothing is redesigned.

## §19 Performance

### Measure first; fix only misses (decided 2026-08-27)

Method per target, recorded with the number:

| Target | Method |
|---|---|
| Screens interactive ≤ 2.5 s p75 | Lighthouse (mobile, slow 4G) on `pnpm build` served by `vite preview`, 5 runs, TTI p75, per primary screen |
| Search ≤ 500 ms, 50 sources | seed script creates 50 manual sources; `GET /spaces/:id/sources?q=` timed server-side (`reply.elapsedTime`) over 20 queries, p95 |
| PDF ≤ 2 min p90 | 10 text PDFs 10–60 pages through the worker; `readyAt − createdAt` |
| Answer first token ≤ 8 s p75 | 20 questions; time to first SSE `delta` |
| Autosave ≤ 2 s | 20 notebook saves; `PUT` round-trip from the client's save timer |
| Note open does not reload notebook | already REQ-tested in Phase 6; re-verified by hand |

The seed script (`backend/scripts/seed-perf.ts`) is dev-only and idempotent.

*Rejected:* adding a metrics pipeline (OpenTelemetry, a dashboard). §19 says
"initial targets"; a number in the spec's Verification section is what the
PRD can be checked against. *Cost:* the numbers are one machine's, on one day.
The method is recorded so they can be re-taken.

## §17 Security

### A route-table test replaces per-spec faith (decided 2026-08-27)

`backend/test/ownership-table.test.ts` walks `app.printRoutes()` /
`app.routes` after `buildApp()` and asserts that every route whose URL
contains `/spaces/:id`, `/sources/:id`, `/notes/:id`, `/conversations/:id`,
or `/notebook` has `assertOwnership` (or `requireUser` for the two
user-scoped collections `/spaces` and `/activity`) in its hook chain; a new
route added without the guard fails the suite. The existing
`assert-ownership.test.ts` keeps proving the guard answers 404.

*Rejected:* a global `onRequest` hook that infers the resource from the URL.
It moves the guard out of sight of the route and guesses at parameter names.

### pino redaction of content fields (decided 2026-08-27)

`logger.redact` lists `req.body.content`, `req.body.contentRich`,
`req.body.text`, `req.body.title`, `req.body.question`, `req.body.password`,
`req.headers.cookie`, `req.headers.authorization`; the ingestion worker logs
lengths and ids, never text. A test builds the app with a capturing pino
destination and asserts a notebook `PUT` body does not appear.

*Cost:* debugging a malformed document from logs needs the `invalid_document`
path the error already returns, not the body. That is the point.

### HTTPS and encryption at rest are deployment requirements (decided 2026-08-27)

Neither is code in this repository: TLS terminates at the reverse proxy and
disk encryption belongs to the database and object-storage host.
`backend/README.md` gains a "Deploying" section stating both as requirements,
with `secure` cookies and `trustProxy` (already on in production) as the
code-side half. The spec's §17 verdict line for each says "deployment
requirement — see backend/README.md".

*Rejected:* application-level field encryption for source text and notebook
content. It breaks Postgres FTS and pgvector, which is the product.

### Secrets never reach the bundle (decided 2026-08-27)

A frontend test greps `dist/` after build (or, cheaper, asserts the only
`import.meta.env.VITE_*` keys in `src/` are the documented public ones) and
`backend/.env.example` is checked to hold no `VITE_` names. Provider keys are
read only in `backend/src/config.ts`.

## §21 End-to-end

### Playwright, local stack, one ordered spec (decided 2026-08-27)

`e2e/` at the repo root, `@playwright/test`, Chromium only, `pnpm e2e`
requiring `docker-compose up`, the backend, the worker, the Vite dev server,
Ollama, and a configured answer provider. One `mvp-scenario.spec.ts` walks
§21's twenty-one steps in order with a fresh account per run (timestamp
suffix), a small text PDF fixture, a fixture URL served by Playwright's own
static server (no network dependency for the web source), and a manual text
source. The assistant steps assert shape — a streamed answer, ≥ 1 citation,
the insufficient-evidence path on an off-topic question — never wording.
Playwright's own `webServer` is not used; the stack is assumed running so the
spec stays a test and not an orchestrator.

*Rejected:* a fake answer provider so E2E can run in CI. Worth doing, but it
is a provider-tier change ([[../assistant-provider-tiers/design]]) with its
own decisions; recorded as future work. *Rejected:* recording the hand walk
as the only E2E. It was the plan for six phases and produced "not looked at
in a browser" three times.

*Cost:* the suite is not in CI and needs a real provider (a few cents per
run). It is run before closing this phase and before any release.

### The hand walk is still done once (decided 2026-08-27)

Playwright asserts; a person notices. The same twenty-one steps are done by
hand in Chrome with screenshots, and anything odd — copy, spacing, a focus
ring missing, a state that flashes — becomes a checkbox or an implementation
note. This is the browser pass three phases have owed.

## Open questions

- `Activity` retention. Nothing purges rows; at one entry per source event and
  coalesced note edits, a heavy user writes a few thousand rows a year. Fine
  for the MVP; revisit if the home query slows.
- Whether `space.archived` / `space.restored` deserve entries. §15 does not
  list them; left out.
