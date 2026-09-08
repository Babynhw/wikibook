---
title: Phase 6 — Notebook & export — design
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [phase-6, notebook, export, tiptap, autosave, design]
---

# Design: Phase 6 — Notebook & export

Decisions, each with the alternative it rejected and the cost it accepts.
[[proposal]] says what and why; [[tasks]] splits the work.

## Data

### No migration; the document is the only state (decided 2026-08-27)

`Notebook { id, spaceId @unique, contentRich Json, createdAt, updatedAt }` is
enough. The document is stored as Tiptap/ProseMirror JSON — the same shape
`Note.contentRich` already uses, so `extractDocText` and the backend's
`extractPlainText` twin both read it unchanged.

*Rejected:* a `NotebookCitation` join table (or `Citation.notebookId`) so the
notebook's citations are rows. It buys a clean query for "sources cited by this
notebook" at the price of a migration, a second write path on every save (diff
the nodes, upsert the rows), and a cascade design for note/source deletion.
The export needs that list once, at export time, and can walk the document.

*Cost:* "which notebooks cite source X" is not a query. Nothing in the PRD asks
for it.

### Lazy creation by `upsert` (executes the 2026-08-11 decision)

`GET /spaces/:id/notebook` runs `upsert({ where: { spaceId }, create: { contentRich: EMPTY_DOC }, update: {} })`.
Idempotent under concurrent first opens because `spaceId` is unique. `EMPTY_DOC`
is `{ type: 'doc', content: [{ type: 'paragraph' }] }` — what Tiptap produces for
an empty editor, so the first save is not a spurious change.

## API

| Route | Does |
|---|---|
| `GET /spaces/:id/notebook` | Lazy-creates; returns `{ id, spaceId, contentRich, updatedAt }`. Archived spaces read fine. |
| `PUT /spaces/:id/notebook` | Body `{ contentRich, baseUpdatedAt }`. Validates the document (below). 409 `space_archived` (REQ-100). 409 `notebook_conflict` when `baseUpdatedAt !== notebook.updatedAt`, with the current `{ contentRich, updatedAt }` in the body so the client can show it. 200 with the new `updatedAt`. |
| `GET /spaces/:id/notebook/export.md` | `text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="<slug>-notebook.md"`. Writes a `notebook.exported` activity. |

All three register `assertOwnership` on the space and answer 404 for a foreign
space (CLAUDE.md). `PUT` is the only write; export is read-only against the
notebook and writes only the activity row.

### Whole-document PUT, not a patch stream (decided 2026-08-27)

Every save sends the full document.

*Rejected:* ProseMirror steps / a collab protocol. It is the right shape for
real-time collaboration, which §20 excludes, and it turns the server into a
document authority with its own version vector.

*Cost:* payload grows with the document. Fastify's route-level `bodyLimit` is
set to 2 MB for this route — a server safety bound, not a §5 product limit, so
it lives in `config.ts` beside the other non-§5 knobs, not in `AppConfig`. A
document that trips it gets the ordinary "Save failed" state; the draft stays
in the browser. Roughly a 1 MB document is a book chapter with a citation in
every paragraph; if it becomes a real ceiling, that is the moment for a §5-style
configurable limit and a plan, not now.

### Optimistic concurrency on `updatedAt` (decided 2026-08-27)

The client sends the `updatedAt` it last received; a mismatch is 409
`notebook_conflict`.

*Rejected:* last-write-wins. Simpler, and this is a single-user product — but
the failure it allows is exactly the one §13 forbids: a stale tab left open
overwrites an hour of work in another tab, silently, with a green "Saved".

