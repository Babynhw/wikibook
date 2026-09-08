---
title: Shared spaces v1 — members, roles, no real-time
kind: plan
status: done
created: 2026-08-28
updated: 2026-08-28
tags: [post-mvp, sharing, members, roles, ownership, activity, notebook]
---

# Proposal: Shared spaces v1

## PRD §20 amendment

PRD §20 excludes *Shared spaces*, *Team roles or permissions*, and *Real-time
collaboration* from Phase 1. Phases 0–7 are done, so Phase 1 is complete. This
proposal **lifts the first two exclusions** for the work it describes and
**keeps the third**: real-time co-editing stays excluded, and anything in this
plan that looks like it (presence, the "someone is editing" lock) is an
*advisory* signal over the existing compare-and-set save, not a merge.

Decided with the operator on 2026-08-28 after discussing three tiers —
shared read/contribute, roles, real-time — and their costs. Recorded here so
a later agent reading [[../../AGENTS]]'s "the PRD's scope exclusions are
requirements" does not treat this plan as a violation.

## Problem

WikiBookLM is single-user by construction: every resource hangs off a `Space`
with exactly one `ownerId`, and `assertOwnership` answers 404 to anyone else
(PRD §17, [[../../specs/auth/spec]]). That is the right shape for a personal
workspace and the wrong shape for the situation the operator now has: two or
three people researching one topic who want one evidence pool, one set of
notes, and one notebook — without emailing PDFs to each other or keeping three
diverging spaces.

What the code has, and what it lacks, for that:

- **Ownership is centralised.** `ownerId` is read in exactly three non-generated
  files: `backend/src/middleware/assert-ownership.ts` (eight resolvers that all
  reduce to "whose space is this?"), `routes/spaces.ts` (list filter, create),
  and `ingest/pipeline.ts` (attributes `source.ready`/`source.failed` activity
  to the owner). `test/ownership-table.test.ts` already proves every
  parameterised route carries a guard. Widening "owner" to "member with role ≥
  X" is therefore a change to one resolver table, not a sweep.
- **Nothing records who did what inside a space.** `Note`, `Source`,
  `Conversation`, and `Notebook` have no author or actor column; `Activity` has
  `userId` but the pipeline writes the owner's id. In a shared space "who added
  this source / wrote this note / saved this notebook" is not optional.
- **The notebook is one document with one lock-free save.** `PUT` is a whole
  document under an `updatedAt` compare-and-set; the loser gets 409 with the
  server's copy ([[../../specs/notebook/spec]] REQ-244/245). Two people typing
  at once would trade 409s. Real merge is out (see the amendment above); the
  cheap thing that catches most of the pain is telling the second person
  someone is already in there.
