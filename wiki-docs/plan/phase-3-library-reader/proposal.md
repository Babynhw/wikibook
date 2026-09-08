---
title: Phase 3 — Source library and reader
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-12
tags: [phase-3, library, reader, search, citations]
---

# Proposal: Phase 3 — Source library and reader

## Problem

Phase 2 fills a space with evidence and then offers no way to look at it.
`GET /spaces/:id/sources` returns every source in one unfiltered,
newest-first list (`backend/src/routes/sources.ts:322`), the serialized
source deliberately carries only what a list row shows — no content, no
`archivedAt` (`backend/src/routes/sources.ts:15`), and the only way to
read a source is the "Open the original" link each card grew so that the
proxy route would have a caller ([[../phase-2-ingestion/tasks]]
implementation notes). A 24-page PDF is ingested, chunked, located, and
embedded, and the user can see its title.

Two invariants the earlier phases wrote down are also unreachable from
the UI. `retrievableSources()` excludes archived sources
(`backend/src/lib/retrieval-scope.ts`), but no route archives one — the
column exists and nothing can set it. And every passage carries an exact
locator that §6 made an acceptance criterion (REQ-088, REQ-089), with no
reader to resolve it: the locators are correct and unaddressable.

That second gap is the one that decides Phase 4. A citation is only
trustworthy if the user can click it and land on the sentence it came
from; if the reader arrives *after* the assistant, the citation UI is
built against a destination that does not exist yet and the
"correct page and passage" criterion in §8 becomes a Phase 4 afterthought.
Phase 3 builds the destination first.

## Goal

A user can find a source in a space by what it says, open it, read it at
the location a citation points to, and correct its metadata.

```
space → Source library   search "consent" ▸ type: PDF ▸ show archived
                         │
                         ▼
       reader  /spaces/:sid/sources/:id?page=7&passage=<id>
                         │  title · author or publisher · type · URL/file · date added
                         │  extracted content, page 7 of 24
                         │  ▓▓ the cited passage, highlighted, "page 7" shown
                         ▼
                         ← back to the answer or note it came from
                         Edit metadata · Archive · Delete · Retry
```

## Scope

1. **Search within a space** (PRD §7) — one query over source titles,
   authors, and extracted content, scoped to the current space, with
   title matches ranked above content-only matches.
2. **Filter by source type** (§7), combinable with search, plus an
   explicit "show archived" view — archived sources are excluded from
   both list and search unless asked for.
3. **Archive and restore a source** (§7) — non-destructive, idempotent,
   and the first way to reach `retrievableSources()`'s `archivedAt`
   filter through the product (REQ-101).
4. **Edit source title and author or publisher** (§7, §8), persisted
   across a refresh.
5. **The source reader** (§8) — title, author or publisher, type,
   original URL or file, date added, and the extracted content, with PDF
   page navigation where page data exists and a link that opens or
   downloads the original.
6. **An addressable location** — the reader is a URL that names a
   passage, a page, or a paragraph, navigates to it, highlights it
   visibly, displays the reference, and offers a way back to wherever the
   link came from (§8 citation navigation). Reading never modifies the
   source.
7. **The §16 states this screen owns** — empty source library (already
   present), no source search results with a **Clear search** /
   **Clear filters** action, and a reader whose source is still
   processing or has failed.
8. **The list-level actions Phase 2 already built, kept in place** —
   retry on a failed source and confirmed delete — now reachable from the
   reader as well as the card.

## Out of scope

- **The assistant, retrieval, and real citations** (PRD §9) — Phase 4.
  Phase 3 defines and verifies the reader's URL contract using
  hand-constructed links and hand-seeded `Citation` rows; Phase 4 supplies
  the producer and the `?cite=<citationId>` form that resolves into it
  ([[design]] "The reader's URL is the citation contract").
- **"Ask a question using only the current source"** (§8) — the
  current-source scope belongs to the assistant. Phase 3 ships no
  disabled button and no placeholder pane for it; Phase 4 adds the
  affordance when there is something behind it.
- **Save Cited Passage, highlighting and annotation tools, reading
  statuses, source comparison, a dedicated Summarize action** — §8's
  "must not include" list and §20 exclusions. §8's highlight is
  *system-drawn for a citation*, not a user tool, and that distinction is
  the whole difference between a requirement and an excluded feature.
