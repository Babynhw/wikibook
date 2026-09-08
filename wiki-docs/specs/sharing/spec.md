---
title: Sharing — spec
kind: spec
status: current
sources:
  - PRD §17 (ownership, disclosure), §20 (exclusions — amended by plan/shared-spaces-v1)
  - backend/src/middleware/assert-access.ts
  - backend/src/routes/members.ts, spaces.ts, activity.ts, notebook.ts
  - backend/prisma/migrations/20260828120000_shared_spaces_v1/migration.sql
  - frontend/src/features/spaces/use-space-role.ts, frontend/src/features/members/
  - frontend/src/routes/members-page.tsx, invite-page.tsx, space-activity-page.tsx
  - frontend/src/features/notebook/use-presence.ts
  - e2e/shared-space.spec.ts
created: 2026-08-28
updated: 2026-08-28
tags: [sharing, members, roles, invites, presence, spec]
---

# Spec: Shared spaces

Membership, roles, invites, actors, private conversations, per-member resume,
the space feed, and advisory notebook presence — written from the
implementation verified at the close of
[[../../plan/shared-spaces-v1/tasks|Shared spaces v1]], the first post-MVP
change. PRD §20's *Shared spaces* and *Team roles* exclusions are lifted by
[[../../plan/shared-spaces-v1/proposal|that proposal's amendment]]; *Real-time
collaboration* stays excluded, and REQ-301–REQ-304 plus REQ-306/307 are
explicitly not it.

Keywords per RFC 2119. Requirement ids are stable and globally unique across
specs; new requirements append. The guard this spec generalises was
[[../auth/spec]] REQ-040–REQ-042; the archived read-only rule it composes with
is [[../spaces/spec]] REQ-065.

## Scope

Covers who may reach a space and what each role may do; how people are
invited, removed, and handed ownership; who is recorded as the actor on shared
material; the privacy of conversations; per-member resume; the space activity
feed; and the "someone is editing" signal on the notebook. Does **not** cover
the content of any resource (its own spec), email delivery (none exists — see
REQ-286), or merging concurrent notebook edits (excluded; the compare-and-set
save of [[../notebook/spec]] REQ-243 is unchanged).

## Membership and access

### REQ-282 — Every member has a row, the owner included

A space MUST have exactly one owner at all times, recorded both as
`Space.ownerId` and as a `SpaceMember` row with role `owner`; every other member
MUST have a `SpaceMember` row with role `editor` or `viewer`. Creating a space
MUST create the owner's row in the same transaction. Existing spaces were
backfilled with one owner row each, carrying the space's former `lastOpenedAt`.

### REQ-283 — Access is membership; a non-member is answered 404

Every resource route MUST register `assertAccess(resource, param, minRole)`,
which resolves the resource to its space and the caller to their membership
there. A signed-in user with no membership MUST be answered 404 for the space
and every resource inside it — the same body as for an id that does not exist
(PRD §17, [[../auth/spec]] REQ-041 unchanged). A non-member MUST NOT receive
403 on any route, read or write.

### REQ-284 — A member below the route's role is answered 403

A member whose role is below the route's `minRole` MUST be answered 403
`insufficient_role` with a plain-language message and no resource detail.
Reads default to `viewer`; every write route MUST declare `editor` or `owner`,
except the writes that touch only the caller's own state (opening a space,
their private conversations and feedback, leaving), which MAY stay `viewer`.
`test/ownership-table.test.ts` MUST fail on a write route registered without a
role and on a viewer write not in its allowance.

- GIVEN a viewer of space `S`
- WHEN they `POST /spaces/S/sources`
- THEN 403 `insufficient_role`; the same request from a non-member is 404.

### REQ-285 — The member cap is read at request time and holds under concurrency

`members_per_space` (default 5, `AppConfig`) counts members plus pending
invites. An invite at the cap MUST be refused with 409 `members_limit` naming
the limit, and raising the value MUST take effect without a code change.

The count MUST be taken inside the transaction that creates the invite, holding
a lock on the space row: a read-then-write outside it is not a cap, because
concurrent invites all read the same pre-write total and are all granted.

- GIVEN a space with one member and a cap of three
- WHEN five invites are created concurrently
- THEN exactly two are 201 and three are 409 `members_limit`.

## Invites

### REQ-286 — An invite is an email-bound, single-use, expiring link

Only the owner MAY create, list, rotate, or revoke invites. An invite MUST be
bound to an email, expire after `INVITE_TTL_HOURS` (env, default 168), and be
consumed on first acceptance. The token MUST be stored only as a SHA-256 hash;
the link MUST be returned once, on creation, and "copy again" (`rotate`) MUST
mint a new token that retires the previous one. There is no mail delivery: the
owner hands the link over.

### REQ-305 — An invite token never reaches a log

The token MUST NOT appear in any log line. It travels in the URL path, which
the request logger records on every request, so the logger MUST replace that
segment (`/invites/[Redacted]`) while keeping the rest of the path intact —
`redact` cannot express it, because pino's paths address object keys and this
secret is a substring of one value. Identifiers elsewhere in a URL (space,
source, note ids) MUST be preserved: a log that cannot name the resource cannot
be used to investigate anything (REQ-280).

### REQ-287 — Refusals name the reason to the owner only

Inviting an existing member MUST answer 409 `already_member`; inviting an
email with a pending invite MUST answer 409 `invite_pending`; the role MUST be
`editor` or `viewer` (never `owner`). An expired or revoked row for the same
email MUST be reusable, not a 409.

### REQ-288 — Every failed acceptance is one neutral 404

`GET /invites/:token` and `POST /invites/:token/accept` require a session and
MUST answer 404 with one message when the token is unknown, expired, revoked,
consumed, or bound to an email other than the signed-in account's. The body
MUST NOT name the space.

- GIVEN a live invite for `minh@…`
- WHEN a user signed in as `linh@…` opens the link
- THEN 404, identical to the response for a made-up token.

### REQ-289 — Accepting is transactional and idempotent

Accepting MUST consume the invite under a pending guard, create the membership,
and write `member.joined` in one transaction; a second accept of the same link
MUST be 404. If the account is already a member, accepting MUST keep their
standing role and answer 200.

### REQ-290 — The invite landing page

`/invite/:token` MUST send a signed-out visitor to sign in with a way back;
for the matching account it MUST show the space, the role, and who invited
them, and accept on one control; every failure MUST render one neutral page
that names the signed-in email so a wrong-account visitor can work it out.

## Roles

### REQ-291 — Three roles, one resource-level rule

| action | viewer | editor | owner |
|---|---|---|---|
| read anything, export, ask (own conversations), open (resume) | MUST | MUST | MUST |
| add source, archive/restore source, edit source details | MUST NOT | MUST | MUST |
| delete source | MUST NOT | own only | any |
| create/edit/delete any note, save answer, convert note | MUST NOT | MUST | MUST |
| edit notebook, edit space name/objective | MUST NOT | MUST | MUST |
| set the space's audience note | MUST NOT | MUST NOT | MUST |
| archive/restore the space | MUST NOT | MUST NOT | MUST |
| invite, revoke, remove, change role, transfer | MUST NOT | MUST NOT | MUST |

The audience note ([[../spaces/spec]] REQ-313) is owner-write and **all-read**:
every role receives it, because a member should be able to read what shapes the
answers they are given. It is not an access control — every member can already
open every source — and REQ-315 requires the UI to say so.

An editor deleting a source they did not add MUST be answered 403
`insufficient_role`. Conversion is editor-level on purpose: an editor may
already add any evidence. An archived space stays read-only for every role
([[../spaces/spec]] REQ-065); only the owner restores it.

### REQ-292 — Role changes, removal, and leaving

Only the owner MAY change a role (to `editor` or `viewer`), and MUST NOT change
their own or remove themself (400). Removing a member or a member leaving MUST
delete the membership and that member's conversations in the space in one
transaction, and MUST write `member.removed` / `member.left`; their sources and
notes MUST remain with their name. The owner MUST NOT leave (409
`owner_cannot_leave`). After removal the former member's next request MUST be
404.

### REQ-293 — Transfer is atomic, owner ↔ editor

`POST /spaces/:id/transfer` MUST accept only an editor as the target (400
`transfer_target_not_editor` otherwise, 400 for self), and in one transaction
MUST make the target `owner`, the caller `editor`, update `Space.ownerId`, and
write `space.ownership_transferred`. Exactly one owner row exists before and
after.

## Actors and activity

### REQ-294 — Shared material names who made it

`Source.addedById`, `Note.authorId`, `Conversation.userId`, and
`Notebook.updatedById` MUST be set from the requesting user on creation (or
save), backfilled to the owner for rows that predate sharing, and set null when
the account is gone. Payloads MUST carry `addedBy` / `author` / `updatedBy` as
`{ id, name } | null`; a converted note's source names the converter. The
ingestion pipeline MUST attribute `source.ready` / `source.failed` to the
adder, falling back to the owner only when the adder is gone.

### REQ-295 — The space feed shows every member's actions with the actor

`GET /spaces/:id/activity` (viewer) MUST return every row for the space,
newest first, cursor-paginated as [[../home-activity/spec]] REQ-263–REQ-269,
each item carrying `actor: { id, name } | null`. New kinds — `member.invited`
(target: the invite's email), `member.joined`, `member.removed`, `member.left`,
`member.role_changed`, `space.ownership_transferred` (target: the member) — link
to `/spaces/:id/members`.

### REQ-296 — The Home feed stays personal, plus what is about me

`GET /activity` MUST return the caller's own rows and, in addition, membership
rows whose target is the caller. It MUST NOT return another member's source or
note actions.

## Conversations are private

### REQ-297 — A conversation belongs to the member who started it

`POST /spaces/:id/conversations` MUST record the caller; the list MUST return
only the caller's; another member's conversation or message id MUST be 404
(not 403 — an id never shown is not known to exist). Retrieval for any member's
question MUST run over the space's `retrievableSources()` with no per-member
filter; the retrieval-eligibility invariant is unchanged. Saving an answer
creates a shared note authored by the saver.

## Resume is per member

### REQ-298 — Last-opened lives on the membership row

`POST /spaces/:id/open` MUST stamp the caller's `SpaceMember.lastOpenedAt`
only; `GET /spaces` MUST order by the caller's stamp; the `lastOpenedAt` in
every space payload is the caller's. Another member opening the space MUST
NOT move it in my list. `Space.lastOpenedAt` no longer exists.

### REQ-299 — The space payload carries the caller's standing

Every space payload MUST include `myRole`, `ownerName`, and `memberCount`, so
the client gates affordances from the one response it already has.

### REQ-300 — Home splits mine from shared; solo owners see no split

When any listed space is not owned by the caller, Home MUST render "My spaces"
and "Shared with me" sections, shared rows carrying the role and the owner's
name; when every space is the caller's own, the one flat list MUST render
unchanged. Write affordances on a shared row follow REQ-291.

## Notebook presence (advisory)

### REQ-301 — Presence is a heartbeat with a TTL, published on the space channel

`POST /spaces/:id/notebook/presence` (editor) MUST record the caller in a
Redis set expiring after `NOTEBOOK_PRESENCE_TTL_SECONDS` (default 30) and
publish `{ type: 'notebook.presence', users }` on the space's existing SSE
channel; `DELETE` MUST clear the caller and publish; `GET` (viewer) MUST return
the live set. A viewer's heartbeat MUST be 403. The set MUST be ordered
stably (by name): the Redis score is the last heartbeat, so any Redis-order
listing reshuffles under a reader who has not moved.

### REQ-306 — An entry that ages out is announced, not merely dropped

A member whose tab dies sends no `DELETE`. The read that prunes the expired
entry MUST publish the resulting set, because nothing else will: a member who
is watching rather than typing learns the set from the channel alone, and would
otherwise keep naming someone who left until they reloaded.

### REQ-307 — Presence degrades; it never fails the request

Redis is optional everywhere else in the app (`/health` reports it degraded,
the source stream falls back to polling). Every presence route MUST answer
"nobody is editing" when Redis is unreachable, and MUST NOT turn the failure
into a 5xx. Recovery MUST be automatic — the fallback is per request, not
sticky.

### REQ-302 — Nothing is locked

Presence MUST NOT block any save; the compare-and-set of [[../notebook/spec]]
REQ-243 remains the only arbiter. The 409 payload and the read payload MUST
carry `updatedBy`, and the conflict message MUST name who saved and when.

### REQ-303 — The client steps back, then may step in

An editor arriving while someone else is editing MUST get a read-mode editor
with an explicit "Edit anyway"; a solo editor MUST NOT see a read-only flash
(the decision is optimistic, taken once from the first presence answer). While
editing, the client MUST beat every 10 s and clear on unmount. The names
editing MUST be shown in a live region that changes only when the set changes.

### REQ-304 — The gating rule has one home

Every write affordance MUST be gated through `useSpaceRole`/`canEditSpace` —
false for a viewer, for an archived space, and before the space is known — so
the archived rule and the role rule cannot drift apart.

## Verification

Verified 2026-08-28 against the running local stack (Postgres via docker
compose, API on `:4000`, SPA on `:5173`, Redis, Ollama) and in the unit suites.
A code review the same day found four defects; each fix carries a test, and
each test was mutation-checked by reverting exactly its fix (below). Backend
307 → 312.

- `backend/test/assert-access.test.ts` — REQ-283, REQ-284, REQ-297 (404 for a
  non-member on read and write; 403 for a member below role; another member's
  conversation 404; removal → 404; 401 before any lookup).
- `backend/test/ownership-table.test.ts` — REQ-284's structural half: every
  parameterised route guarded; every write declares `editor`/`owner` or is in
  the viewer-writes allowance; token-scoped invite routes carry `requireUser`.
- `backend/test/members.test.ts` (21 tests) — REQ-282, REQ-285–REQ-289,
  REQ-291–REQ-298, REQ-301, REQ-302: the full lifecycle, wrong-account accept
  identical to an unknown link, token hashing, rotation killing the old token,
  the cap read from `AppConfig` at request time, editor-own vs owner delete,
  pipeline attribution, private conversations, per-member open, the space and
  Home feeds, `updatedBy` on the 409, presence set/publish/clear, role changes,
  leave, removal, transfer leaving one owner.
- Every pre-existing backend suite passed with only the guard's name changed
  at call sites and `userId` added to three conversation fixtures — a solo
  owner's behaviour is unchanged except for the new payload fields. Backend
  275 → 307.
- Frontend: `members-page.test.tsx`, `invite-page.test.tsx`, additions to
  `home-page`, `space-page`, `notebook-page`, `source-list`, `space-shell`, and
  `a11y` — REQ-290, REQ-291 (viewer sees no Add/New note/Delete; editor deletes
  only own), REQ-299, REQ-300, REQ-303, REQ-304; axe passes over the members
  page (roster + Invite dialog) and the invite page. Frontend 260 → 279.
- `e2e/shared-space.spec.ts` — ten steps, three browser contexts, **10/10
  passing live**: owner invites; a stranger's visit to the link is the neutral
  page; the editor registers through the link and accepts once; the source
  shows "by Editor Minh" to the owner with the "New since your last visit"
  marker; the viewer is refused every write in the UI and a forged `POST`
  answers 403; the owner sees "Editor Minh is editing", steps in with Edit
  anyway, and the colliding save shows "Editor Minh saved a newer version" with
  Reload; the space feed names actors while the editor's Home feed carries only
  their own join; removal → 404 for the editor with their source kept; the
  viewer leaves.
- **Review fixes, each proven load-bearing by reverting exactly its fix:**
  REQ-305 — `redaction.test.ts` "an invite token never reaches the log";
  reverting `scrubUrl` puts the raw token in the `incoming request` line and
  only that test fails. REQ-285 — `members.test.ts` "a burst of invites never
  puts the space over the member cap"; dropping *only* the `FOR UPDATE` leaves
  the counts inside the transaction and still grants **all five** of five
  concurrent invites against two seats, so the lock, not the transaction, is
  what enforces the cap. REQ-306 — "a heartbeat that stops without a DELETE
  clears for a watcher"; without the publish-on-prune the channel stays silent.
  REQ-307 — "a Redis failure answers 'nobody is editing'"; making the fallback
  rethrow turns the read into a 500.
- Found by the e2e run and recorded, not a bug: the SPA stamps `lastOpenedAt`
  from an effect a beat after render, so a test that navigates away in the same
  instant aborts it; the spec waits for the `/open` response where the stamp
  matters.

> [!warning] Not verified
> Presence TTL expiry is asserted by writing a past score and reading the set
> back, not by waiting out a real 30 s window. The presence indicator
> on the **rail's** Notebook item was not built (see the plan's implementation
> notes); the header on the notebook page carries it. The "new since your last
> visit" marker exists for sources only, not notes. Playwright ran on
> Chromium only; nothing was looked at by hand in a second browser.

## Cross-references

- [[../../plan/shared-spaces-v1/proposal]], [[../../plan/shared-spaces-v1/design]],
  [[../../plan/shared-spaces-v1/tasks]].
- [[../auth/spec]] REQ-040–REQ-042 (the guard this generalises),
  [[../spaces/spec]] REQ-059/062/063/065/067 (now per member),
  [[../ingestion/spec]] (actor on the pipeline's activity),
  [[../notes/spec]] (author), [[../notebook/spec]] REQ-243 (the save presence
  sits in front of), [[../assistant/spec]] REQ-170 (the list is now mine),
  [[../home-activity/spec]] REQ-263–REQ-269 (the feed shape reused).