*Cost:* one more failure state. The client renders it as *Save failed — this
notebook changed in another tab*, keeps the local draft, and offers **Reload**
(discarding the local draft after confirmation) or **Keep mine** (re-PUT with
the server's `updatedAt`). No merge; that is collaboration.

### Document validation is a whitelist (decided 2026-08-27)

The server accepts exactly: `doc`, `paragraph`, `heading` (`level` 1–3),
`text`, `bulletList`, `orderedList` (`start`), `listItem`, `blockquote`,
`hardBreak`, `citation` (attrs below); marks `bold`, `italic`, `link`
(`href` must parse as `http:`, `https:`, or `mailto:`). Depth is bounded at
100, mirroring `extractPlainText`. Anything else answers 400
`invalid_document` naming the first offending path.

*Rejected:* storing whatever the client sends, since the client is ours. The
document is later rendered in a print view and serialised to Markdown; an
unknown mark is a rendering surprise at best and a stored `javascript:` link at
worst (§17).

*Cost:* adding an editor feature is a two-sided change. That is the point.

## The citation node

```
citation (inline, atom)
  attrs: citationId, sourceId, sourceTitle, page, paragraphRef, quotedText
```

### The node copies its locator (decided 2026-08-27)

Inserting a citation copies the `Citation` row's locator into the node rather
than referencing the row alone.

*Rejected:* `citationId` only, resolved on render. Clean, but a `Citation` row
belongs to its note (`noteId`, cascade on delete) or its source (`sourceId`,
cascade on permanent delete — §17 requires exactly that). A notebook that
outlives the note it drew from would be full of chips that resolve to 404 and
say nothing.

*Behaviour it buys:*

- **Open:** the chip is a link to
  `/spaces/:s/sources/:src?cite=<citationId>&page=<n>|para=<ref>&from=/spaces/:s/notebook`.
  The reader already resolves in that order — passage, then the `page` / `para`
  the link carries, then the top of the source with "the cited location is
  gone" (`use-source-content.ts`, `resolveTarget`) — so a chip whose `Citation`
  row is gone still lands the user on the right page or paragraph, because the
  node carried the locator itself. When the *source* is
  gone the reader answers 404 and the chip renders with a "source removed"
  affix — determined at render time from the space's source list, which the
  page already has for the panel.
- **Export:** the Markdown serialiser needs no join; it walks the document,
  numbers citations by first appearance, and builds the source list from the
  copied attrs, re-reading the live title/author/url for any `sourceId` that
  still exists so a renamed source exports under its current name.

*Cost:* a copied `sourceTitle` can go stale in the editor between a rename and
the next render that re-resolves it; and `quotedText` makes the node heavier
than an id. Both are accepted for a notebook that never shows a dead chip.

### Insertion is an explicit action from the panel

A citation card in the Research panel's open note has **Insert citation**,
which inserts the node at the editor's current selection (or at the end when
the editor has no selection). Nothing is inserted on save, on note open, or on
copy. §20's "automatic insertion of notes into the notebook" is not touched:
one click, one node, chosen by the user.

*Rejected:* copying rich HTML onto the clipboard from the note viewer so a
paste becomes a node. It works in Chromium, degrades to plain `[n]` elsewhere,
and depends on `ClipboardItem` permissions the user has no reason to grant.
Plain copy/paste of note text stays exactly that — text — which is what §13's
"copy text from a note into the notebook manually" says.

*Rendering:* an inline `<a>` chip `[Smith 2023, p. 4]` in the label face, with
the accessible name "Open citation: <title>, page 4" (the REQ-186 pattern), and
`title` carrying the quoted text. Selectable and deletable as one atom.

## The editor

### Tiptap, StarterKit minus what §13 does not list (decided 2026-08-27)

`@tiptap/react` + `@tiptap/starter-kit` with `strike`, `code`, `codeBlock`,
`horizontalRule` **disabled**, plus `@tiptap/extension-link` (`openOnClick:
false` while editable; `autolink` on; protocols restricted as the server
validates) and `@tiptap/extension-placeholder`. Headings limited to levels
1–3. Pasted HTML that uses a disabled node is flattened to text by
ProseMirror's schema — the server never sees it.

*Rejected:* a hand-rolled `contenteditable`, or Lexical. Tiptap has been the
named editor since the first architecture note, has the custom-node API the
citation needs, and produces the JSON `Note.contentRich` already stores.

*Cost:* ~120 KB of ProseMirror in the bundle, loaded only on the notebook route
(`React.lazy`). And jsdom: ProseMirror needs `Range.getClientRects` /
`getBoundingClientRect` / `elementFromPoint` stubs, added to `test/setup.ts`
under the same "what jsdom does not implement" comment Base UI's stubs live
under.

### Cmd+B stops at the editor (decided 2026-08-27)

