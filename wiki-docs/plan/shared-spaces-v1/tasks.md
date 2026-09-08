---
title: Shared spaces v1 — tasks
kind: plan
status: done
created: 2026-08-28
updated: 2026-08-28
tags: [post-mvp, sharing, members, roles, ownership, activity, notebook, tasks]
---

# Tasks: Shared spaces v1

Work split by codebase; decisions are in [[design]]. Order: migration and
guard first (everything else is gated on `assertAccess` and `myRole`), then
membership routes, then actors and activity, then conversations and resume,
then presence, then the frontend in the same order, then the two-user E2E.
Every existing suite must stay green after the guard rename — that is the
proof the widening changed nothing for a solo owner.

## Backend

### Migration — `backend/prisma/`

- [x] `enum SpaceRole { owner editor viewer }`; `SpaceMember` per [[design]]
      with `@@id([spaceId, userId])`, `@@index([userId, lastOpenedAt])`
- [x] `SpaceInvite` per [[design]]; `@@unique([spaceId, email])`,
      `tokenHash @unique`
- [x] `Source.addedById`, `Note.authorId`, `Conversation.userId`,
      `Notebook.updatedById` — `String?`, relation to `User`, `onDelete: SetNull`
- [x] Drop `Space.lastOpenedAt`
- [x] Data steps in the same migration: one `owner` row per space copying
      `lastOpenedAt`; every actor column ← `space.ownerId`
- [x] Migration comment states the reverse path (restore `lastOpenedAt` from
      the owner row)
- [x] `members_per_space` in `APP_CONFIG_DEFAULTS` (default 5);
      `INVITE_TTL_HOURS` in env schema (default 168)

### Access guard — `backend/src/middleware/assert-ownership.ts` → `assert-access.ts`

- [x] Resolvers return `spaceId` (same eight queries, `select` one level
      shallower); `conversation` and `message` resolvers also return `userId`
- [x] `assertAccess(resource, param, minRole = 'viewer')`: no membership → 404;
      role below → 403 `insufficient_role`; conversation/message owned by
      another member → 404
- [x] Guard carries `minRole` as a property; `ownershipGuards` registry kept
      (now a `WeakMap` guard → role)
- [x] `lib/errors.ts` gains `forbidden(code, message)`; error handler emits it
      with the same envelope as the others
- [x] Every existing route call site renamed with the role from the table
      below; `requireUser`-only routes (`/spaces`, `/activity`) unchanged
- [x] `test/ownership-table.test.ts`: every write method under a space carries
      `editor` or `owner`; `GET /spaces/:id/members` and invite routes listed
      explicitly; the walk fails on a new route without a guard

Route roles (the table the test asserts):

| route | role |
|---|---|
| `GET` anything under a space, `/spaces/:id/events`, export, print | viewer |
| `POST /spaces/:id/sources`, `PATCH /sources/:id`, archive/restore/retry | editor |
| `DELETE /sources/:id` | editor + `addedById === me` or owner (in-route) |
| `POST /notes`, `PATCH/DELETE /notes/:id`, save-answer, convert | editor |
| `PUT /spaces/:id/notebook`, presence | editor |
| `PATCH /spaces/:id` (name, objective) | editor |
| archive/restore/`DELETE /spaces/:id` | owner |
| `/spaces/:id/members*`, `/spaces/:id/invites*`, `/spaces/:id/transfer` | owner (list: viewer) |
| `POST /spaces/:id/leave` | viewer (any non-owner member) |
| `POST /conversations`, `/conversations/:id/*` | viewer + `userId === me` |

### Spaces — `backend/src/routes/spaces.ts`

- [x] `POST /spaces` creates the `owner` member row in the same transaction
- [x] `GET /spaces` filters `members.some.userId`; orders by my
      `SpaceMember.lastOpenedAt`; returns `myRole`, `ownerName`