- **Invites have no delivery channel.** There is no mail provider: password
  reset logs its token to the console (`routes/auth.ts`, "delivery is
  console-only until an email provider is chosen"). An invite flow that assumes
  email would not work in this deployment.
- **`Space.lastOpenedAt` is per space, not per person.** §4's resume rule and
  the Continue card ([[../../specs/home-activity/spec]]) both read it; with two
  people it is whoever opened last.

## Goal

An owner invites a person to a space by handing them a link. The invitee signs
in (or registers) with the invited email, accepts, and the space appears under
"Shared with me" with their role. A **viewer** reads everything, exports the
notebook, and asks the assistant in conversations only they can see. An
**editor** additionally adds sources, writes and edits notes, saves answers as
notes, converts notes to sources, and edits the notebook. The **owner**
additionally manages members, deletes other people's sources, archives or
deletes the space, and can hand the space to an editor. Every source, note,
and notebook save names who did it; the space has an activity tab that reads
the same. Someone outside the space still gets 404 for everything; a member
without the right role gets 403. Two editors opening the notebook see each
other; the second is warned before they start typing, and if they collide
anyway the 409 dialog names who saved.

```
 /spaces/:id/members                          /spaces/:id  (editor view)
 ┌────────────────────────────────────────┐   ┌──────────────────────────────┐
 │ Members                    [Invite]    │   │ Sources        [Add source]  │
 │ ● Tan        owner                     │   │ title · added by Minh · 2d   │
 │ ● Minh       editor    [▾ role] [✕]    │   │ title · added by Tan  · 5d   │
 │ ● Linh       viewer    [▾ role] [✕]    │   ├──────────────────────────────┤
 │                                        │   │ Notebook   ⚠ Minh is editing │
 │ Pending                                │   │ [Read]          [Edit anyway]│
 │ an@example.com  editor  expires 6d [⧉] │   └──────────────────────────────┘
 └────────────────────────────────────────┘
```

## Scope

1. **Membership model** — `SpaceMember { spaceId, userId, role, lastOpenedAt }`
   with the owner as a row too, so access is one lookup; `SpaceInvite` bound to
   an email, single-use, expiring; a `members_per_space` limit in `AppConfig`.
2. **Access guard** — `assertOwnership(resource, param)` becomes
   `assertAccess(resource, param, minRole)`; the resolver table returns a
   `spaceId`, one membership query decides; non-member → 404, member below
   `minRole` → 403; `ownership-table.test.ts` extended to assert the *role* on
   every write route, not just the presence of a guard.
3. **Actors** — `Source.addedById`, `Note.authorId`, `Conversation.userId`,
   `Notebook.updatedById`; the pipeline attributes activity to the adder;
   names shown in the library table, note list/header, notebook conflict
   dialog.
4. **Invite / accept / leave / remove / transfer / change role** — routes,
   activity kinds, the members page, the accept page, "Shared with me" on Home,
   role badges.
5. **Private conversations** — scoped by `(spaceId, userId)`; the chat hub
   lists only mine; retrieval is over the whole space's `retrievableSources()`
   for every member; "save answer as note" is the one door from private to
   shared.
6. **Per-member resume** — `SpaceMember.lastOpenedAt` replaces
   `Space.lastOpenedAt` for ordering, the Continue card, and a "new since your
   last visit" marker on sources and notes.
7. **Space activity tab** — `GET /spaces/:id/activity`, the same shape as
   `/activity`, every member's actions with the actor's name; the Home feed
   stays personal plus membership events about me.
8. **Notebook presence** — a heartbeat while an editor has the notebook open,
   pushed over the existing `space:{id}` SSE channel; a second editor opens in
   read mode with "Edit anyway"; the 409 dialog names the last saver.

## Out of scope

- **Real-time co-editing** — CRDT, WebSocket, cursor sharing, automatic merge.
  Stays in PRD §20. The whole-document compare-and-set save is unchanged.
- **Multiple notebooks per space** — discussed and declined 2026-08-28: it
  blurs the note/notebook distinction §13 draws; the cheap answer to a long
  notebook is a heading outline, which is a separate small proposal if wanted.
- **Email delivery.** Invites are links the owner copies. Choosing a mail
  provider is its own change and would also unblock password reset.
- **Per-resource permissions, custom roles, organisations, groups.** Three
  fixed roles.
- **Comments or threads** on notes, passages, or the notebook.
- **Public or anonymous links.** Every reader is a signed-in member.
- **Notifications** (email, push, badge counts) beyond the activity tab and the
  "new since last visit" marker.
- **Shared conversations.** Private by decision (see [[design]]); revisiting
  this means a data-model change, not a toggle.
- Everything else PRD §20 lists.

## Acceptance criteria

The PRD has no criteria for a feature it excluded; these are written so
"done" is not a judgement call, in the PRD's style.

**Membership and access**

- A space has exactly one owner at all times; every member, including the
  owner, has one `SpaceMember` row.
- A signed-in non-member receives 404 for the space and every resource inside
  it — the same response as for a space that does not exist.
- A member below the required role receives 403 with a plain-language message
  and no resource detail.
- Every write route under a space declares a minimum role of `editor` or
  `owner`; a test walks the route table and fails on one that does not.
- The member cap is read from `AppConfig` at request time; an invite at the cap
  is refused with 409 and the limit stated.

**Invites**

- Only the owner can create, revoke, or list invites.
- An invite is bound to an email, expires after a configured interval, and is
  consumed on first acceptance.
- Accepting requires being signed in with exactly the invited email; any other
  account sees the same neutral error as an expired, revoked, or unknown link.
- An invite to an existing member, or a second pending invite for the same
  email, is refused.
- The invite link is shown to the owner once and copyable from the pending list
  until it expires.

**Roles**

- Viewer: read sources, reader, notes, notebook; export; own conversations.
  No write to sources, notes, notebook.
- Editor: viewer + add/archive/restore sources, delete sources they added,
  create/edit/delete any note, save answers as notes, convert notes, edit
  notebook, edit space name and objective.
- Owner: editor + delete any source, archive/restore/delete the space, manage
  members and invites, change roles, transfer ownership.
- An archived space is read-only for every role, as today (409
  `space_archived`).
- Removing a member (or a member leaving) makes their next request 404; their
  sources and notes remain with their name; their conversations in that space
  are deleted; the owner cannot remove or demote themself.
- Transfer makes the target editor the owner and the previous owner an editor,
  atomically.

**Actors and activity**

- Every source shows who added it; every note who created it; a notebook
  conflict names who last saved.
- The pipeline's `source.ready` / `source.failed` rows carry the adder's id.
- The space activity tab shows every member's actions newest first with the
  actor's name, cursor-paginated; the Home feed shows only my own actions plus
  `member.*` events that concern me.
- New kinds: `member.invited`, `member.joined`, `member.removed`,
  `member.left`, `member.role_changed`, `space.ownership_transferred`.

**Conversations**

- A member lists and opens only their own conversations in a space; another
  member's conversation id is 404.
- Retrieval for any member's question runs over the space's
  `retrievableSources()` with no per-member filter; the invariant that failed,
  archived, and unconverted content never enters retrieval is unchanged.
- A saved answer becomes a shared note authored by the saver, with its
  citations resolving for every member.

**Resume**

- Space ordering, the Continue card, and "new since last visit" use my
  `SpaceMember.lastOpenedAt`; another member opening the space does not move
  it in my list.

**Notebook presence**

- While an editor has the notebook open in edit mode, other members with the
  space open see their name within one heartbeat interval; the indicator
  clears within two intervals of them leaving.
- A second editor opening the notebook while someone is editing gets a
  read-mode editor with an explicit "Edit anyway"; nothing is blocked
  server-side.
- The existing 409 conflict dialog shows the last saver's name.

## Cross-references

- [[design]] — the decisions; [[tasks]] — the split.
- [[../../specs/auth/spec]] — `assertOwnership` and the 404 disclosure rule
  this generalises (REQ-0xx on ownership; the 403 case is new).
- [[../../specs/spaces/spec]] — ownership 404s, `lastOpenedAt`, the archived
  read-only state, the list ordering this changes to per-member.
- [[../../specs/ingestion/spec]] — the pipeline's activity writers that gain an
  actor; `retrievableSources()` as the unchanged retrieval filter.
- [[../../specs/notes/spec]] — notes gain an author; convert stays editor-level.
- [[../../specs/notebook/spec]] REQ-244/245 — the compare-and-set save the
  presence signal sits in front of.
- [[../../specs/assistant/spec]] REQ-170 and [[../assistant-chat-history/proposal]]
  — the hub that becomes per-member.
- [[../../specs/home-activity/spec]] — the feed shape reused for the space tab;
  the Continue card that moves to per-member resume.
- [[../phase-2-ingestion/design]] — the `space:{id}` SSE channel presence rides
  on.
- New spec on close: `specs/sharing/spec.md`, plus amendments to the five specs
  above.
