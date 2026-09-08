---
title: Notebook — spec
kind: spec
status: current
sources:
  - PRD §2 (Notebook), §13 (research notebook), §16 (states), §17 (security), §18 (a11y), §19 (performance), §20 (exclusions)
  - backend/src/routes/notebook.ts, backend/src/notebook/validate-doc.ts
  - backend/test/notebook.test.ts
  - frontend/src/features/notebook/, frontend/src/routes/notebook-page.tsx
  - frontend/src/features/notebook/notebook-editor.test.tsx, frontend/src/routes/notebook-page.test.tsx
created: 2026-08-27
updated: 2026-08-28
tags: [notebook, autosave, tiptap, spec]
---

# Spec: Notebook

The space's single continuous rich-text document (PRD §13): how it is read and
saved, what it may contain, how it saves itself, how a citation gets into it,
and how the notes sit beside it. Written from the verified Phase 6
implementation ([[../../plan/phase-6-notebook-export/proposal]]). Export is its
own capability, [[../export/spec]]. RFC 2119 keywords are load-bearing.

Ownership, sessions, and the error envelope are specified once in
[[../auth/spec]]; the frozen-space rule in [[../spaces/spec]] (REQ-100); the
reader a citation chip opens in [[../library-reader/spec]] (REQ-139); the notes
the panel shows in [[../notes/spec]].

## Scope

Covers `GET`/`PUT /spaces/:id/notebook`, the document whitelist, the editor,
autosave, the citation node, the Research panel, and the archived surface.
Does **not** cover: export ([[../export/spec]]); the notes themselves; the
activity feed (Phase 7).

## The resource (PRD §2, §13)

### REQ-242 — One notebook per space, created on first read

`GET /spaces/:id/notebook` MUST return the space's notebook, creating it with
the empty document `{ type: 'doc', content: [{ type: 'paragraph' }] }` when
none exists. Creation MUST be idempotent under concurrency (an `upsert` on the
unique `spaceId`), and MUST work on an archived space.

- GIVEN a space with no notebook row
- WHEN two `GET`s arrive together
- THEN both answer 200 with the same notebook id and one row exists.

### REQ-243 — A save is the whole document, guarded by the version it was based on

`PUT /spaces/:id/notebook` takes `{ contentRich, baseUpdatedAt }` and MUST
replace the document only when `baseUpdatedAt` equals the stored `updatedAt`
(a compare-and-set in the update's `WHERE`). A mismatch MUST answer 409
`notebook_conflict` **carrying the server's current `notebook`** in the body,
so the client can offer the server's copy without a second request. Success
answers the saved notebook with its new `updatedAt`.

- GIVEN tab A saved after tab B last read
- WHEN tab B saves with its stale base
- THEN 409 `notebook_conflict`, the body's `notebook.contentRich` is A's document,
  and a re-save with that `updatedAt` as base succeeds.

### REQ-244 — An archived space refuses the save and keeps the document

`PUT` on an archived space MUST answer 409 `space_archived` before validation
and MUST NOT change the document (REQ-100). `GET` stays available.

> [!note] Shared spaces v1 (2026-08-28)
> The save is editor-level (403 for a viewer). Payloads carry `updatedBy` and
> the 409 names the last saver; an advisory presence signal now sits in front
> of the compare-and-set, which stays the only arbiter
> ([[../sharing/spec]] REQ-301–REQ-303).

### REQ-245 — The document is validated against the editor's whitelist

The server MUST accept exactly: nodes `doc`, `paragraph`, `heading` (`level`
1–3), `text`, `bulletList`, `orderedList` (`start`), `listItem`, `blockquote`,
`hardBreak`, `citation`; marks `bold`, `italic`, `link` whose `href` parses
with protocol `http:`, `https:`, or `mailto:`. Containers MUST hold only what
Tiptap's schema allows (`listItem` → `paragraph block*`; inline nodes only
inside `paragraph`/`heading`). Nesting deeper than 100 MUST be refused, and a `bulletList`, `orderedList`,
`listItem`, or `blockquote` with no children MUST be refused (ProseMirror's
schema says `listItem+` / `block+`). Any
violation answers 400 `invalid_document` with `fields` naming the first
offending JSON path, and the stored document is untouched.

- GIVEN a body whose only fault is a `javascript:` link
- WHEN it is saved
- THEN 400 `invalid_document` with `fields['$.content[0].content[0].marks[0].attrs.href']`.

### REQ-246 — A save has a byte ceiling that is not a product limit

The `PUT` body MUST be bounded by `NOTEBOOK_BODY_LIMIT_BYTES` (env, default
2 MiB; `config.ts`, not `AppConfig`, because PRD §5 does not list it). Over the
bound answers 413 and the document is untouched.

### REQ-247 — Ownership and rate

Every notebook route MUST answer 404 for a foreign space and MUST NOT create a
row for one. Reads are limited at 600/minute, saves at 120/minute.

