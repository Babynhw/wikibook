---
title: Home & activity — spec
kind: spec
status: current
sources:
  - PRD §3 (resume), §15 (home and recent activity), §16 (states), §17 (security), §18 (a11y), §19 (performance), §21 (acceptance scenario)
  - backend/src/routes/activity.ts, backend/src/routes/notes.ts, backend/src/app.ts, backend/src/middleware/assert-ownership.ts
  - backend/test/activity.test.ts, backend/test/ownership-table.test.ts, backend/test/redaction.test.ts
  - frontend/src/routes/home-page.tsx, frontend/src/features/activity/, frontend/src/lib/relative-time.ts, frontend/src/components/relative-time.tsx
  - frontend/src/routes/home-page.test.tsx, frontend/src/lib/relative-time.test.ts, frontend/src/lib/public-env.test.ts
  - frontend/src/a11y.test.tsx, frontend/src/a11y-interactions.test.tsx
  - e2e/mvp-scenario.spec.ts, backend/scripts/seed-perf.ts, backend/scripts/measure-search.ts
created: 2026-08-27
updated: 2026-08-28
tags: [home, activity, security, accessibility, performance, spec]
---

# Spec: Home & activity

The home screen (PRD §15): the user's active spaces with their counts and
last-updated times, the most recently opened space one click away, and one
feed of recent activity across every space, newest first, each entry opening
the thing it names. This spec also holds the Phase 7 hardening results — the
§16 state matrix, the §17 checklist, the §18 audit, the §19 numbers, and the
§21 run — because they are properties of the whole product and belong to no
single capability. Written from the Phase 7 implementation
([[../../plan/phase-7-home-and-hardening/proposal]]). MUST / MUST NOT / SHOULD
/ MAY are RFC 2119.

## Scope

Covers `GET /activity`, the two activity writers Phase 7 added, the home page's
composition, and the cross-cutting audits. Does not cover the space list's own
behavior (create, rename, archive, resume marker — [[../spaces/spec]]), nor
the writers other phases own: `space.created` (REQ-056), `source.added` /
`source.ready` / `source.failed` ([[../ingestion/spec]]), `note.saved_answer`,
`note.created`, `note.deleted`, `note.edited`, `note.converted`
([[../notes/spec]] REQ-210–212, REQ-271–274), `notebook.exported`
([[../export/spec]] REQ-260).

## The feed (PRD §15)

### REQ-263 — One feed per user, newest first

`GET /activity` MUST return the signed-in user's `Activity` rows ordered by
`createdAt` descending, then `id` descending, and MUST require a session
(401 otherwise). It MUST NOT take a space id: the feed is the user's, across
all their spaces.

> [!note] Shared spaces v1 (2026-08-28)
> The Home feed adds membership rows that are *about* the caller, items carry
> `actor`, six `member.*`/transfer kinds link to the members page, and a second
> feed — `GET /spaces/:id/activity`, every member's actions with the actor
> named — reuses this shape ([[../sharing/spec]] REQ-295–REQ-296). Home splits
> "My spaces" from "Shared with me" only when something is shared (REQ-300).

### REQ-264 — No other user's activity is ever returned

The query MUST filter on the session user's id and nothing else. A second
user's rows, in a space the first user cannot see, MUST NOT appear (PRD §15
acceptance).

### REQ-265 — Cursor pagination, no skip and no repeat

`?limit=` MUST be clamped to 1–50 (default 20). The response MUST carry
`nextCursor` — `<createdAt ISO>_<id>` of the last row — when more rows exist,
`null` otherwise. Passing it back MUST continue from exactly the next row even
when rows were inserted between the two requests.

- GIVEN 25 rows and a page of 10
- WHEN a new row is inserted, then the second page is requested with the cursor
- THEN the second page begins with the row after the first page's last, and
  no row appears twice

A malformed cursor MUST answer 400 `invalid_cursor`.

### REQ-266 — Every entry carries its link, resolved by kind

Each item MUST be `{ id, kind, createdAt, space, target, href }` where `space`
is `{ id, name, archivedAt }` or `null`, `target` is
`{ type: space|source|note|notebook, id, title }` or `null`, and `href` follows:

