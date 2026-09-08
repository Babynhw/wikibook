---
title: Shared spaces v1 — design
kind: plan
status: done
created: 2026-08-28
updated: 2026-08-28
tags: [post-mvp, sharing, members, roles, ownership, activity, notebook, design]
---

# Design: Shared spaces v1

Decisions, each with the alternative it rejected and the cost it accepts.
[[proposal]] says what and why; [[tasks]] splits the work.

## Data model

### Every member has a row, including the owner (decided 2026-08-28)

```prisma
enum SpaceRole { owner editor viewer }

model SpaceMember {
  spaceId      String
  userId       String
  role         SpaceRole
  invitedById  String?
  lastOpenedAt DateTime?
  createdAt    DateTime @default(now())
  @@id([spaceId, userId])
  @@index([userId, lastOpenedAt])
}
```

`Space.ownerId` **stays** — as the cascade anchor, the transfer target, and a
denormalised answer to "whose is this" — but no guard reads it. The migration
backfills one `owner` row per existing space, copying `Space.lastOpenedAt` into
the row.

*Rejected:* members table without the owner, guard checks `ownerId || member`.
Two queries or a `UNION` on every request, and every "list my spaces" query has
two branches. *Rejected:* dropping `ownerId` and deriving the owner from the
role. A space with zero or two owner rows becomes representable; the invariant
"exactly one owner" would live in application code instead of a column.

*Cost:* the owner appears twice in the data (column and row); transfer must
update both in one transaction, and a test proves the two agree.

### Actor columns, all nullable, backfilled to the owner (decided 2026-08-28)

`Source.addedById`, `Note.authorId`, `Conversation.userId`,
`Notebook.updatedById` — all `String?` with `onDelete: SetNull`, backfilled to
`space.ownerId` in the migration. `Conversation.userId` is the one that changes
behaviour: the list and every read filter on it.

*Rejected:* non-null columns. A deleted user would cascade away shared sources
and notes other members still rely on; `SetNull` keeps the work and drops the
name. *Rejected:* an `Actor` join table. Nothing here is many-to-many.

*Cost:* UI must render "a former member" for a null actor.

### Invites are email-bound links, not emails (decided 2026-08-28)

```prisma
model SpaceInvite {
  id          String    @id @default(cuid())
  spaceId     String
  email       String
  role        SpaceRole            // editor | viewer, never owner
  tokenHash   String    @unique
  invitedById String
  expiresAt   DateTime
  acceptedAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
  @@unique([spaceId, email])
}
```

There is no mail provider (`routes/auth.ts` logs reset tokens). The invite
route returns the URL once; the pending list re-derives nothing — the token is
stored hashed like password-reset tokens, so "copy link again" is a **new
token** that replaces the old one (same row, `tokenHash` rotated). Accepting
requires `session.user.email === invite.email`; every failure — expired,
revoked, consumed, unknown, wrong account — is one neutral 404 page.

*Rejected:* unbound links ("anyone with the link joins"). One forward and a
stranger is in the evidence pool; §17's disclosure posture would be undone by
the sharing feature. *Rejected:* waiting for a mail provider. Blocks the whole
plan on a decision that has been open since Phase 0.

*Cost:* the owner has to know the invitee's account email exactly; a typo is a
dead invite until revoked. The pending list shows the email so it is visible.

### Limits (decided 2026-08-28)

`members_per_space` joins `APP_CONFIG_DEFAULTS` (default 5, PRD §5 style: a
product limit, read live). `INVITE_TTL_HOURS` (default 168) is env, following
`config.ts`'s rule that operational tunables are not `AppConfig`. Invite
creation shares the write rate limit.

## Access

### `assertOwnership` → `assertAccess(resource, param, minRole)` (decided 2026-08-28)

The resolver table in `assert-ownership.ts` changes its return type from
`ownerId` to `spaceId` (same eight queries, one `select` shallower). The guard
then runs one `spaceMember.findUnique({ spaceId, userId })`:

| membership | role vs `minRole` | response |
|---|---|---|
| none | — | 404 (unchanged: existence is not confirmed) |
| row | below | **403** `insufficient_role`, message "You can view this space but not change it." |
| row | at or above | pass |

`minRole` defaults to `viewer`. The guard records `minRole` on itself so
`ownership-table.test.ts` can assert: every `POST`/`PUT`/`PATCH`/`DELETE`
route under a space declares `editor` or `owner`; every `GET` may stay
`viewer`. Route-by-route roles are in [[tasks]].

