---
title: Phase 6 — Notebook & export — tasks
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [phase-6, notebook, export, tasks]
---

# Tasks: Phase 6 — Notebook & export

Work split by codebase; decisions are in [[design]]. Backend first — the
frontend's tests mock `api.ts`, but the export format is easier to settle
against a real serialiser.

## Backend

### Routes — `backend/src/routes/notebook.ts`

- [x] `GET /spaces/:id/notebook` — `assertOwnership`, `upsert` on `spaceId`
      with `EMPTY_DOC`, returns `{ id, spaceId, contentRich, updatedAt }`
- [x] `PUT /spaces/:id/notebook` — body `{ contentRich, baseUpdatedAt }`;
      409 `space_archived` before validation; 400 `invalid_document` with the
      offending path; 409 `notebook_conflict` carrying the current document;
      200 with the new `updatedAt`
- [x] Route-level `bodyLimit` from `config.ts` (`NOTEBOOK_BODY_LIMIT_BYTES`,
      default 2 MB) — not `AppConfig`; comment says why
- [x] `GET /spaces/:id/notebook/export.md` — `text/markdown; charset=utf-8`,
      `Content-Disposition: attachment; filename="<slug>-notebook.md"`, writes
      `notebook.exported` activity in the same request
- [x] Register in the app; 404 for a foreign space on all three

### Document handling — `backend/src/notebook/`

- [x] `validate-doc.ts` — node/mark/attr whitelist from [[design]], depth ≤ 100,
      link protocol check (`http:`, `https:`, `mailto:`), heading level 1–3,
      `citation` attrs typed; returns the first offending JSON path
- [x] `markdown.ts` — serialiser: header (name, objective), nodes in order,
      nested lists, blockquote prefixing, hard breaks, structural-only escaping,
      `[n]` by first appearance, `## Sources` list; source rows re-resolved
      against live `Source` rows by `sourceId` (title, author, `originalUrl`,
      page/paragraph from the node), "(source removed)" for missing ids
- [x] `slug.ts` (or reuse) — filename slug from the space name, ASCII-safe,
      fallback `notebook`

### Tests — `backend/test/notebook/`

- [x] Lazy create: first `GET` creates, second returns the same id; two
      concurrent first `GET`s yield one row
- [x] `PUT` round-trip; `GET` after `PUT` returns the saved document
- [x] `PUT` on an archived space → 409 `space_archived`, document unchanged
- [x] `PUT` with stale `baseUpdatedAt` → 409 `notebook_conflict` with the
      current document in the body; a matching base succeeds
- [x] `PUT` rejects: unknown node type, `codeBlock`, heading level 4,
      `javascript:` link, depth 101 — each 400 naming the path; the stored
      document is untouched
- [x] `PUT` over the body limit → 413, document unchanged
- [x] Ownership: foreign space → 404 on all three routes
- [x] Serialiser unit tests: every node/mark, nested lists, blockquote with
      two paragraphs, hard break, escaping cases, a citation cited twice keeps
      `[1]`, a removed source, a renamed source exports under the new title, no
      objective → no blockquote, no citations → no `## Sources`
- [x] Export route: headers, UTF-8 (a Vietnamese title round-trips), activity
      row written, notebook `updatedAt` unchanged after export
- [x] Log hygiene: Fastify's default request log carries method/url/status only, never the body — checked in the dev log during the hand test; no serializer change and no test

## Frontend

### Dependencies and setup

- [x] `pnpm add @tiptap/react @tiptap/starter-kit @tiptap/extension-link @tiptap/extension-placeholder`
      (pin; record versions in implementation notes)
- [x] `sheet` — already generated (`ui/sheet.tsx`); nothing added to `ui/`
- [x] `src/test/setup.ts` — ProseMirror jsdom stubs (`Range.prototype.getClientRects`,
      `getBoundingClientRect`, `document.elementFromPoint`) under the existing
      "what jsdom does not implement" comment
- [x] `src/lib/api.ts` — `Notebook` type, `notebookApi.get / put / exportUrl`,
      `ApiError` codes `notebook_conflict`, `invalid_document`

### Editor — `src/features/notebook/`

- [x] `extensions.ts` — StarterKit with `strike`, `code`, `codeBlock`,
      `horizontalRule` off, `heading.levels [1,2,3]`; Link (`openOnClick: false`,
      `autolink`, protocols); Placeholder ("Start drafting…"); `Citation` node
- [x] `citation-node.tsx` — inline atom; attrs per [[design]]; renders an `<a>`
      chip to `/spaces/:s/sources/:src?cite=…&page=|para=…&from=/spaces/:s/notebook`
      (the locator params the reader already resolves); accessible name "Open citation: <title>, page N";
      `title` = quoted text; "(source removed)" affix when the source is not in
      the space's list
- [x] `notebook-editor.tsx` — `useEditor`, `editable` from space state,
      `handleKeyDown` stopping `Mod+B` propagation; `Mod+S` → flush save