## The editor (PRD §13)

### REQ-248 — The editor offers §13's features and nothing else

The notebook editor MUST provide headings (three levels), paragraphs, bold,
italic, bulleted and numbered lists, block quotes, links, undo and redo, and
accept pasted formatted or plain text. It MUST NOT offer strike-through, code,
code blocks, horizontal rules, sections, tabs, or an outline (§20). The
toolbar MUST be a `role="toolbar"` of real `<button>`s with accessible names;
toggles carry `aria-pressed` that follows the selection (§18). The link
control MUST open a dialog with a labelled field and MUST refuse a non
`http(s)`/`mailto` address next to the field, keeping what was typed (§16).

### REQ-249 — ⌘/Ctrl+B is bold while the caret is in the editor

A `Mod+B` keydown inside the editor MUST toggle bold and MUST NOT reach
`window` — the generated sidebar's rail shortcut — while the same chord
outside the editor still toggles the rail. `Mod+S` MUST flush a pending save
and suppress the browser's dialog.

### REQ-250 — The editor is seeded once and never remounts for the panel

The editor MUST be seeded from the loaded notebook once; a refetch MUST NOT
re-seed it. Opening, reading, or closing a note in the Research panel MUST
leave the editor's DOM node in place (PRD §13 "without leaving the notebook",
§19 "must not reload the notebook"). The only replacement is an explicit
Reload after a conflict (REQ-252).

## Autosave (PRD §13, §16, §18, §19)

### REQ-251 — Saves are debounced, flushed on blur and ⌘S, and visible

An edit MUST mark the document dirty and schedule one save 1.5 s after the
last edit; blur and `Mod+S` MUST save at once. The state MUST render as text
with an icon — `Saving…`, `Saved` (with the time), `Save failed` — inside an
`aria-live="polite"` region whose text changes only when the state does.

- GIVEN two edits 100 ms apart
- WHEN 1.5 s pass
- THEN exactly one `PUT` is sent, with the base `updatedAt` the editor was seeded from.

### REQ-252 — Failures keep the text and either retry or ask