| kind | href |
|---|---|
| `space.created` | `/spaces/:spaceId` |
| `source.added` · `source.ready` · `source.failed` | `/spaces/:spaceId/sources/:refId` |
| `note.saved_answer` · `note.created` · `note.edited` · `note.converted` | `/spaces/:spaceId/notes?noteId=:refId` |
| `note.deleted` | `/spaces/:spaceId/notes` |
| `notebook.exported` | `/spaces/:spaceId/notebook` |

Titles MUST be the target's *current* title, resolved at read time with one
query per target type per page — nothing is denormalised onto the row.

### REQ-267 — A deleted target degrades to the space, not to nothing

When the row's target no longer exists, `target` MUST be `null` and `href`
MUST fall back to `/spaces/:spaceId`. The entry MUST still be returned: the
feed is a record of what happened, and "source added, then deleted" reads
better than a gap. When the space itself is gone, `space` and `href` are `null`.

### REQ-268 — An archived space stays linkable

An entry in an archived space MUST keep its `href`; archived spaces are
read-only (REQ-065), not hidden. `space.archivedAt` is set so the client may
say so.

### REQ-269 — Cursor validation

(Folded into REQ-265: malformed → 400 `invalid_cursor`. Id kept for the test
that names it.)

### REQ-270 — Authentication

(Folded into REQ-263: no session → 401. Id kept for the test that names it.)

## The home page (PRD §15, §3)

### REQ-275 — The most recently opened space is one click away

When the Active filter is shown and the first space in the list has a
`lastOpenedAt`, the client MUST render a "Continue" region named by that
space, carrying its source count, note count, and "updated <relative time>",
with an "Open space" link to `/spaces/:id`. When no space has been opened
yet, no card is shown — the list's own empty state speaks.

### REQ-276 — The feed panel renders entries as links, newest first, with Load more

The client MUST render the feed as a region named "Recent activity", an
ordered list, one entry per item in server order, each a link to `href`
carrying a plain-language line for the kind and the target's title, the
space's name, and a `<time dateTime>` with the relative time. An entry whose
`target` is `null` MUST read as such ("an item that has since been deleted"),
greyed, still linking to the space. The client requests eight entries per page and, beside the space list, keeps
the list inside a fixed-height scrolling region so the panel never outgrows
the page. A "Load more" control MUST appear while `nextCursor` is set, append
the next page, and disappear when it is `null`.

### REQ-277 — The panel's states are its own

Loading, empty ("Nothing yet…"), and error states MUST belong to the panel: a
failed feed MUST NOT unmount or block the space list, its message MUST be the
API's `ApiError.message` or a plain fallback, and its "Try again" MUST refetch
only the feed. The feed MUST be refetched whenever the home page mounts, so
returning to `/` after an action shows it. Below the `lg` breakpoint the panel
MUST stack under the list, never be hidden.

### REQ-278 — Relative time is relative inside a week and a date beyond it

`formatRelative` MUST produce "just now" under a minute, `Intl.RelativeTimeFormat`
minutes / hours / days (so "yesterday") under a week, and an absolute
month-day (with the year when it differs) beyond. The `<time>` element MUST
carry the ISO instant in `dateTime` and the full timestamp in `title`. Space
rows and the Continue card use the same element.

### REQ-316 — Changing a space's audience note is on the feed

Setting or clearing `Space.audienceInstruction` MUST write one
`space.audience_changed` row, attributed to the owner and linking to the space,
visible on the space activity tab to every member. The row and the note MUST be
written in one transaction, and a save that leaves the note unchanged MUST write
no row. The row records **that** it changed, not what to — the current text is on the space page for everyone anyway,
and no other settings field here keeps a history.

> It changes what every member reads, from a screen only one person can open. A
> member who notices the assistant's voice change should be able to find out why.

## Security (PRD §17)

### REQ-279 — Every parameterised route is guarded, structurally

Every route whose URL contains a path parameter MUST register a guard created
by `assertOwnership` (in `preHandler`), and every non-public route without a
parameter MUST register `requireUser`. This is proven by walking the route
table as the app registers it (`buildApp({ onRoute })`), not by each suite
remembering to. The public set is exactly `/health` and `/auth/{register,
login, forgot, reset, logout}`.

### REQ-280 — Logs never carry content or credentials

The logger MUST redact `body.{content,contentRich,text,title,question,password,
token}`, the same under `req.body`, and `headers.cookie` /
`headers.authorization` under both `headers` and `req.headers`. A handler that
logs `{ body, headers }` MUST produce a line with `[Redacted]` and none of the
values; the default request log MUST carry method and URL and no body.