Tiptap's `editorProps.handleKeyDown` calls `event.stopPropagation()` for
`Mod+B` (and returns `false` so Tiptap's own keymap still runs). The generated
`sidebar.tsx` listens on `window`; the event never gets there.

*Rejected:* editing the generated file (forbidden by frontend/CLAUDE.md);
wrapping `SidebarProvider` to drop its shortcut (it is registered in an effect
with no prop to disable it); rebinding bold to another chord (every editor a
user has used binds Cmd+B).

*Cost:* with the caret in the editor, Cmd+B never toggles the rail. That is the
precedence a writing surface should have; the rail's trigger button is one click
away. Elsewhere on the page the shortcut works as before.

### Toolbar: buttons with `aria-pressed`, no floating menu

One sticky row above the column: H1 H2 H3 · B I · • 1. · " · link · undo redo.
Each is a real `<button>` with an accessible name and `aria-pressed` for
toggles (§18). The link button opens the existing `dialog` primitive with a
labelled URL field — a `window.prompt` would be a modal the browser tools cannot
dismiss and a §18 failure.

*Rejected:* a bubble menu on selection. Pretty, and invisible to a keyboard
user until the selection exists.

## Autosave

```
edit ──▶ dirty ──(1.5 s idle, or blur, or ⌘S)──▶ PUT ──▶ Saved (updatedAt ← response)
                                                  │
                                                  └─ fail ──▶ Save failed · Retry
                                                              backoff 2 s → 4 s → … → 30 s cap
                                                              (4xx other than 409/5xx: stop, keep draft)
```

### Debounce at 1.5 s, flush on blur and on Cmd+S (decided 2026-08-27)

Well inside §19's two seconds for the *round trip*, and long enough that a
typing burst is one request. Blur flushes so a click to the panel saves first;
Cmd+S flushes because every writer presses it, and eating the browser's save
dialog is the kinder behaviour.

*Rejected:* saving on every change (a request per keystroke) and a fixed
interval (a 10 s window of loss for no benefit).

### Retry is automatic for the failures that are temporary

Network errors, 5xx, and 429 retry with exponential backoff, forever while the
document is dirty, with **Retry** available at any time. 409 `notebook_conflict`
stops and asks (above). 409 `space_archived`, 400 `invalid_document`, 401, 404
stop and say why; the draft is kept and the editor stays editable except for
the archived case. Any successful save resets the backoff.

### The draft outlives the tab (decided 2026-08-27)

While dirty, the document and its `baseUpdatedAt` are written to `localStorage`
under `notebook-draft:<notebookId>`; a successful save clears it. On load, a
draft whose `baseUpdatedAt` equals the server's `updatedAt` is applied silently
(the server has not moved; the draft is simply newer). A draft whose base is
*older* than the server's is offered — "You have unsaved changes from
<time>. Restore or Discard" — never applied on its own. `beforeunload` warns
while dirty.

*Rejected:* relying on the retry loop alone. §13 says content must not be lost
when a save fails; a closed tab is the common way a failed save becomes a lost
one. `IndexedDB` (the README's other suggestion) buys nothing at this size.

*Cost:* `localStorage` is ~5 MB per origin, above the 2 MB body limit; a draft
that fails to write (private mode, quota) is caught and the state still works
without it, per the storage rules the SPA already follows.

### Save state is a live region that announces state, not keystrokes

`Saving…` / `Saved` / `Save failed` render as text with an icon (never colour
alone, §18) in the header, in an `aria-live="polite"` region that is updated
only when the *state* changes — the REQ-187 pattern from the assistant.
"Saved" shows the relative time ("Saved · just now") without announcing every
minute tick.

## The Research panel

### A side panel on the notebook route, not the notes page's drawer (decided 2026-08-27)

The notebook page composes a right-hand panel (wireframe: "Research Panel")
with two states: the note list, and one note open with a back control. The
editor stays mounted throughout — the panel is sibling state, not a route
change — which is what §13/§19 mean by "open notes without leaving the
notebook" and "must not reload the notebook". A test asserts the editor's DOM
node identity survives opening and closing a note (the detached-element bug
[[../space-sidebar/tasks|space-sidebar]] found is the precedent).

*Rejected:* reusing `NoteViewer`'s drawer over the editor. It covers the text
being written and carries the edit mode this panel deliberately lacks.

*Reuse:* the read-only body of `NoteViewer` (title, origin badge, content,
citation cards) is lifted into a `NoteBody` component both compose; the drawer
keeps its edit/delete/convert footer, the panel replaces that footer with
**Insert citation** on each card and a link to the note on the notes page.

*Layout:* panel 360px at `lg` and up, collapsible to a strip with a toggle;
below `lg` it becomes the shadcn `sheet` the sidebar already generated (no new
`ui/` file), opened from a header button. The editor column is `max-w-2xl`
centred, matching the reader (REQ-236) and DESIGN.md's 60–75 characters.

## Export

### Markdown is serialised on the server, once (decided 2026-08-27)

`GET …/export.md` is the single serialiser. **Download** is an `<a href>` to it;
**Copy to clipboard** fetches it and writes the text with
`navigator.clipboard.writeText` (plain text; no `ClipboardItem`). Print is
client-rendered (below) — it needs layout, not Markdown.

*Rejected:* serialising in the browser. There is no shared package between
`backend/` and `frontend/`, so a client serialiser would be a second copy of
the document walk that the server also needs for the source list; and a
downloaded file coming from a URL is what makes `<a download>` work without
a Blob.

*Format:*

```markdown
# <Space name>

> Objective: <objective>          ← omitted when the space has none

<content, in order>
  # / ## / ###      headings by level
  **bold** *italic* [text](url)
  - item / 1. item  (nested by two spaces)
  > quote           (each line prefixed)
  two-space + \n    hard break
  [n]               citation, n = order of first appearance

## Sources                          ← omitted when no citation is present

[1] <Title> — <author or host> — p. 4 / ¶ 12 — <url for web sources>
[2] <Title> (source removed)
```

Text is escaped only where it would change structure (`*`, `_`, `` ` ``, `[`,
a leading `#`/`>`/`-`/`1.`); nothing else, so the file reads as prose in a
plain editor (§14). UTF-8 without BOM. The date is not in the file — a
deterministic export is testable and diffable; the filename carries the space.

### `GET` writes the activity (decided 2026-08-27)

`export.md` inserts `Activity { kind: 'notebook.exported', spaceId, refId: notebookId }`
inside the request. A side effect on a `GET` is impure; the alternative — a
`POST` that returns a file — breaks the plain `<a href download>` and the
clipboard path would need a second call.

*Cost:* print is client-side and is **not** recorded as an export. Phase 7 can
add a `POST /spaces/:id/notebook/exports` if the feed needs it; it is written
down here so the gap is a decision, not an omission.

### Print is a route with `@media print`, not a PDF library

`/spaces/:spaceId/notebook/print` renders the document read-only (the same
node renderers as the editor, non-editable) with the space name and objective
above and the source list below, then calls `window.print()` once the
document has painted. The stylesheet hides the shell, the rail, and every
control; `h1–h3 { break-after: avoid }` and `p { orphans: 3; widows: 3 }` keep
headings with their paragraphs "where practical" (§14). Citation chips print as
`[n]`; links print with their URL after the text.

*Rejected:* generating a PDF (puppeteer, pdfkit). §14 says "browser print and
save as PDF"; a server renderer is a dependency, a font problem, and a second
layout engine for a feature the browser already has.

*Source titles* for the print view come from the space's existing source list
route, so a renamed source prints under its current name without a new
endpoint.

## Archived spaces

`GET` works; `PUT` answers 409 `space_archived` and the client renders the
editor with `editable: false`, no toolbar, the archived banner, and Export
still offered. The panel opens notes read-only as ever. This is REQ-100 applied,
and the banner's "read-only" claim is true of every control on the page.

## Cross-references

- [[proposal]] · [[tasks]]
- [[../phase-1-spaces/design]] — lazy creation, REQ-100.
- [[../../specs/notes/spec]] — `contentRich` shape, `extractPlainText`, the
  citation payload the panel reads.
- [[../../specs/library-reader/spec]] — REQ-139 (`?cite=`/`?from=`), REQ-236
  (the reading column).
- [[../../specs/assistant/spec]] — REQ-186/187, the marker and live-region
  patterns reused here.
- [[../space-sidebar/proposal]] — the generated `sidebar.tsx`, its shortcut,
  and the detached-element lesson.
