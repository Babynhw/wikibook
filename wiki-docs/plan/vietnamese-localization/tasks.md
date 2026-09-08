---
title: Vietnamese UI localization — tasks
kind: plan
status: proposed
created: 2026-09-08
updated: 2026-09-08
tags: [frontend, localization, vietnamese]
---

## Frontend

- [ ] Add the Vietnamese/English catalog, language context, persistence, and
      locale formatting helpers.
- [ ] Add the labelled language toggle to authenticated and auth layouts.
- [ ] Translate shared shell, navigation, auth, dialogs, forms, and common
      loading/error/empty states.
- [ ] Translate source library, reader, assistant, notes, notebook, members,
      invite, and activity surfaces.
- [ ] Translate accessible names, live regions, status labels, and validation
      messages alongside visible copy.
- [ ] Preserve source content, citation quotes, answer markdown, note bodies,
      and notebook document content verbatim.
- [ ] Add focused tests for locale text and content-boundary preservation.
- [ ] Run frontend lint, build, unit tests, and accessibility tests.
- [ ] Perform browser smoke verification against the live local stack.

## Backend

- [ ] No backend code change planned. API contracts and answer language remain
      unchanged.

## Exit criteria

- [ ] Acceptance criteria in `proposal.md` are demonstrated.
- [ ] This file is updated with implementation notes and all completed tasks.
- [ ] The relevant living specs are amended from verified behavior.
- [ ] `wiki-docs/index.md` and `wiki-docs/log.md` record closure.