- [x] `GET /spaces/:id` returns `myRole`
- [x] `POST /spaces/:id/open` stamps my member row
- [x] Tests: solo owner sees identical payload plus `myRole: 'owner'`; a
      member's ordering is independent of another member's opens

### Membership — `backend/src/routes/members.ts` (new)

- [x] `GET /spaces/:id/members` — members with role, name, joined; pending
      invites (email, role, expiresAt) for the owner only
- [x] `POST /spaces/:id/invites { email, role }` — owner; refuse existing
      member (409 `already_member`), pending invite (409 `invite_pending`), at
      cap (409 `members_limit`, limit stated), role `owner` (400); token
      generated, hashed, URL returned once; `member.invited`
- [x] `POST /spaces/:id/invites/:inviteId/rotate` — new token, same row, URL
      returned; `DELETE /spaces/:id/invites/:inviteId` — revoke
- [x] `GET /invites/:token` — `requireUser`; neutral 404 unless valid, unused,
      unexpired, unrevoked and `email === me`; returns space name, role,
      inviter name (for the accept page)
- [x] `POST /invites/:token/accept` — same checks; transaction: `acceptedAt`,
      member row, `member.joined`; idempotent if already a member
- [x] `PATCH /spaces/:id/members/:userId { role }` — owner; not self; not
      `owner` (use transfer); `member.role_changed`
- [x] `DELETE /spaces/:id/members/:userId` — owner; not self; transaction:
      delete member row, delete their conversations in the space,
      `member.removed`
- [x] `POST /spaces/:id/leave` — any non-owner member; same cleanup;
      `member.left`
- [x] `POST /spaces/:id/transfer { userId }` — owner; target is editor;
      transaction per [[design]]; `space.ownership_transferred`
- [x] Tests — `test/members.test.ts`: the whole lifecycle; wrong-account
      accept is the same 404 as expired; cap read from `AppConfig` at request
      time; removal → next request 404 and conversations gone, notes/sources
      remain with author; transfer leaves exactly one owner row and
      `Space.ownerId` agreeing; owner self-remove/demote/leave refused

### Actors

- [x] `routes/sources.ts`: set `addedById` on create; `DELETE` rule (own or
      owner); list/detail payload gains `addedBy: { id, name } | null`
- [x] `routes/notes.ts`: `authorId` on create and save-answer; convert copies
      the converter as `addedById`; payload gains `author`
- [x] `routes/notebook.ts`: `updatedById` on save; read and 409 payload gain
      `updatedBy`
- [x] `ingest/pipeline.ts`: activity `userId` ← `source.addedById` (fallback
      `ownerId` when null)
- [x] Tests: each payload names the actor; pipeline attributes to the adder;
      editor deleting another's source → 403, own → 204, owner → 204

### Conversations — `backend/src/routes/conversations.ts`

- [x] `userId` on create; list filters `userId = me`; resolver 404 for another
      member's conversation or message
