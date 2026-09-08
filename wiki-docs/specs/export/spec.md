---
title: Export — spec
kind: spec
status: current
sources:
  - PRD §14 (notebook export), §15 (activity), §16 (states), §17 (security)
  - backend/src/routes/notebook.ts, backend/src/notebook/markdown.ts
  - backend/test/notebook.test.ts
  - frontend/src/features/notebook/export-menu.tsx, frontend/src/features/notebook/render-doc.tsx, frontend/src/routes/notebook-print-page.tsx
  - frontend/src/routes/notebook-page.test.tsx
created: 2026-08-27
updated: 2026-08-27
tags: [export, markdown, print, spec]
---

# Spec: Export

PRD §14's three ways the notebook leaves the product — Markdown file,
clipboard, print — written from the verified Phase 6 implementation
([[../../plan/phase-6-notebook-export/proposal]]). The document it exports is
specified in [[../notebook/spec]].

## Scope

Covers `GET /spaces/:id/notebook/export.md`, the Markdown format, the Export
menu, and the print route. Does **not** cover DOCX/HTML/PDF generation (not
§14) or the activity feed that reads the rows this writes (Phase 7).

## Markdown (PRD §14)

### REQ-256 — One serialiser, on the server, read by download and clipboard alike

`GET /spaces/:id/notebook/export.md` MUST answer the notebook as
`text/markdown; charset=utf-8` (no BOM) with
`Content-Disposition: attachment; filename="<slug>-notebook.md"`, where
`<slug>` is the space name folded to ASCII (Vietnamese diacritics to base
letters, `đ` → `d`), lowercased, non-alphanumerics to `-`, or `notebook` when
nothing survives. **Download Markdown** MUST be a plain link to this URL and
**Copy to clipboard** MUST fetch the same URL and write its text — there is
no second serialiser. Export MUST NOT modify the notebook (`updatedAt`
unchanged) and MUST work on an archived space.

### REQ-257 — The file carries name, objective, content in order, references, and sources

The Markdown MUST be, in order: `# <space name>`; `> Objective: …` when the
space has an objective (omitted otherwise); the document's blocks in order;
and, only when the document carries a citation, `## Sources` followed by one
row per distinct citation. Notes are never included (§14): only what the user
put in the document is exported.

Blocks and marks map as: heading → `#`×level; bold → `**`; italic → `*`;
link → `[text](href)`; bulleted list → `- `; numbered list → `n. ` from its
`start`, nested content indented to the marker's width; block quote → every
line prefixed `> ` (blank lines as `>`); hard break → two spaces + newline.

### REQ-258 — Citations are numbered by first appearance and resolved live

Each `citation` node MUST render inline as `[n]`, `n` being the order of
first appearance of its `citationId`; a citation used twice reuses its number.
The `## Sources` row `[n]` MUST read the **live** `Source` row by `sourceId` —
`title — author — p. N | ¶ ref — <url>` with absent fields skipped — so a
renamed source exports under its current name; a `sourceId` with no row MUST
print as `<copied title> (source removed)`.

### REQ-259 — Escaping is structural only and emphasis is valid CommonMark

Only characters that would change Markdown structure MUST be escaped:
`\ * _ ` [ ]` anywhere, and a line-leading `#`, `>`, `-`, `+`, or `1.`/`1)`.
Whitespace at either end of a bold or italic run MUST be moved outside the
delimiters (`**Ngủ trưa **` is not emphasis; `**Ngủ trưa** ` is). The output
MUST be deterministic — no date — so two exports of the same document are
byte-identical.

### REQ-260 — An export is recorded

A successful `export.md` MUST write one `Activity { kind: 'notebook.exported', spaceId, refId: notebookId }`
for the requesting user (§15). Print is client-side and is **not** recorded —
a decision, not an omission ([[../../plan/phase-6-notebook-export/design]]).
Accepted with it: a side effect on a cookie-authenticated `GET` (the session
cookie is `SameSite=Lax`, so a cross-site `<img>` cannot trigger it; a top-level
navigation could write one spurious row). Phase 7 SHOULD NOT copy this pattern
for anything a feed reads as a user action.

## The menu and the print view

### REQ-261 — Export is a menu with three actions and a failure state

The notebook page MUST offer an **Export** menu with **Copy to clipboard**,
**Download Markdown**, and **Print**. A copy failure MUST render a message with
**Retry** (§16); a successful copy MUST be announced. Export is offered on an
archived space.

### REQ-262 — Print shows the document and its references, and nothing else

`/spaces/:spaceId/notebook/print` MUST render, outside the space shell: the
space name as `h1`, the objective, the document read-only in the notebook
face, and — when citations exist — a `Sources` region numbered as REQ-258,
with titles from the space's source list (active and archived) and
`(source removed)` for a missing source. It MUST call `window.print()` once
after the data has painted, keep on-screen controls (`Back to notebook`,
`Print`) marked `print:hidden`, and print citation chips as `[n]`, links with
their URL, headings kept with their following paragraph (`break-after: avoid`,
`orphans`/`widows` 3).

## Verification

Verified 2026-08-27 in the suites and by hand:

| REQ | Where |
|---|---|
| REQ-256 | `backend/test/notebook.test.ts` (headers, filename slug for a Vietnamese name, no BOM, `updatedAt` unchanged, archived space exports; foreign space 404) · `frontend/src/features/notebook/export-menu.tsx` (the link and the fetch both use `notebookApi.exportPath`) |
| REQ-257 | `backend/test/notebook.test.ts` (every node/mark in order; objective omitted; no `## Sources` without citations) |
| REQ-258 | `backend/test/notebook.test.ts` (first-appearance numbering with a repeat, renamed source under its live title, removed source) |
| REQ-259 | `backend/test/notebook.test.ts` (structural escapes; whitespace moved outside `**`/`*`) |
| REQ-260 | `backend/test/notebook.test.ts` (one `notebook.exported` row, user and `refId`) |
| REQ-261 | `frontend/src/routes/notebook-page.test.tsx` (Export present on active and archived spaces) · `frontend/src/features/notebook/export-menu.test.tsx` (three items with their hrefs; copy writes the server text and announces; a 500 shows the envelope message with Retry which then copies; a refused clipboard is a failure state) · `frontend/src/lib/api-text.test.ts` (`requestText` envelope, non-JSON, network) |
| REQ-262 | `notebook-page.test.tsx` (name, objective, heading, `Sources` region with live title and removed source, `window.print` once, no toolbar/textbox, controls `print:hidden`) |

Checked by hand: `curl` of `export.md` for a live space with a Vietnamese name
and objective — `content-disposition: attachment; filename="giac-ngu-tri-nho-notebook.md"`,
UTF-8 body. That export showed `**Ngủ trưa **[1]`, which CommonMark does not
read as bold; REQ-259's whitespace rule and its test were added and the serialiser
fixed in the same session.

Not verified: the real clipboard write and the print dialog themselves
(browser APIs; the Chrome extension was not connected) and how the printed page
looks.

## Cross-references

- [[../notebook/spec]] — the document and its citation node.
- [[../../plan/phase-6-notebook-export/design]] — "Markdown is serialised on the server, once"; "`GET` writes the activity"; "Print is a route".
