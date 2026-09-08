---
title: Vietnamese UI localization — design
kind: plan
status: proposed
created: 2026-09-08
updated: 2026-09-08
tags: [frontend, localization, vietnamese]
---

## Locale strategy

The first release defaults to Vietnamese and provides a compact, labelled
Vietnamese/English toggle in the authenticated header and unauthenticated auth
layout. The choice is stored in `localStorage`; it does not infer a locale from
the browser. A missing or invalid value falls back to Vietnamese.

## Translation boundary

UI-owned copy moves behind a small frontend translation module and language
context. API data and
user-authored or model-authored content stays outside it. Components continue
to render titles, names, URLs, quotes, answer markdown, note bodies, and
notebook documents directly. This boundary prevents a UI translation pass from
silently changing evidence or research output.

## Error handling

Known client-side errors receive Vietnamese messages at the presentation
boundary. The client keeps the server error code for control flow and telemetry,
while the displayed fallback is Vietnamese. Server-provided domain messages are
translated only when their stable error code is known; unknown messages use one
Vietnamese generic fallback and are not interpolated into unsafe UI text.

## Date and terminology

Dates and relative times use `vi-VN`. Product terms are fixed in the translation
catalog: `Space` is `Không gian`, `Source` is `Nguồn`, `Assistant` is `Trợ lý`,
`Note` is `Ghi chú`, `Notebook` is `Sổ tay`, `Members` is `Thành viên`, and
`Activity` is `Hoạt động`. Technical model names, source types, and URLs remain
unchanged.

## Accessibility

Every translated visible label, button name, live-region message, dialog label,
and status text is translated together with its visual copy. Tests should query
roles and accessible names in Vietnamese where the user-facing name is part of
the contract.

## Alternatives rejected

- **Scattered literal replacements:** rejected because the same English phrase
  appears in multiple states and would drift.
- **Large i18n dependency:** rejected for the one-locale MVP; it adds loading,
  key extraction, and pluralization concerns without a second locale.
- **Translate all strings returned by the API:** rejected because source and
  research content are evidence, not interface chrome.
- **Change assistant prompts globally:** rejected because UI locale and answer
  language are separate product controls; the audience note owns answer style.

## Verification

Implementation must run the frontend unit/accessibility suite, lint, build, and a
browser smoke check against the running stack. The assistant's generated answer
and citations must be checked for verbatim content boundaries.