- [x] Retrieval untouched — the guard and list filter are the only changes;
      `retrievableSources()` has no member filter (asserted by the unchanged
      retrieval suites plus the viewer reading the editor's source live)
- [x] Save-answer from a private conversation creates a shared note with
      `authorId = me` (`notes.test.ts` fixtures now name the thread's member)

### Activity — `backend/src/routes/activity.ts`

- [x] `GET /spaces/:id/activity` — viewer; `spaceId` filter; items gain
      `actor`; same cursor and resolver; `user` target type for `member.*`
- [x] `GET /activity` — `userId = me OR (refId = me AND kind LIKE 'member.%')`
      (plus `space.ownership_transferred` about me)
- [x] Labels and `href` for the six new kinds
- [x] Tests: space feed shows every member's rows with actor; Home feed shows
      "you were added" but not another member's source adds

### Presence — `backend/src/routes/notebook.ts`

- [x] `POST /spaces/:id/notebook/presence` (editor) — Redis sorted set,
      `NOTEBOOK_PRESENCE_TTL_SECONDS` (30), publish `notebook.presence` with the
      current set on `space:{id}`; `DELETE` clears and publishes;
      `rateLimit: false` like `/events`
- [x] `events.ts` guard → `assertAccess('space','id','viewer')`; forwards the
      new event type unchanged
- [x] Tests: heartbeat publishes the set; two editors → two names; a viewer
      heartbeat → 403; `DELETE` removes (TTL expiry not waited for — see notes)

## Frontend

### API and role plumbing

- [x] `api.ts` types: `myRole`, `ownerName`, `memberCount`, `addedBy`,
      `author`, `updatedBy`, members/invites/activity payloads; `membersApi`,
      presence calls, `activityApi.listForSpace`
- [x] `useSpaceRole()` reading `space.myRole`; `canEdit`, `isOwner`,
      `isViewer`; `canEditSpace()` for non-hook sites
- [x] Every write affordance previously gated on `archivedAt` gated on
      `canEdit` through the same condition (rail Add Source REQ-237, library
      Add/archive/edit, notes create/edit/delete/convert, save-answer,
      notebook `editable`, reader actions, space edit); tests per surface

### Members — `routes/members-page.tsx`, `/spaces/:spaceId/members`

- [x] List with role badges; owner controls: role select, remove (confirm
      names the conversation loss), transfer (confirm)
- [x] Invite dialog: email + role; on success the link shown with Copy and
      "shown once — copy from Pending later regenerates it"
- [x] Pending list: email, role, expires, Copy (rotate), Revoke
- [x] Leave button for non-owners (confirm)
- [x] Rail item "Members" below Notebook, all roles (and "Activity")
- [x] Tests: axe pass (roster + dialog); 409 `members_limit` rendered beside the
      form with the typed email kept; remove confirm; non-owner leave

### Accept — `routes/invite-page.tsx`, `/invite/:token`

- [x] Signed out → login with `from`; signed in → shows space, role, inviter;
      Accept → navigate to the space
- [x] Every failure → one neutral "This invite link isn't valid" page
- [x] Tests: the three states; the token is never fetched while signed out

### Home — `routes/home-page.tsx`

- [x] "My spaces" / "Shared with me" sections; role badge + `ownerName` on
      shared rows; Active/Archived tabs apply to both; solo owner sees the one
      flat list unchanged
- [x] Continue card unchanged in shape (per-member ordering comes from the API)
- [x] Feed renders `member.*` labels with the actor
- [x] Tests: sections; editor may edit details but not archive

### Attribution and "new since last visit"

- [x] Library cards say `added … by Name` / `by you`; reader header the same;
      note cards `by Name` / `by a former member`
- [x] New-since-last-visit marker on sources where
      `createdAt > my previous lastOpenedAt` and someone else added it; text,
      not a dot (§18)
- [ ] ~~The same marker on notes~~ — not built; see implementation notes
- [x] Space activity tab `/spaces/:spaceId/activity` reusing the Phase 7 feed
      panel with an actor prefix

### Conversations

- [x] Hub lists only mine (API does the filtering); a 404 on another member's
      id renders the existing not-found state

### Notebook presence — `features/notebook/`

- [x] `usePresence(spaceId, editing)`: initial GET, `notebook.presence` over
      the space SSE stream, heartbeat every 10 s while editing, `DELETE` on
      unmount
- [x] Others present on first answer → editor read-only with "Edit anyway";
      choosing it flips `editable` and starts heartbeating
- [x] Header shows "Name is editing" in a live region that changes only with
      the set
- [ ] ~~Presence text on the rail's Notebook item~~ — not built; see notes
- [x] Conflict message shows `updatedBy.name` and the save time
- [x] Tests: read-only when present; Edit anyway; heartbeat POST and unmount
      DELETE; viewer sees no toolbar and an explanation

## E2E — root `e2e/`

- [x] `shared-space.spec.ts` with three browser contexts: owner creates and
      invites; a stranger's visit to the link is the neutral page; the editor
      registers through the link and accepts once; adds a manual source that
      everyone sees attributed, with the owner's new-since marker; the viewer
      accepts, sees no write control, a forged `POST` is 403; presence — the
      owner reads, steps in with Edit anyway, both save, the loser gets the
      named conflict and Reload; the space feed names actors while Home stays
      personal; the owner removes the editor → 404, source kept; the viewer
      leaves. **10/10 live, 2026-08-28.**

## Wiki (on close)

- [x] `specs/sharing/spec.md` — REQ-282–REQ-304
- [x] `> [!note] Shared spaces v1` callouts in `auth` (REQ-040), `spaces`
      (REQ-059/063/065/067), `ingestion` (`source.ready` writer), `notes`
      (REQ-210), `notebook` (REQ-244), `assistant` (REQ-170), `home-activity`
      (REQ-263)
- [x] `backend/README.md`, `backend/CLAUDE.md`, `frontend/README.md`, root
      `CLAUDE.md`: `assertAccess` replaces `assertOwnership`; the 404/403 rule
- [x] `e2e/README.md` names the second spec
- [x] `index.md` row → done; `log.md` `update` + `create`

## Exit criteria

- [x] Migration applied to a database with existing spaces: 61 spaces → 61
      owner rows, every actor column filled, no `lastOpenedAt` on `Space`,
      `prisma migrate diff` reports no drift.
- [x] Every pre-existing test passes with only the guard's name changed at
      call sites (and `userId` on three conversation fixtures that bypass the
      API) — a solo owner's behaviour is unchanged except for the new fields.
- [x] `ownership-table.test.ts` fails when a write route is registered as
      `viewer` outside the allowance (asserted structurally over the live
      route table).
- [x] The proposal's acceptance criteria each map to a named test or to a step
      in `shared-space.spec.ts`; the Playwright scenario passes against the
      local stack (10/10).
- [x] Backend and frontend lint/build clean; backend 275 → 307, frontend
      260 → 279.
- [x] The retrieval-eligibility invariant is untouched: the retrieval suites
      pass unchanged and step 06 of the e2e has a viewer reading an editor's
      source.

## Review fixes (2026-08-28)

`/review-code` over the uncommitted diff found four defects. Each fix has a
test, and each test was **mutation-checked** by reverting exactly its fix and
confirming only that test fails.

- [x] 🔴 **The invite token was written to the log.** It travels in the URL and
      Fastify logs `req.url` on every request; `REDACT_PATHS` covers body fields
      and headers, and pino's paths cannot address a substring of a value. Added
      `scrubUrl` plus a custom `req` serialiser (`app.ts`), so the path logs as
      `/invites/[Redacted]` while every other id survives. REQ-305;
      `redaction.test.ts`. Reverting `scrubUrl` puts the token back in the
      `incoming request` line.
- [x] 🟠 **The member cap was a read-then-write.** The counts moved inside the
      invite transaction behind `SELECT … FOR UPDATE` on the space row. The
      mutation check is the interesting one: with the counts inside the
      transaction but the lock removed, **five of five** concurrent invites are
      still granted against two seats — the transaction alone enforces nothing,
      the lock is what does. REQ-285; `members.test.ts`.
- [x] 🟠 **Presence never cleared for a watcher.** Only `POST`/`DELETE`
      published, so an entry that aged out (a crashed tab) was pruned silently
      and a member who was reading rather than typing kept seeing the name.
      `readPresence` now reports how many entries it pruned and the read
      publishes when that is non-zero. REQ-306; `members.test.ts`.
- [x] 🟠 **A Redis blip 500'd a notebook route.** `app.redis` runs with
      `enableOfflineQueue: false`, so a momentary failure rejected and escaped;
      everywhere else Redis is optional. All three presence routes now answer
      "nobody is editing" through `withPresenceFallback` and recover on the next
      request. REQ-307; `members.test.ts`.
- [x] 🟢 Same block: the set is sorted **by name**. The comment claimed Redis
      insertion order kept the indicator stable, but the score is the last
      heartbeat, so the order churned every few seconds.

Backend 307 → 312, lint clean, two consecutive full-suite runs green.

Left from the review, not fixed here (each is its own small change):
`activity.ts` still names a space to a member who was removed from it;
`use-presence.ts` opens a second `EventSource` and does not reconnect after an
error; `addedBy?:` is optional in the client type only so older fixtures
compile; `request.access` is optional-plus-`!` rather than decorated.

## Implementation notes (2026-08-28)

Deviations from [[design]] and things a later phase must know.

- **Presence on the rail item was not built.** The design put "Minh is
  editing" on the rail's Notebook item as well as the page header. The rail
  renders on every space route and has no space-wide event subscription; giving
  it one would open a second `EventSource` per tab against
  `SSE_MAX_CONNECTIONS_PER_USER` (3). The header of the notebook page — the
  only place the signal changes what you do — carries it, in a live region.
- **"New since your last visit" marks sources only, not notes.** The baseline
  is my `lastOpenedAt` *before* this visit stamps a new one, which only the
  space page has (it is the page that stamps). The notes page has no baseline
  to compare against without an extra request; deferred.
- **The yield decision is optimistic.** The editor opens editable and steps
  back to read mode only if the *first* presence answer names someone else;
  a name arriving later does not flip it. The design implied "decide before
  enabling", which made a solo owner see a read-only flash and broke the ⌘B
  test (an uneditable ProseMirror does not receive the keydown). Two people who
  both open within the same ~100 ms both edit — exactly today's behaviour,
  minus the surprise.
- **Presence storage is a Redis sorted set scored by timestamp** rather than
  one key per user, so one `ZREMRANGEBYSCORE` expires stale entries on every
  read; the key itself expires at 2 × TTL. The TTL path is exercised by the
  code on every read but not asserted by a 30 s wait.
- **`member.invited`'s `refId` is the invite id** (resolving to the email),
  not a user id — the invitee has no account yet. Every other membership kind
  carries the member's user id and resolves to a `user` target.
- **Invite `upsert` on `(spaceId, email)`** reuses an expired or revoked row
  for the same address rather than answering 409; only a *pending* one is a
  409 `invite_pending`.
- **The Home feed also includes `space.ownership_transferred` about me**, not
  only `member.%` — a transfer is the membership event that most needs to reach
  the person it happened to.
- **`GET /spaces` is a query over `SpaceMember`** (ordered by my
  `lastOpenedAt`) selecting the space, because Prisma cannot order a parent by
  a filtered child relation. `spaceSelectFor(userId)` filters `members` to my
  row so one query returns the space, `myRole`, and my resume stamp.
- **The `ownership-table` test carries two allowances**: viewer writes
  (`open`, my conversations and feedback, `leave`) and token-scoped routes
  (`/invites/:token`, `/accept`) that have no space to assert membership on
  and carry `requireUser` plus the email match instead.
- **E2E finding, not a bug**: the SPA stamps `lastOpenedAt` from an effect a
  beat after render. A test that navigates away in the same instant aborts
  the request — a person never does — so the steps that rely on the stamp wait
  for the `/open` response. Recorded in [[../../specs/sharing/spec]].
- **Frontend fixtures**: `Space` gained three required fields, patched into
  every test fixture; the actor fields on `Source`/`Note`/`Notebook` are
  optional in the TS type (`addedBy?: Actor | null`) so fixtures written
  before sharing still type-check — the server always sends them.
- **Not looked at by hand in a second browser**; Playwright ran on Chromium.
  The Chrome extension was not used for this phase; the e2e run's screenshots
  (kept under `e2e/test-results/` on failure) were the visual check.