A network error, 5xx, or 429 MUST show `Save failed` with **Retry** and retry
on its own with exponential backoff (2 s doubling, capped at 30 s) until a
save succeeds. A 409 `notebook_conflict` MUST stop and offer **Reload**
(replace the document with the server's copy, drop the local draft) and
**Keep mine** (re-save with the server's `updatedAt` as base). A 409
`space_archived` or a 404 MUST stop for good and say why. A 400
`invalid_document` or a 413 MUST stop *until the next edit*, which tries again
— the fault is in that content, not the notebook. A 401 MUST mark the session
lost (`authKeys.me` → `null`, the rule `query-client.ts` applies to TanStack
calls, which this save is not) so the route guard redirects. In every case the
latest document stays in the editor and in the draft mirror.

### REQ-253 — The unsaved draft outlives the tab

While dirty, the document and its base `updatedAt` MUST be mirrored to
`localStorage` under `notebook-draft:<notebookId>`; a clean save clears it.
On load, a draft whose base equals the server's `updatedAt` MUST be applied
and saved without asking; a draft with an older base MUST be offered
("Restore" / "Discard") and never applied on its own. Storage that throws
MUST not affect editing or saving. `beforeunload` MUST warn while dirty.

## Citations in the notebook (PRD §13, §14)

### REQ-254 — A citation is an inline node that carries its own locator

A `citation` node MUST hold `citationId`, `sourceId`, `sourceTitle`, `page`,
`paragraphRef`, `quotedText`, copied from the note's citation at insert time.
It MUST render as a link to
`/spaces/:s/sources/:src?cite=<id>[&page=<n>][&para=<ref>]&from=/spaces/:s/notebook`,
with accessible name `Open citation: <title>, p. N` (or `¶ ref`) and `title`
= the quoted text. When the source is no longer in the space's source list
(active or archived), the chip MUST say `(source removed)`. Insertion happens
**only** through the panel's **Insert citation** control (§20 forbids
automatic insertion): one click inserts one node at the caret, or at the end
if the editor was never focused.

## The Research panel and the archived surface

### REQ-255 — Notes are readable and citable beside the editor; archived is read-only

The notebook route MUST show a Research panel (`role="region"` named
"Research panel") listing the space's notes with server-side search, and open
one note in place — title, origin, question, text, and its citations, each
with **Insert citation** and **Open in reader** — with a way back to the list.
It is read-only; editing lives on the notes page, which the panel links to.
The panel MUST be closable and reopenable; below 1024px it is a sheet. On an
archived space the editor MUST be non-editable with no toolbar, the status
MUST read `Read-only`, **Insert citation** MUST be absent, the banner MUST say
so, and Export MUST still be offered.

## Verification

Verified 2026-08-27 against the running stack (Postgres and Redis via docker
compose, API on `:4000` under `tsx watch`) and in the suites:

| REQ | Where |
|---|---|
| REQ-242 | `backend/test/notebook.test.ts` (first `GET` creates, second reuses; two concurrent `GET`s → one row; archived `GET` 200) |
| REQ-243 | `backend/test/notebook.test.ts` (round-trip, stale base → 409 with the current document, keep-mine re-save) |
| REQ-244 | `backend/test/notebook.test.ts` (archived `PUT` 409, document unchanged) |
| REQ-245 | `backend/test/notebook.test.ts` (eleven rejected shapes each naming its path — including empty list, item, and quote; depth 101; the full accepted set) |
| REQ-246 | `backend/test/notebook.test.ts` (2 MiB + 1 → 413, unchanged) |
| REQ-247 | `backend/test/notebook.test.ts` (foreign space 404 on all three routes, no row created) |
| REQ-248 | `frontend/src/features/notebook/notebook-editor.test.tsx` (toolbar toggles with `aria-pressed`, undo/redo, link dialog refusing `javascript:` next to the field and applying `https:`) |
| REQ-249 | `notebook-editor.test.tsx` (Ctrl/⌘+B bolds and never reaches a `window` listener; other chords do; ⌘S flushes) · `frontend/src/routes/notebook-page.test.tsx` (rail stays `expanded` on ⌘B in the editor, collapses on ⌘B elsewhere) |
| REQ-250 | `notebook-page.test.tsx` (editor DOM node identity equal before/after opening a note, inserting, and going back) |
| REQ-251 | `notebook-editor.test.tsx` (mounting without an edit sends **no** `PUT` and writes no draft — the `setEditable` regression; one `PUT` after a burst, base `updatedAt`, Saving → Saved) |
| REQ-252 | `notebook-editor.test.tsx` (500 → failed + Retry + automatic retry at 2 s; Retry button; conflict → Keep mine base / Reload replaces document; `space_archived` stops without retrying; 400 and 413 resume on the next edit; 401 nulls `authKeys.me` and keeps the draft) |
| REQ-253 | `notebook-editor.test.tsx` (same-base draft applied and saved; older-base draft offered, Discard clears, Restore applies and saves; throwing `setItem` harmless) |
| REQ-254 | `notebook-editor.test.tsx` (chip href, name, title, JSON node, end insertion) · `notebook-page.test.tsx` (insert from the panel reaches the `PUT`; `(source removed)`) |
| REQ-255 | `notebook-page.test.tsx` (list, open, back, close/reopen, archived: banner, `contenteditable=false`, no toolbar, no Insert, Export present, load failure with Retry) |

Suites: backend 227 → 256 (29 in `notebook.test.ts`); frontend 189 → 224
(20 editor, 8 page/print, 4 export menu, 3 `requestText`, one rail tab-order
test extended). A `/review-code` pass after the first green run found the
mount-time `PUT` (Tiptap's `setEditable` emits `update` even when unchanged),
the 401 that bypassed the session-lost rule, and the 400 that locked the editor
for good; all three are fixed and each has the test that was missing. `pnpm lint` and
`pnpm build` clean in both; ProseMirror lands in the lazy notebook chunk
(311 kB) and not in the main bundle.

Checked by hand over HTTP against the dev API (the routes were live under
`tsx watch` without a restart): register → create space → first `GET` creates
the empty document → `PUT` with a heading, a bold run, and a citation to a
non-existent source → a second `PUT` with the stale base answers 409 → unauth
`GET` answers 401. The export of that document is what found the `** bold **`
defect recorded in [[../export/spec]].

Not verified, by id: REQ-248/249/251/254/255's *rendering* — the Chrome
extension was not connected, so nothing was looked at in a browser: the sticky
toolbar, the chip's look, the 360px panel and its sheet below 1024px, 320px,
the clipboard write, and the print dialog are asserted only in jsdom and the
compiled stylesheet. REQ-253's `beforeunload` is not testable in jsdom.

> [!warning] Written-vs-built
> The design lifted a shared `NoteBody` out of `NoteViewer`; the panel instead
> has its own read-only `NoteDetail` (`panel/research-panel.tsx`), because the
> viewer's body interleaves its edit mode with its display and the extraction
> would have touched every notes test for a saving of ~40 lines. Recorded in
> the plan's implementation notes; a later Tiptap note editor is the moment to
> unify them.

## Cross-references

- [[../../plan/phase-6-notebook-export/proposal]] · [[../../plan/phase-6-notebook-export/design]]
- [[../export/spec]] — what leaves the notebook.
- [[../notes/spec]] — the notes the panel shows; REQ-214/215's editor stays a textarea.
- [[../library-reader/spec]] — REQ-139's `?cite=`/`?from=` and the locator fallback the chip relies on.
- [[../spaces/spec]] — REQ-100.
- [[../../plan/space-sidebar/proposal]] — the shortcut REQ-249 resolves.
