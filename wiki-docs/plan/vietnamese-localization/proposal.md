---
title: Vietnamese UI localization
kind: plan
status: proposed
created: 2026-09-08
updated: 2026-09-08
tags: [frontend, localization, vietnamese]
---

## Problem

The WikiBookLM SPA exposes most navigation, form labels, empty states, errors,
and accessibility text in English. Vietnamese-speaking users can read the
research content but must operate the product in English.

## Goal

Provide a Vietnamese interface for the existing MVP workflows while preserving
source text, citation quotes, notebook content, and model-generated answers in
the language selected by the user or requested by the space audience note.

## Scope

- Translate visible frontend chrome, navigation, buttons, forms, empty states,
  loading states, validation messages, and accessible labels.
- Establish Vietnamese as the initial UI locale and provide a persistent
  Vietnamese/English toggle for the interface.
- Keep API contracts, route paths, persisted content, source metadata, and
  assistant output unchanged.
- Use Vietnamese terminology consistently: space, source, reader, assistant,
  note, notebook, member, and activity.

## Out of scope

- Translating imported source content or citation quotations.
- Translating model answers or changing the assistant's answer language; that
  remains controlled by the space audience note and assistant rules.
- Browser-language negotiation, pluralization framework, or translation
  management service in this initial change.
- Backend error-message localization.
- Changes to the PRD exclusions or the visual design system.

## Acceptance criteria

1. The interface provides a clearly labelled toggle between Vietnamese and
  English, and preserves the selected language after reload.
2. A signed-in user can complete the existing home, space, source, reader,
  assistant, notes, notebook, members, activity, auth, and invite workflows
  with Vietnamese UI text.
3. Loading, empty, error, archived, read-only, and permission states have
   Vietnamese visible and accessible text.
4. Source titles, authors, URLs, note bodies, notebook content, citation quotes,
   and assistant answer text are rendered verbatim and are not translated.
5. Existing API behavior and route URLs remain unchanged.
6. Frontend lint, build, unit tests, and accessibility tests pass.
7. The plan is closed only after a browser smoke check covers sign-in, a space,
   source library, and assistant states.

## Cross-references

- [[specs/auth/spec]]
- [[specs/spaces/spec]]
- [[specs/ingestion/spec]]
- [[specs/library-reader/spec]]
- [[specs/assistant/spec]]
- [[specs/notes/spec]]
- [[specs/notebook/spec]]
- [[specs/sharing/spec]]
- [[specs/home-activity/spec]]
- [[../space-audience-style/proposal]]
