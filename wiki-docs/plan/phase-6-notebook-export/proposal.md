---
title: Phase 6 — Notebook & export
kind: plan
status: done
created: 2026-08-27
updated: 2026-08-27
tags: [phase-6, notebook, export, tiptap, autosave]
---

# Proposal: Phase 6 — Notebook & export

## Problem

A research space can hold evidence, conversations, and notes, but nowhere to
*write the finding*. PRD §13 gives every space exactly one continuous
rich-text notebook that saves itself and stays independent of the notes; §14
lets that notebook leave the product as Markdown, as a printed PDF, or on the
clipboard, carrying the citations it contains and the sources they point at.
Neither exists. The `Notebook` table has been in the schema since Phase 0
(`spaceId @unique`, `contentRich Json`) and
[[../phase-1-spaces/design#notebook-is-lazy-created-decided-2026-08-11|Phase 1 decided]]
its row would appear on the first `GET /spaces/:id/notebook` — a route that was
never written. Tiptap, named in the architecture since the first plan, is not
installed; the note editor is a `<textarea>` that round-trips paragraphs.

Two things were parked here by earlier plans and now come due:

- **Cmd+B.** The generated shadcn `sidebar` binds `⌘/Ctrl+B` on `window` to
  toggle the rail; Tiptap binds the same chord to bold
  ([[../space-sidebar/tasks|space-sidebar tasks]] records the collision and
  points at Phase 6).
- **The rail.** `space-shell.tsx` says "Notebook joins it when Phase 6 gives it
  a route".

## Goal

Open a space, press Notebook, and write — headings, lists, quotes, links — with
the save state always visible and never a keystroke lost to a failed request.
Keep the saved notes one panel away so a note can be read, and a citation from
it dropped into the draft, without leaving the editor or reloading it. Export
the draft as Markdown, print it, or copy it, with the space's name and
objective on top and a source list for every citation the draft carries.

```
                ┌──────────────────────────────┬───────────────────┐
 /spaces/:id/   │  toolbar · Saved ✓ · Export ▾ │ Research panel    │
    notebook    │                              │  ▸ notes (search) │
                │  # Draft title               │  ▸ one note open  │
                │  Prose … [Smith 2023, p.4] … │    ↳ Insert cite  │
                │                              │    ↳ Open reader  │
                └──────────────────────────────┴───────────────────┘
        autosave ──▶ PUT /spaces/:id/notebook        export.md ──▶ file / clipboard
                                                     /print   ──▶ browser print
```

## Scope

1. **Notebook read and write** (PRD §13) — `GET /spaces/:id/notebook`
   (lazy-creates the row, idempotent under concurrency) and
   `PUT /spaces/:id/notebook` (whole document, validated against a node/mark
   whitelist with the depth bound `notes` already uses; 409 on an archived
   space, REQ-100; 409 on a stale base version).
2. **The editor** — Tiptap with exactly the §13 features: headings,
   paragraphs, bold, italic, bulleted and numbered lists, block quotes, links,
   undo/redo, paste of formatted or plain text. A toolbar of real buttons with
   pressed state; a placeholder for the empty document.
3. **Autosave with visible state** (§13, §16, §18, §19) — debounced save,
   `Saving` / `Saved` / `Save failed — Retry`, automatic exponential retry,
   an unsaved draft kept in the browser until the server confirms, state
   changes announced through a live region, and a leave-page warning while
   dirty.
4. **Citations in the notebook** (§13 "open citations that have been copied
   into the notebook"; §14 "citation references present in the notebook") — an
   inline `citation` node inserted *by the user* from a note's citation, that
   renders as a control opening the cited passage in the reader with a way
   back to the notebook, and that survives — degraded, and saying so — the
   deletion of the note or the source it came from.
5. **The Research panel** — the `research_notebook` wireframe's right-hand
   panel: the space's notes (title, snippet, origin badge, citation count;
   the existing `?q=` title search), one note readable in place with its
   citations, each offering **Insert citation** and the reader link. Read-only
   here; editing stays on the notes page. Collapsible; a sheet below `lg`.
6. **Export** (§14) — `GET /spaces/:id/notebook/export.md` (UTF-8 Markdown:
   space name, objective, content in order, `[n]` inline references, a source
   list), **Download Markdown**, **Copy to clipboard** (the same Markdown),
   and a **Print** view that hides every control, keeps headings with their
   paragraphs, and lists the sources. Export never writes to the notebook.
   Markdown export writes a `notebook.exported` activity for Phase 7.
7. **Rail and route** — `/spaces/:spaceId/notebook`, a Notebook item in the
   rail, and the Cmd+B collision resolved in the editor's favour while the
   editor has focus.
8. **Archived spaces** — the editor is read-only, the panel and export still
   work, and the banner's claim and the offered actions agree (REQ-100).

## Out of scope

- **§20 exclusions that sit next to this feature:** notebook sections or tabs;
  an outline hierarchy; separate AI-generated notebook blocks; *automatic*
  insertion of notes or answers into the notebook (insertion here is one
  explicit user action per citation, never on save); Save Cited Passage;
  highlights or annotations; automated report generation; real-time
  collaboration (one user, one notebook — conflict is detected, not merged).
- **Wireframe elements without a PRD counterpart** — the panel's "Citations"
  tab, "Search Notebooks…" across spaces, `Private` visibility, the project
  chip, notifications. See [[../../wireframe/index]].
- **Editing or creating notes from the panel** — the notes page owns that
  ([[../../specs/notes/spec]]); the panel links to it.
- **Rich-text for notes.** The note `<textarea>` stays; a Tiptap note editor
  is its own change once the notebook has proven the extension set.
- **Export formats beyond §14** — DOCX, HTML, direct PDF generation. Print is
  the browser's print dialog.
- **Home and the activity feed** (§15) — Phase 7 reads the
  `notebook.exported` rows this phase writes.
- **A schema migration** — none is needed; the citation node carries its own
  locator (see design).

## Acceptance criteria

From PRD §13:

- The notebook behaves as one continuous document; there are no section tabs
  or section-management controls.
- The editor supports headings, paragraphs, bold, italic, bulleted lists,
  numbered lists, block quotations, links, undo and redo, and pasting
  formatted or plain text.
- Notebook edits persist after refresh.
- Save state is visible and distinguishes Saving, Saved, and Save failed;
  temporary failures retry automatically; content is not lost when a save
  fails.
- Users can view a note while retaining their notebook editing context;
  opening a note does not reload the notebook; viewing a note does not
  interrupt autosave.
- Note changes do not alter notebook content, and notebook edits do not alter
  notes; saved answers are never inserted automatically.
- Citations copied into the notebook can be opened.

From PRD §14:

- Export does not modify the notebook.
- Exports include the space name, the research objective, the notebook content
  in order, readable inline citation references, and a source list when
  citations are present; notes are excluded unless the user copied them in.
- Exported citations identify the correct sources.
- The Markdown is standard, UTF-8, and opens correctly in a plain-text editor.
- Print hides navigation and editing controls, prints only the notebook and
  its references, and avoids separating a heading from its following paragraph
  where practical.

From §16 – §19:

- "Notebook save failure" and "Export failure" states exist, explain the
  problem plainly, preserve content, and offer Retry.
- Editor controls are semantic buttons; every flow works from the keyboard;
  save-state changes are announced; the page works at 320px.
- Autosave completes within two seconds under normal conditions.

From §21: a user can draft freely, leave and return without losing notebook
content, open notes while editing, export the notebook as Markdown, and print
or save it as PDF.

## Cross-references

- [[design]] · [[tasks]]
- [[../phase-1-spaces/design]] — the lazy-create decision this phase executes.
- [[../phase-5-notes/proposal]] · [[../../specs/notes/spec]] — the notes the
  panel shows and the citation records a notebook citation is copied from.
- [[../../specs/library-reader/spec]] — REQ-139's `?cite=` / `?from=` deep link
  the citation node targets.
- [[../../specs/spaces/spec]] — REQ-100, the frozen-space rule.
- [[../space-sidebar/proposal]] — the rail, and the Cmd+B collision.
- [[../../wireframe/index]] — `research_notebook`, the layout reference.
- `../frontend/DESIGN.md` § Layout — 60–75 character reading column.
