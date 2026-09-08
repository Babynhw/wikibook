---
title: Assistant chat history — a hub page listing every conversation in a space
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [frontend, backend, ui, assistant, conversations]
---

# Proposal: make `/spaces/:id/assistant` a chat-history hub

## Problem

Opening the assistant from the rail lands on `/spaces/:spaceId/assistant`, and
`assistant-page.tsx` immediately `navigate`s (replace) to the most recently
updated conversation. Nothing on screen lists the others. The
`<nav aria-label="Previous conversations">` that once did was removed on
2026-08-15 at the operator's request, which [[../../specs/assistant/spec]]
REQ-170 records as a *Spec-vs-code* gap: "every previous conversation listed and
readable" has a server (`GET /spaces/:id/conversations`, eleven cases in
`backend/test/conversations.test.ts`) and no UI.

Two smaller consequences of the current shape:

| # | What | Where |
|---|---|---|
| 1 | "New conversation" creates an **empty** thread titled `New conversation` before any question is asked; abandoned ones accumulate and would clutter any list | `assistant-page.tsx` `start()`, `conversations.ts` POST |
| 2 | The list payload has no message preview, so a row could show only a title and a date | `conversationSchema` / `conversationSelect` in `conversations.ts` |

## Goal

The operator's reference (2026-08-27) is ChatGPT's *project* page: a title row,
a composer that starts a new chat, then a list of chats — each row a title, a
one-line preview of the last user message, and a date. Adapted to WikiBookLM:

- `/spaces/:id/assistant` with no conversation is a **hub**: space name, a
  composer that creates a conversation **and asks** in one submit, and the
  conversation list most-recently-updated first (REQ-169). No redirect.
- `/spaces/:id/assistant/:conversationId` stays the thread it is today, with a
  "← Chats" link back to the hub.
- A conversation is created only when a question is submitted, so no empty
  threads are made from now on.

This closes REQ-170's "listed" half. It reverses the 2026-08-15 decision
knowingly: what was removed then was a side nav competing with the thread; what
is built now is a separate page, which is what was asked for.

## Decisions (confirmed with the operator 2026-08-27)

- **No Share, no row menu (⋯), no rename, no delete.** Sharing is outside the
  MVP; REQ-173 makes only the scope editable and there is no delete route. A
  row is a link and nothing else.
- **No Chats / Sources tabs.** `SpaceRail` already carries Sources / Assistant /
  Notes; a tab would duplicate the rail.
- **Preview is the last `user` message**, truncated server-side. It is what the
  reference shows and it reads as "what I was asking about"; a truncated answer
  reads as noise.
- **Empty conversations are hidden** from the hub (`messageCount === 0`). The
  new flow creates none; existing ones stay in the DB and reachable by URL
  (REQ-170 — nothing is deleted).
- **Archived space**: the list still renders (reading stays allowed, REQ-174);
  the composer is replaced by the existing archived `Alert`.

## Non-goals

Deleting or renaming conversations; search or grouping by date; a conversation
list inside the thread route (the side nav is not coming back); pagination
(the list is bounded per space; revisit if a space exceeds a few hundred
threads); the wireframe's three-pane layout is untouched on the thread route.

## Cross-references

[[design]] · [[tasks]] · [[../phase-4-assistant/proposal]] ·
[[../../specs/assistant/spec]] REQ-169, REQ-170, REQ-171, REQ-173, REQ-174, REQ-177 ·
[[../../wireframe/index]] knowledge_assistant