- [x] `toolbar.tsx` — H1 H2 H3 · B I · bullet ordered · quote · link · undo redo;
      real buttons, `aria-pressed`, `aria-label`s; link dialog on the
      hand-written `dialog` with a real `<label>`; `disabled` when not editable
- [x] `use-autosave.ts` — dirty tracking, 1.5 s debounce, flush on blur/Cmd+S,
      `PUT` with `baseUpdatedAt`, state machine `idle | saving | saved | failed | conflict | frozen`,
      exponential backoff (2 s → 30 s cap) for network/5xx/429, stop on
      400/401/404/409; `localStorage` draft write/clear/restore-offer;
      `beforeunload` while dirty
- [x] `save-status.tsx` — icon + text, `aria-live="polite"` updated on state
      change only; "Saved · just now" relative time; **Retry** / **Reload** /
      **Keep mine** where the state calls for them
- [x] `export-menu.tsx` — Copy to clipboard (fetch `export.md` → `writeText`,
      success/failure feedback, Retry on failure), Download Markdown (`<a href
      download>`), Print (opens `/print` route in the same tab)

### Research panel — `src/features/notebook/panel/`

- [ ] ~~Lift `NoteBody` out of `note-viewer.tsx`~~ — **not done**; the panel has its own read-only `NoteDetail` (see implementation notes)
- [x] `research-panel.tsx` — list state (search via `useNotes` `?q=`, cards
      with snippet/origin/citation count, empty and loading states, "Manage
      notes →" link) and open-note state (`NoteBody`, back control, **Insert
      citation** on each card calling the editor command, reader link with
      `from=/spaces/:s/notebook`)
- [x] Collapse toggle at `lg+`; `sheet` below `lg` from a header button; focus
      returns to the trigger on close (§18)

### Routes and shell

- [x] `src/routes/notebook-page.tsx` — `/spaces/:spaceId/notebook`; header with
      title "Notebook", save status, Export menu, panel toggle; `max-w-2xl`
      editor column; archived banner + read-only editor + no toolbar