- **Editing extracted content.** Title and author are metadata; the
  extracted text is derived, and letting a user edit it would silently
  desync the passages, embeddings, and citations built from it
  ([[design]] "Only title and author are editable").
- **Cross-space search.** §7 limits search to the current space, and the
  header "Search workspace…" in the mockup is global — see
  [[../../wireframe/index]].
- **Tags, folders, importance, sort controls, grid/list toggle, trash** —
  §20 exclusions or unspecified extras, several of which the
  `source_library` mockup draws.
- **Re-ranking, embeddings, or semantic search in the library.** §7 is
  keyword search over titles, authors, and content; vector search is
  Phase 4's retrieval and answers a different question.
- **Pagination of the source list.** §5 caps a space at 50 sources, so
  the list is bounded by a limit the product already enforces. The
  *reader* still pages, because one source is not bounded.

## Acceptance criteria

From PRD §7 and §8's own acceptance criteria, plus the §19 and §21 lines
this phase is measured by.

**Library (§7)**

- Every source in the space is listed with title, type, author or
  publisher, processing state when not ready, and date added — and none
  of §7's forbidden statuses.
- A user can locate a source by a word in its title and by a word that
  appears only in its extracted content.
- Title matches rank above content-only matches for the same query.
- Search is confined to the current space: a matching source in another
  space of the same user never appears.
- A type filter combines with a search query; both stay applied together.
- Archived sources are absent from results unless the archived view is
  explicitly selected.
- Empty results offer **Clear search** or **Clear filters**, and using it
  restores the full list.
- Editing a title or author persists after a refresh.
- Archiving a source removes it from the default list and from
  `retrievableSources()`; restoring puts it back. Both are idempotent.

**Reader (§8)**

- The reader shows title, author or publisher, type, original URL or
  file, date added, and the extracted content.
- A PDF with page data can be navigated by page, and the page shown
  matches the page the ingestion recorded.
- The original can be opened or downloaded from the reader.
- Metadata can be edited from the reader, with the same result as from
  the library.
- Opening a link that names a passage opens the reader, navigates to that
  passage, highlights it visibly, and displays its page, paragraph, or
  section reference.
- PDF links open the correct page and passage; web links open the correct
  extracted paragraph or section; manual-source links open the correct
  entered paragraph.
- A link carrying an origin renders a control that returns to it.
- Opening a link never alters the source: no state change, no `updatedAt`
  bump, no passage rewritten.
- A reader opened on a `processing` or `failed` source explains that
  state instead of rendering an empty document, and a failed one offers
  Retry (§16).

**Non-functional**

- Search results for a 50-source space update within 500 ms (PRD §19).
- The library and reader are interactive within 2.5 s (PRD §19); a
  200-page PDF's reader does not load the whole extracted text to show
  page 1.
- Search inputs, filters, and page navigation are keyboard reachable, the
  result count is announced, and the citation highlight is conveyed by
  more than color (PRD §18).
- Every new route enforces ownership and answers 404 — never 403 — for
  another user's source or space (PRD §17).
- No route exposes a storage key, an embedding, or a stack trace; a
  search query is not logged with its results (PRD §17).
- Writes into an archived space stay refused with Phase 1's message
  (REQ-100), and reads stay allowed.

## Cross-references

- [[design]] — decisions: how search ranks, where reader blocks come
  from, the URL contract, and the schema change this phase takes.
- [[tasks]] — work breakdown, split by codebase.
- [[../phase-2-ingestion/proposal]] — the ingestion this reads, and the
  §7/§8 work it explicitly deferred here.
- [[../../specs/ingestion/spec]] — REQ-088/089 (locators), REQ-100
  (archived-space writes), REQ-101 (retrieval eligibility), REQ-107 (what
  a list row may show).
- [[../../specs/spaces/spec]] — archive/restore semantics this phase
  copies for a source.
- [[../../wireframe/index]] — `source_library` for the library layout and
  `knowledge_assistant` for what a citation landing should feel like;
  both are layout only.
- PRD `../../../RAG Workspace - PRD.docx` §2 (Source, Passage, Citation),
  §7 (source library), §8 (source reader), §16 (states), §17 (security),
  §18 (a11y), §19 (performance), §20 (exclusions), §21 (end-to-end
  scenario).
