---
title: Assistant chat history — Design
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, backend, ui, assistant, design]
---

# Design: hub route, list payload, ask-on-create

## Backend — the list payload grows two fields

`GET /spaces/:id/conversations` rows gain:

| Field | Type | Source |
|---|---|---|
| `preview` | `string \| null` | content of the newest `user` message, whitespace-collapsed, cut to `PREVIEW_LENGTH = 140` chars with `…`; `null` when there is none |
| `messageCount` | `number` | `_count.messages` |

One query, no N+1: `findMany` with the existing `conversationSelect` plus
`messages: { where: { role: 'user' }, orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } }`
and `_count: { select: { messages: true } }`. `orderBy: { updatedAt: 'desc' }`
is unchanged.

Schema: a `conversationListItemSchema = conversationSchema.extend({ preview, messageCount })`
used only by the list response; `create`, `get` and `patch` keep
`conversationSchema` so their contracts do not move. `serializeConversation`
stays; the list route maps through a `serializeListItem` that spreads it.

Constants are code constants, not `AppConfig`: 140 is presentation, not a
PRD §5 limit.

## Frontend — two views under one route file

`assistant-page.tsx` branches on `conversationId`:

```
/spaces/:id/assistant                 → <AssistantHub>
/spaces/:id/assistant/:conversationId → thread (today's markup, unchanged)
```

The redirect-to-latest `useEffect` is deleted. The thread's page header gains a
`← Chats` link to the hub; its "New conversation" button becomes a link to the
hub too (the composer lives there), so `useCreateConversation` is called from
exactly one place.

### `AssistantHub` layout

```
← {Space name}
Assistant                                   (h1)

┌──────────────────────────────────────────────────┐
│ Ask a question in {Space name}…          [ Ask ] │   ← NewChatComposer
└──────────────────────────────────────────────────┘

Chats                                       (h2, sr-only or small label)
┌──────────────────────────────────────────────────┐
│ Kế hoạch báo cáo thực tập                 Jul 6  │
│ ý là tóm tắt thành đoạn như lúc nãy á            │
├──────────────────────────────────────────────────┤
│ Quy trình xây dựng mô phỏng      [source] Apr 23 │
│ giải thích                                       │
└──────────────────────────────────────────────────┘
```

| Reference (ChatGPT project page) | Chosen | Why |
|---|---|---|
| Folder icon + project name, Share, ⋯ | Back link + `h1 Assistant` as today | No share / manage actions exist (REQ-173) |
| "New chat in X" pill with Think / voice / mic | `textarea` + `Ask` button, same `<label>` pattern as the pane composer | Only text questions exist |
| Chats / Sources tabs | none | duplicates `SpaceRail` |
| Row: title, grey one-line preview, right-aligned date | `<li><Link>` with `title` (`text-base font-semibold`), `preview` (`truncate text-sm text-on-surface-variant`), date (`text-sm text-on-surface-variant shrink-0`) | tokens only, per `DESIGN.md` |
| — | a small `Source` chip on `scopeType === 'source'` rows | REQ-171: the scope is visible on the assistant screen |
| Hover ⋯ | none | no valid action |

Rows are an `<ul>` inside `<nav aria-label="Chats">`; the whole row is one
`<Link to=/spaces/:id/assistant/:conversationId>`, focus ring per `DESIGN.md`,
`border-b border-outline-variant` between rows. Conversations with
`messageCount === 0` are filtered out client-side.

**Date** — `formatConversationDate(updatedAt, now)`: same calendar day →
`HH:mm`; same year → `Jul 6`; otherwise `Jul 6, 2025`. `Intl.DateTimeFormat`
with the browser locale; a `<time dateTime=…>` element with the full timestamp
as `title`.

**States** (PRD §16): list pending → three skeleton rows; list error → `Alert`
with the `ApiError` message; empty → the "Ask your sources" copy already in
`assistant-pane.tsx`, under the composer; archived → the existing
`This space is archived…` `Alert` in place of the composer, list still shown.

### Ask-on-create

Submitting the hub composer must end with the question in flight on the thread
route. The thread's `useAsk(conversationId)` needs an id that does not exist
yet, so:

1. `NewChatComposer.onSubmit(question)` → `createConversation.mutateAsync({ scopeType: 'space' })`.
   On `ApiError` the draft stays in the textarea and an `Alert` renders under
   it (§16). The button is disabled while pending.
2. On success → `navigate(`/spaces/${spaceId}/assistant/${id}`, { state: { initialQuestion: question } })`.
3. `AssistantPane` reads `useLocation().state?.initialQuestion`. In a mount
   effect guarded by a `useRef` it calls `ask(initialQuestion)` once and then
   `navigate(location.pathname, { replace: true, state: null })` so a refresh,
   Back, or a re-render does not re-ask.
4. `use-ask.ts` already invalidates `conversationKeys.lists(spaceId)` on
   `done` (line 90) and on error (line 148), so the hub shows the generated
   title (REQ-177) and preview when the user returns.

Why router state and not a query param: `?q=` would survive a copy-pasted URL
and re-ask on every open; state is dropped by a fresh load, which is the
behaviour wanted. The hub's own scope is always `space`; changing to a source
scope stays on the thread via `ScopeSelector` (REQ-171).

### Files

| File | Change |
|---|---|
| `backend/src/routes/conversations.ts` | list select + `conversationListItemSchema` + serializer |
| `backend/test/conversations.test.ts` | preview / messageCount cases |
| `frontend/src/lib/api.ts` | `ConversationListItem extends Conversation`; `conversationsApi.list` typed with it |
| `frontend/src/features/assistant/conversation-list.tsx` | new: `ConversationList`, `formatConversationDate` |
| `frontend/src/features/assistant/new-chat-composer.tsx` | new |
| `frontend/src/features/assistant/assistant-pane.tsx` | `initialQuestion` consumption |
| `frontend/src/routes/assistant-page.tsx` | hub branch, redirect removed, header links |
| tests | `conversation-list.test.tsx`, `assistant-page.test.tsx` (new), `assistant-pane.test.tsx` (+1) |

## Tests

- **Backend** — a conversation with messages returns `preview` = last user
  message, truncated at 140 with `…`, and the right `messageCount`; one with no
  messages returns `preview: null, messageCount: 0`; ordering by `updatedAt`
  still holds; the response schema of `POST` / `GET /conversations/:id` is
  unchanged.
- **`conversation-list.test.tsx`** — rows render title, preview and a `<time>`;
  most-recent first; `messageCount === 0` rows are absent; a `source` scope
  shows the chip; each row is a link to the thread; the empty state renders.
- **`assistant-page.test.tsx`** — `/spaces/:id/assistant` renders the hub and
  does **not** navigate to the latest thread; submitting the composer calls
  `POST /spaces/:id/conversations` once and lands on the thread with the
  question shown as pending; a failed create keeps the draft and shows an
  `Alert`; archived space hides the composer, keeps the list.
- **`assistant-pane.test.tsx`** — with `initialQuestion` in location state the
  ask stream is opened exactly once and the state is cleared.
- **`formatConversationDate`** — today / this year / another year, with a
  fixed `now`.