### REQ-281 — Nothing secret reaches the bundle

The frontend source MUST read no `import.meta.env.VITE_*` key outside a
documented allow-list; today the list is empty (the API is same-origin under
`/api`). Provider keys are read only in `backend/src/config.ts`.

### §17 checklist

| PRD §17 bullet | Verdict |
|---|---|
| HTTPS in production | Deployment requirement — `backend/README.md` "Deploying"; `secure` cookies and `trustProxy` follow `NODE_ENV=production` (`plugins/session.ts`, `app.ts`) |
| Encryption at rest | Deployment requirement — same section; field-level encryption rejected because it breaks FTS and pgvector |
| Ownership on every space/source/conversation/note/notebook request | REQ-279 (`ownership-table.test.ts`), 404-not-403 in `assert-ownership.test.ts` (REQ-040s) |
| Uploaded files validated | [[../ingestion/spec]] — MIME and size checked while streaming, before processing |
| No cross-user retrieval | `retrieval-scope.test.ts`, `retrievableSources()` ([[../assistant/spec]]) |
| Notes excluded from retrieval unless converted | same |
| Secrets never in the browser | REQ-281 |
| Permanent delete removes file, text, index, citations | [[../ingestion/spec]] permanent-delete requirement, `sources.test.ts` |
| Logs without content | REQ-280 |

## Verification

Verified 2026-08-27 against Postgres and Redis via docker compose; the API,
worker, Vite dev server, Ollama, and answer provider were **not** running, which
bounds what follows.

**Automated.** `backend/test/activity.test.ts` names REQ-263–270;
`backend/test/notes.test.ts` REQ-271–274; `backend/test/ownership-table.test.ts`
REQ-279; `backend/test/redaction.test.ts` REQ-280;
`frontend/src/routes/home-page.test.tsx` REQ-275–277;
`frontend/src/lib/relative-time.test.ts` REQ-278;
`frontend/src/lib/public-env.test.ts` REQ-281. `frontend/src/routes/space-page.test.tsx` guards the add-source dialog fix. Suite totals are in
[[../../plan/phase-7-home-and-hardening/tasks]] implementation notes.

**Mutation checks.** REQ-273: before the sorted-key compare every save wrote a
row (jsonb reorders keys) — the test failed, then passed with `canonicalJson`.
REQ-267: the first version of the test expected a deleted note to keep its
`?noteId=` link; the design says space link only, and the route agreed. REQ-279:
the route-table test caught `OPTIONS *` (cors preflight) and `POST
/auth/logout`, both correctly public and now listed.

### §16 state matrix

| State | Renders in | Test that names it | Content kept | Retry |
|---|---|---|---|---|
| No research spaces | `routes/home-page.tsx` | `home-page.test` "explains the empty state" (REQ-070) | n/a | n/a |
| Empty source library | `routes/space-page.tsx` | `space-page.test`, `source-search.test` | n/a | n/a |
| Source processing | `sources/source-state-badge.tsx`, `reader/source-reader.tsx` | `source-list.test`, `source-reader.test` "explains a processing source" | n/a | n/a — progress, announced |
| Source processing failure | `sources/source-list.tsx`, `reader/source-reader.tsx` | `source-list.test` "shows the failure message with a Retry action" | n/a | guarded by source state |
| No source search results | `routes/space-page.tsx` | `source-search.test` | query kept | n/a |
| No conversations | `assistant/conversation-list.tsx` | `conversation-list.test`, `assistant-page.test` | n/a | n/a |
| No relevant evidence | `assistant/answer-message.tsx` | `assistant-pane.test` "renders an ungrounded answer as an insufficiency answer" | question kept | rephrase, not Retry |
| Assistant request failure | `assistant/assistant-pane.tsx` | `assistant-pane.test` "keeps the question and offers Retry", "§16 refusal message"; `assistant-page.test` "keeps the question…" | question + scope kept | safe — no answer stored |
| No saved notes | `notes/note-list.tsx`, `notebook/panel/research-panel.tsx` | `notes-page.test` "renders empty notes state" | n/a | n/a |
| Note save failure | `notes/note-viewer.tsx`, `notes/create-note-dialog.tsx`, `assistant/answer-message.tsx` | `note-viewer.test` (REQ-211), `notes-page.test` (REQ-210), `assistant-pane.test` "surfaces a save failure" | title + body kept | Save again — CAS on the server |
| Notebook save failure | `notebook/save-status.tsx`, `use-autosave.ts` | `notebook-editor.test` 500/401/400/409 cases (REQ-251/252) | draft kept locally | backoff + Retry, CAS |
| Export failure | `notebook/export-menu.tsx` | `export-menu.test` "a failed copy shows the envelope message with Retry" (REQ-261) | n/a | safe — GET |

