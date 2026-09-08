---
title: Assistant chat history — Tasks
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, backend, assistant, tasks]
---

# Tasks: assistant chat history

## Backend

### B1 — `routes/conversations.ts`

- [x] `conversationListItemSchema` = `conversationSchema` + `preview: string | null`, `messageCount: number`
- [x] List `findMany`: last `user` message (`take: 1`) + `_count.messages` in one query
- [x] `PREVIEW_LENGTH = 140`, whitespace-collapsed, `…` suffix when cut
- [x] `POST` / `GET /conversations/:id` / `PATCH` responses unchanged

### B2 — Tests

- [x] `test/conversations.test.ts`: preview + truncation, `null`/`0` on empty, ordering kept
- [x] **Gate: backend `pnpm test`, `pnpm lint` clean**

## Frontend

### F1 — `lib/api.ts`

- [x] `ConversationListItem` (`preview`, `messageCount`); `conversationsApi.list` returns it

### F2 — `features/assistant/conversation-list.tsx` (new)

- [x] `ConversationList({ conversations, spaceId })`: `<nav aria-label="Chats"><ul>`, whole-row `<Link>`
- [x] Title, truncated preview, `<time>` date, `Source` chip on source scope
- [x] `messageCount === 0` rows hidden
- [x] `formatConversationDate(iso, now)` — today / this year / other year
- [x] Pending skeleton, error `Alert`, empty state

### F3 — `features/assistant/new-chat-composer.tsx` (new)

- [x] `<label>` + `textarea` (`maxLength 2000`) + `Ask`; disabled while creating
- [x] `useCreateConversation` → `navigate(thread, { state: { initialQuestion } })`
- [x] `ApiError` keeps the draft, renders an `Alert` under the field (§16)
- [x] Scope choice on the hub: `ScopeSelector` takes `value: ScopeInput` (not a conversation); composer creates with the chosen scope; placeholder names the source

### F4 — `features/assistant/assistant-pane.tsx`

- [x] Read `location.state.initialQuestion`; `ask` once (ref-guarded); clear state with `replace`

### F5 — `routes/assistant-page.tsx`

- [x] Delete the redirect-to-latest effect and the "hidden by operator request" comment
- [x] `conversationId === ''` → hub: header, `NewChatComposer` (or archived `Alert`), `ConversationList`
- [x] Thread header: `← Chats` link; "New conversation" button → link to the hub
- [x] Reader pane logic untouched on the thread branch

### F6 — Tests

- [x] `conversation-list.test.tsx` (rows, order, hidden empties, chip, links, empty state, date cases)
- [x] `assistant-page.test.tsx` (hub renders without redirect; create + navigate + pending question; failed create; archived)
- [x] `assistant-pane.test.tsx` +1 (initialQuestion asked once, state cleared)
- [x] **Gate: `pnpm test`, `pnpm lint`, `pnpm build` clean**

### F7 — Browser check

- [ ] Hub at 1280px and at 320px (rows wrap, date stays on the title line, no horizontal scroll)
- [ ] Composer → thread → answer → Back shows the new row with title and preview

## Wiki

- [x] This folder `status: done`
- [x] [[../../specs/assistant/spec]]: drop the REQ-170 *Spec-vs-code* callout; add REQs for the hub route (no redirect; conversation created on first question), the list payload (`preview` from the last user message, `messageCount`), hidden empty threads, and the archived hub; extend `## Verification`
- [x] [[../../wireframe/index]] knowledge_assistant row: note the hub is a WikiBookLM addition, not in the wireframe
- [x] [[../../index]] plan row; [[../../log]] entry

## Implementation notes

Built 2026-08-27 as designed. Backend `conversations.test.ts` 225 → 227; frontend
173 → 189 (+6 list, +8 hub page, +2 pane); `pnpm lint` and `pnpm build` clean on
both. Two small departures from the design: the thread's page header now shows
the **conversation title** as its `h1` (the space name moved to the hub, where
the back link goes to the space; the thread's back link goes to the hub), and the
old "New conversation" button is a link to the hub labelled **New chat** — a
`Button render={<Link/>}`, not a create. The thread branch keeps every reader
pane line it had; the thread's own `useConversations` call is gone, so opening a
thread no longer fetches the list.

**Added the same day, on the operator's question** ("should the hub let me pick a
source?"): yes — the design had the hub always create a `space` scope, which made
a source-scoped *first* question impossible without spending a space-wide answer
first, something the old empty-thread flow allowed. `ScopeSelector` now takes a
`ScopeInput` value instead of a conversation (an `id` prop keeps the two selectors'
labels distinct), the composer holds the scope and creates with it, and the
placeholder reads `Ask a question about "<title>"…` once a source is picked.
REQ-239 amended. One hub test was flaky under full-suite load — it asserted the
router state was cleared right after the question appeared, and the `replace`
lands a tick later — now a `waitFor`; two full runs green.

**Review pass, same day** (`/review-code` on the uncommitted diff). Fixed:
the hub rendered the composer before the space was known, so an archived space
would swap it for the notice and take the draft with it — now a skeleton until
`space.data` arrives; the empty state said "ask a question above" in an archived
space that has no composer — an `archived` prop picks the copy; the preview cut
by UTF-16 unit and could end on half a surrogate pair — now by code point; the
date tests read the process locale — `formatConversationDate` and the list take
an optional `locale`, pinned to `en-US` in tests; `AssistantHub` re-called
`useSpace` for the rail — the parent passes `space` down; the pane's read-only
branch left the handed-over question in the history entry — state is now cleared
in every case. Five tests added for those branches. Backend 227, frontend 189.
Left alone: `block.tsx`'s 16/28 body text, which is outside this plan and
contradicts REQ-236 — the operator's call.

**F7 is outstanding.** The Chrome extension was not connected — the gap every
plan since [[../space-sidebar/tasks]] records. Both dev servers were running
(`tsx watch` reloaded the backend), so the check is one `open` away when the
extension is. What jsdom cannot answer: that `truncate` on the preview actually
ellipsises inside the row's `min-w-0` chain, that the `<time>` stays on the title
line at 320px, and how the Source chip sits beside a long title.