- [x] `src/routes/notebook-print-page.tsx` — `/spaces/:spaceId/notebook/print`;
      read-only render, name/objective above, `## Sources` below (titles from
      the space's source list), `@media print` rules, `window.print()` after
      paint; outside `SpaceShell`
- [x] `space-shell.tsx` — Notebook rail item (lucide `NotebookPen`), active
      state, and the "Phase 6" comment retired
- [x] `React.lazy` the notebook and print routes so ProseMirror stays off the
      other routes' bundles

### Tests — `src/features/notebook/*.test.tsx`, `src/routes/notebook-page.test.tsx`

- [x] Toolbar toggles bold/italic/heading/lists/quote; `aria-pressed` follows
      the selection; undo/redo
- [x] Link dialog: label present, invalid protocol refused with a field error,
      valid link applied
- [x] Cmd+B in the editor bolds and does **not** toggle the rail; Cmd+B with
      focus outside the editor still toggles it
- [x] Autosave: one `PUT` after a burst of edits; `Saving` → `Saved` text and a
      single live-region announcement; blur flushes; Cmd+S flushes
- [x] Failure: 500 → `Save failed` + Retry, automatic retry with backoff (fake
      timers), draft written to `localStorage`, cleared on success
- [x] Conflict: 409 → conflict state, Reload replaces the document after
      confirmation, Keep mine re-PUTs with the server's `updatedAt`
- [x] Draft restore: matching base applied silently; older base offers
      Restore/Discard; storage throwing does not break the page
- [x] Panel: notes listed, search filters, opening a note does not remount the
      editor (same DOM node before/after) and does not cancel a pending save
- [x] Insert citation inserts one node at the selection; the chip's `href`,
      accessible name, and `title`; "(source removed)" when the source is absent
- [x] Archived space: editor not editable, toolbar absent, Export present,
      Insert citation absent
- [x] Print page: no toolbar/rail/buttons in the DOM, sources listed, `[n]` in
      place of chips, `window.print` called once
- [ ] 320px: no horizontal scroll — **not verified**; the column is `min-w-0 flex-1` and the panel becomes a sheet below 1024px, but nobody looked

## Wiki (on close)

- [x] `specs/notebook/spec.md` and `specs/export/spec.md` — new capabilities,
      REQ-242 onward, written from verified behaviour; `Verification` section
      with suite totals and the not-covered list
- [x] `specs/notes/spec.md` — unchanged: nothing was lifted out of the viewer
- [x] `wireframe/index.md` — `research_notebook` row: implemented, what was
      left out (Citations tab, cross-space search)
- [x] `space-sidebar/tasks.md` — Cmd+B item: resolved here
- [x] `index.md` plan row → done; `log.md` update entry

## Exit criteria

- Every PRD §13 and §14 acceptance criterion in [[proposal]] is demonstrated
  by a named test or a recorded manual check.
- `pnpm lint`, `pnpm build`, and both suites green; suite totals recorded.
- Checked by hand against the running stack: type, wait, refresh — the text is
  there; kill the API mid-edit — `Save failed`, keep typing, restart the API —
  `Saved` with nothing lost; open a note, insert a citation, click it — the
  reader opens on the passage with a way back; download the Markdown and open
  it in a plain editor; print to PDF and confirm no control is on the page.
- Looked at in a browser at 1280px and 320px — **or** recorded as not done, as
  the last six plans had to.

## Implementation notes (2026-08-27)

Deviations from [[design]] and things a later phase must know:

- **`NoteBody` was not lifted.** `NoteViewer` interleaves display and edit mode
  line by line; extracting the display half would have touched every notes test
  to save ~40 lines. The panel renders its own read-only `NoteDetail`
  (`features/notebook/panel/research-panel.tsx`), which duplicates the citation
  card. Unify when notes get a Tiptap editor. Recorded as `Written-vs-built` in
  [[../../specs/notebook/spec]].
- **`api.ts` grew** `api.put`, `requestText` (the Markdown body is not JSON),
  and `ApiError.body` — the conflict response carries the server's notebook
  beside the envelope and the client needs it.
- **`@tiptap/core` is a direct dependency** as well as `@tiptap/pm`: the node
  definition imports its types and pnpm does not hoist them. Versions pinned at
  `^3.30.5`.
- **Source presence needs two list queries** (`useSources(spaceId)` and
  `{ archived: 'only' }`): the list route has `exclude`/`only` and no
  `include`. An archived source counts as present — it still opens in the reader.
- **"Saving…" appears on the first keystroke**, not only while the request is
  in flight — the design's diagram had a dirty state with no label; a 1.5 s
  gap with no feedback read as nothing happening.
- **Terminal saves:** 400/401/404/409 stop the loop and keep the text; 413 also
  stops but the next edit tries again (a smaller document may fit). The 413 is
  Fastify's own `FST_ERR_CTP_BODY_TOO_LARGE`, not an `AppError`; the client keys
  on the status.
- **Write rate 120/minute** — two saves a second sustained — chosen here; the
  design did not say.
- **The print view keeps both renderings in the DOM:** the chip (`print:hidden`)
  and the `[n]` marker (`hidden print:inline`), toggled by CSS. Screen readers
  in the print route see the chip's label; on paper only `[n]` prints.
- **CommonMark emphasis:** the hand test exported `**Ngủ trưa **[1]`, which no
  renderer reads as bold. The serialiser now moves edge whitespace outside the
  delimiters (REQ-259) — found by looking at real output, not by the unit tests
  written from the design.
- **History grouping:** Tiptap groups edits within 500 ms into one undo step, so
  the toolbar test could not undo the quote alone; it resets to a paragraph
  instead. Nothing to change in the product.
- **jsdom needed three more stubs** (`Range.getClientRects`,
  `Range.getBoundingClientRect`, `document.elementFromPoint`) for ProseMirror,
  added under the existing comment in `src/test/setup.ts`; `immediatelyRender:
  true` so the editor exists on the first render.
- **The 500 kB chunk warning** is the main bundle (523 kB); it carries no
  ProseMirror (the notebook route is a 311 kB lazy chunk). Not introduced by
  this plan and not addressed by it.
- **Outstanding, again:** the Chrome extension was not connected, so nothing
  was looked at in a browser — the sticky toolbar, the chip, the 360px panel
  and its sheet, 320px, the clipboard, and the print dialog are unverified
  visually. Two `tasks` above stay unticked for that reason.

Suites: backend 227 → 253, frontend 189 → 213; `pnpm lint` and `pnpm build`
clean in both.

## Review fixes (2026-08-27)

A `/review-code` pass over the uncommitted diff. Fixed, each with a test:

- **Mount-time save (blocking).** `editor.setEditable(editable)` in an effect
  emits `update` even when the value is unchanged (Tiptap 3 default), so every
  open marked the document dirty, `PUT` an identical copy, and bumped
  `updatedAt` under any other tab. Now `setEditable(editable, false)`; test
  "opening the notebook without editing saves nothing".
- **401 bypassed the session-lost rule.** The save runs outside TanStack, so
  `query-client.ts`'s `onError` never saw it; autosave now sets `authKeys.me`
  to `null` itself and the guard redirects. `requestText` shares the envelope
  parser with `request` (`envelopeError`).
- **400 locked the editor for good.** `stoppedRef` stayed set, so later edits
  never saved. 400 and 413 now stop only until the next edit; 404 and the
  archived 409 stay final.
- Whitelist refuses empty `bulletList` / `orderedList` / `listItem` /
  `blockquote` (three more `it.each` rows).
- Export menu's "Copied" reset timer is cleared on unmount; `autosaveRef` is
  declared before `useEditor` so no callback can hit a TDZ; dead conditional and
  double-evaluated error removed on the page; `window.print?.()` → `window.print()`;
  the combining-marks regex written as `\u0300-\u036f`.

After: backend 253 → 256, frontend 213 → 224 (+4 editor, +4 export menu, +3
`requestText`); lint and build clean in both.