Ordering matters for `viewer` on a `GET`: a 403 must not be reachable by a
non-member, so the membership check always runs before the role check — one
row, two comparisons, one query.

*Rejected:* keeping 404 for members below role. §17's reasoning is "a 403
confirms the id exists"; a member already knows the space exists, and a 404 on
"Add source" would read as a bug, not a permission. *Rejected:* a permission
matrix (`can(user, 'note.delete', note)`). Three ordered roles are a total
order; `role >= minRole` is the whole matrix. Ownership of an individual
resource matters in exactly one rule (editors delete only their own sources),
handled in that route.

*Cost:* one extra query per request compared to today (resolver + membership
instead of resolver only). Both are primary-key lookups.

### `requireUser`-only routes gain a membership filter (decided 2026-08-28)

`GET /spaces` becomes `where: { members: { some: { userId } } }` and returns
`myRole` and `ownerName` per space, ordered by **my** `SpaceMember.lastOpenedAt`.
`POST /spaces/:id/open` stamps my member row. `GET /spaces/:id` returns
`myRole` so the client gates affordances without a second request.

## Roles

### Three roles, one rule that looks at the resource (decided 2026-08-28)

| action | viewer | editor | owner |
|---|---|---|---|
| read anything, export, ask (own conversations) | ✓ | ✓ | ✓ |
| add source, archive/restore source | | ✓ | ✓ |
| delete source | | own only | ✓ |
| create/edit/delete note (anyone's), save answer, convert | | ✓ | ✓ |
| edit notebook | | ✓ | ✓ |
| edit space name/objective | | ✓ | ✓ |
| archive/restore/delete space | | | ✓ |
| invite, revoke, remove, change role, transfer | | | ✓ |

**Convert note → source is editor-level.** Conversion creates evidence every
member will retrieve from. Discussed and decided: an editor is by definition
trusted to add evidence (they can upload any PDF); gating convert behind owner
would protect nothing the "Add source" button does not already expose.

**Editors delete only their own sources; notes are fully shared.** A source is
evidence someone chose to bring in; deleting another person's is the one
destructive act on shared material with no undo (delete is permanent, purges
the original). Notes are the collaborative surface, and every edit is
attributable; a delete there is recoverable by the author re-writing it.

*Rejected:* `admin` between editor and owner; `commenter`; per-note
private/shared flags. Each is a fourth thing to explain; v1 finds out first
whether three are used.

### Removal deletes the member's conversations in that space (decided 2026-08-28)

Their sources and notes stay (shared material, their name on it). Their
conversations are private to them and meaningless to the remaining members;
notes saved from them survive because `Note.originConversationId` is
`SetNull`. A member who leaves gets the same.

*Rejected:* keeping the conversations orphaned. Rows nobody can read, growing
forever. *Rejected:* transferring them to the owner. Turns private questions
into someone else's.

*Cost:* rejoining does not restore chat history. Stated in the confirm dialog.

### Transfer is one transaction, owner ↔ editor (decided 2026-08-28)

`POST /spaces/:id/transfer { userId }` — target must be an `editor`; updates
`Space.ownerId`, sets target row `owner`, sets caller row `editor`, writes
`space.ownership_transferred`. Owner cannot remove, demote, or transfer to
themself; owner cannot leave (transfer first, or delete the space).

## Conversations are private (decided 2026-08-28)

`Conversation.userId`; the conversation resolver checks `userId === me` **in
addition** to membership, and answers 404 (not 403) for another member's
conversation — an id you were never shown is not something you know exists.
The hub lists mine. Retrieval is unchanged: `retrievableSources()` over the
space, no per-member filter; the retrieval-eligibility invariant is a
data-layer filter and stays one.

*Rejected:* shared conversations. Chat is thinking out loud; notes are what the
group agreed to keep. Making every half-formed question visible changes how
people ask. *Rejected:* a per-conversation share toggle. A shared conversation
would need an author on every message and a decision about who can continue
it; that is a second feature.

*Cost:* two people can ask the same thing and not know. Saved notes are the
answer to that, and the activity tab shows "saved an answer as a note".

## Resume is per member (decided 2026-08-28)

`SpaceMember.lastOpenedAt` replaces every read of `Space.lastOpenedAt`
(ordering, Continue card, and the new "new since your last visit" dot, computed
client-side as `createdAt > member.lastOpenedAt` over the already-loaded source
and note lists). `Space.lastOpenedAt` is dropped in the migration.

*Rejected:* keeping the column for owners and adding per-member for others.
Two code paths for one rule.

## Activity

### `Activity.userId` is the actor; the pipeline learns who added the source (decided 2026-08-28)

`ingest/pipeline.ts` selects `addedById` instead of `space.ownerId` for
`source.ready` / `source.failed`. Every route already writes the requesting
user. New kinds: `member.invited`, `member.joined`, `member.removed`,
`member.left`, `member.role_changed`, `space.ownership_transferred`, with
`refId` = the affected user's id and a `target` type `user` resolving to a
name.

`GET /spaces/:id/activity` — `assertAccess('space', 'id', 'viewer')`, same
cursor, same resolver, filter `spaceId` instead of `userId`, items gain
`actor: { id, name } | null`. `GET /activity` (Home) keeps `userId = me` and
adds `OR refId = me AND kind LIKE 'member.%'` so "you were added to X" appears.

*Rejected:* a fan-out table (one row per member per event). The read-time
resolver was chosen in Phase 7 precisely to avoid writes multiplying.

## Notebook presence over the existing SSE channel (decided 2026-08-28)

`POST /spaces/:id/notebook/presence` (editor) sets Redis
`notebook:editing:{spaceId}:{userId}` with a 30 s TTL and publishes
`{ type: 'notebook.presence', users: [{ id, name }] }` on `space:{spaceId}` —
the channel `events.ts` already streams. The client heartbeats every 10 s while
the editor is in edit mode and has focus, stops on blur/unmount, and a
`DELETE` clears early. The space shell subscribes (it already does for source
state) and shows "Minh is editing" on the Notebook rail item and page header.

Opening the notebook while someone else is present: the editor mounts
**read-only** with an "Edit anyway" button; choosing it flips `editable` and
starts heartbeating. Nothing is enforced server-side — the compare-and-set save
is still the arbiter; the 409 payload and dialog gain `updatedBy: { name }`.

*Rejected:* WebSocket + Yjs. Correct, and a rewrite of `use-autosave.ts`, the
whitelist validator, the export serialiser's input, and the localStorage
draft; excluded by the §20 amendment. *Rejected:* a server-side lock (409 on
save while someone else holds it). A stale lock from a crashed tab blocks the
whole team until TTL; the advisory version degrades to today's behaviour.
*Rejected:* polling. The SSE channel is already open on every space route.

*Cost:* two people who both click "Edit anyway" are exactly where they are
today, minus the surprise. Presence is lost for the TTL when a tab dies.

## Frontend

- **Routes:** `/spaces/:id/members` (owner sees controls; others see the list),
  `/invite/:token` (accept page; redirects to login/register with `returnTo`
  when signed out), `/spaces/:id/activity`.
- **Gating:** one `useSpaceRole()` hook reading `space.myRole`; every write
  affordance already withheld for an archived space (REQ-076, REQ-237,
  notes' archived banner) gains the same `canEdit` condition, so the two rules
  share one code path.
- **Home:** the list gets a "Shared with me" section under "My spaces", each
  row with a role badge and `ownerName`; the Continue card ignores nothing —
  it is whatever I opened last.
- **Attribution:** an `actor` column in the library table (hidden below `md`),
  "by Name" in note rows and header, "Name saved 2 minutes ago" in the
  conflict dialog.
- **Rail:** a Members item (all roles) below Notebook; the presence text on
  the Notebook item.

## Testing

- `ownership-table.test.ts` gains the role assertion (write ⇒ `editor+`).
- One `sharing.test.ts` per surface: invite lifecycle, accept with wrong
  account, cap, removal → 404 → conversations gone, transfer atomicity, editor
  vs owner on source delete, viewer 403s, conversation privacy (another
  member's id → 404), presence TTL and publish, per-member ordering.
- Playwright: a second §21-style scenario with two browser contexts — owner
  invites, editor accepts, adds a source, viewer reads it and gets no Add
  button, editor edits notebook while owner sees presence.

## Migration

One migration: `SpaceRole`, `SpaceMember`, `SpaceInvite`, four actor columns,
drop `Space.lastOpenedAt`; data steps backfill the owner row (copying
`lastOpenedAt`) and every actor column from `ownerId`. Reversible only by
restoring `Space.lastOpenedAt` from the owner row — noted in the migration.