Every error row renders `ApiError.message` (the server's plain-language
envelope, which the error handler already strips of stack and provider text)
or a plain fallback. Gaps found and closed this phase: the note viewer's and
the create-note dialog's failure paths existed but no test named them —
both now do.

### §18 accessibility

Automated, 2026-08-27: `frontend/src/a11y.test.tsx` runs axe (`wcag2a`,
`wcag2aa`, `best-practice`) over home, the space library in all four source
states, the reader, the assistant hub and a cited thread, notes with the
drawer open and with the New Note dialog, and the notebook with its Research
panel — zero violations, no rule suppressed. `a11y-interactions.test.tsx`
proves Escape-closes and focus-returns for all nine dialogs and the note
drawer, and the live regions for source processing, notebook save, note save,
and assistant streaming.

Found and fixed by the audit: `autoFocus` on three dialogs' first field fired
before the dialog recorded its opener, so Escape dropped focus to `<body>`
(removed — the dialog focuses its first control itself); the note drawer had
no Escape and no focus management; note save had no live region; the
assistant's stale citation marker was colour-only; the rail sat outside every
landmark; the notes page nested a second `<main>`; heading order skipped h1→h3
on three screens; several rows could not wrap at 320 px (app header email,
note card footer, note viewer header, archived banner, research-panel citation
row, scope `<select>`).

> [!warning] Not verified in a browser
> Contrast, the keyboard walk, the VoiceOver pass, and the rendered 320 px
> check were done by class review only — axe in jsdom cannot compute contrast
> and no browser was driven at close. These remain the Phase 7 hand-walk debt.

### §19 performance

Measured 2026-08-27 against the API on `:4000` with Postgres, Redis, and
Ollama running, on the seeded "Perf — 50 sources" space
(`backend/scripts/seed-perf.ts`, 50 ready manual sources with real
embeddings): **source search p50 8.3 ms, p95 12.4 ms, max 13.8 ms** over 20
distinct queries (`backend/scripts/measure-search.ts`, HTTP round-trip on
localhost, one warm-up excluded) — against a 500 ms target.

> [!warning] Five targets not measured
> Screens-interactive (Lighthouse), PDF corpus p90, answer first-token p75,
> autosave round-trip, and the by-hand note-open check were not taken: they
> need a browser session and a working answer provider, and the configured
> gateway answered 401 at close. The method for each is in
> [[../../plan/phase-7-home-and-hardening/design]] "§19 Performance"; the
> only target with a test is REQ-253 ([[../notebook/spec]]).

### §21 end-to-end

`e2e/mvp-scenario.spec.ts` (Playwright, Chromium, `pnpm e2e`, local stack —
`e2e/README.md`) walks the twenty-one steps in order with a fresh account.
Run 2026-08-27: steps 1, 2, 3, 5, 7 pass against the live stack; 4 and 6 skip
(the worker's SSRF guard rejects every address a fixture server can bind on a
LAN-only host); step 8 timed out waiting for the first answer (provider
gateway 401 — environment) and 9–21 did not run.

> [!warning] Not complete
> Thirteen steps are unverified against the live stack and the hand walk in
> Chrome was not done. The walk that did run found and fixed a real bug: the
> first source added to an empty library left a blank Add dialog open. It also
> surfaced a §16 gap left open — an answer that never streams shows a spinner
> past `ANSWER_TIMEOUT_MS` instead of the failure state.

## Cross-references

- [[../../plan/phase-7-home-and-hardening/proposal]] · [[../../plan/phase-7-home-and-hardening/design]] · [[../../plan/phase-7-home-and-hardening/tasks]]
- [[../spaces/spec]] — REQ-056 (`space.created`), REQ-065 (archived is read-only), REQ-070 (no-spaces state)
- [[../notes/spec]] — REQ-271–274, the writers this feed reads most
- [[../ingestion/spec]] · [[../export/spec]] — the other writers
- [[../auth/spec]] — `ApiError`, the envelope every §16 row renders
