---
title: Phase 3 — Design
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-12
tags: [phase-3, design, search, reader, fts, citations]
---

# Design: Phase 3 — Source library and reader

Phase 2 added no columns. Phase 3 adds one table and two columns, and the
reason is the whole shape of this phase: a citation must resolve to a
*place in a document*, and right now the document is a single
`Source.content` string with page numbers living only inside `Passage`
rows that overlap each other. Everything else here — search, filters,
metadata editing — is ordinary work on top of routes that already exist.

## API surface

All routes sit behind `requireUser`. Space-scoped routes register
`assertOwnership('space', 'id')`; source-scoped routes register
`assertOwnership('source', 'id')`
(`backend/src/middleware/assert-ownership.ts:26`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/spaces/:id/sources?q=&type=&archived=` | List **and** search (extended, not replaced) |
| `PATCH` | `/sources/:id` | Edit `title` and `author` — nothing else |
| `POST` | `/sources/:id/archive` | Idempotent archive |
| `POST` | `/sources/:id/restore` | Idempotent restore |
| `GET` | `/sources/:id/blocks?page=&from=&limit=` | The reader's text, in located blocks |
| `GET` | `/sources/:id/outline` | Page count and headings, for the reader's navigation |
| `GET` | `/passages/:id` | A passage's locator and block range, for a `?passage=` link — no passage text |
| `GET` | `/citations/:id/target` | Resolve a citation to a reader location (inert until Phase 4) |

Unchanged and reused: `GET /sources/:id` (gains `archivedAt`,
`blockCount`, `pageCount`), `GET /sources/:id/file`,
`POST /sources/:id/retry`, `DELETE /sources/:id`.

`serializeSource` grows `archivedAt` (`backend/src/routes/sources.ts:15`
currently omits it, so the client cannot tell an archived source from a
live one). It still carries no content, no `fileKey`, and no passage
data — REQ-107's rule is unchanged.

## Decisions

### Search extends the list route (decided 2026-08-12)

`GET /spaces/:id/sources` gains `q`, `type`, and `archived`; there is no
`/spaces/:id/search`.

The list *is* the search with no filters applied: same ownership check,
same serializer, same ordering rules, same 50-row ceiling. A second route
would duplicate all of that and then drift — §7 requires filters to
combine with search, and two routes make "combine" a client-side join.
The cost is one handler that branches on whether `q` is present, which is
visible in one place.

`archived` is an enum (`exclude` | `only`), defaulting to `exclude`,
copying the `filter` parameter Phase 1 put on `GET /spaces`
([[../phase-1-spaces/design]]). §7 says archived sources must be absent
"unless the user explicitly views archived sources" — a tri-state
`include` option would be exactly the ambiguity that sentence forbids, so
it is not offered.

### Ranking is tiered, not blended (decided 2026-08-12)

§7: "Title matches should rank above content-only matches." That is
implemented as an ordering tier, not as a weight:

```
ORDER BY  metadata_match DESC,        -- 1 when the title or author matches
          content_rank   DESC,        -- max ts_rank over the source's passages
          created_at     DESC         -- the list's existing order, as the tiebreak
```

Rejected: the idiomatic pgvector/FTS answer of one `tsvector` per source
with `setweight('A')` on the title and `'D'` on the content, ranked by
`ts_rank`. It is more elegant and it cannot make the guarantee: a source
whose body repeats the query fifty times can outrank a source with the
query in its title, and then §7's line becomes "usually". A tier is a
promise; a weight is a tendency.

**Metadata matching is `ILIKE '%q%'` over `title` and `author`; content
matching is `websearch_to_tsquery` over the existing `Passage.tsv`.**

- No new FTS column on `Source`. §5 caps a space at 50 sources, so the
  metadata half of the query is a sequential scan over at most 50 short
  strings inside a `spaceId` index lookup — far inside §19's 500 ms.
- Substring matching is what a user typing into a title filter expects:
  `consent` finds *Informed Consent Practices*, and so does `onsen`.
  FTS would not match the second at all.
- The cost, stated plainly: **no stemming on titles.** A search for
  `studies` does not match the title *Study Design*, though it will match
  the body of any source that discusses studies. Accepted because the
  content half covers the stemmed case and the metadata half covers the
  substring case; revisit if the 50-source ceiling rises, at which point
  the answer is a generated `tsvector` column plus a trigram index, not a
  bigger `ILIKE`.
- `websearch_to_tsquery` rather than `to_tsquery` or `plainto_tsquery`:
  it never throws on user input (a stray `&` or an unbalanced quote is
  the first thing anyone types), and it still supports quoted phrases,
  `or`, and `-exclusion`.

Content matching reads `Passage.tsv`, which is GIN-indexed and written in
the same statement as the passage text so the two cannot drift
([[../phase-2-ingestion/design]] "Passages are written with raw SQL"). It
does **not** read `Source.content`: the passage index is the only copy of
the text that is guaranteed to be searchable.

> Search is a read, and its results are the user's private evidence. The
> query string is not logged alongside its result set (§17), and the
> route returns source rows only — never a passage, never a snippet.

A matched-snippet ("…the word appeared **here**…") is deliberately not
returned. §7 fixes what a list row shows and REQ-107 restates it;
`ts_headline` would put extracted content into a list payload that
nothing requires it in.

### Only title and author are editable (decided 2026-08-12)

`PATCH /sources/:id` accepts `title` (required, non-empty, ≤200) and
`author` (optional, empty string → `null`), and rejects any other field
by schema. `type`, `url`, `content`, `state`, and `fileKey` are not
editable.

§7 and §8 both say "title and author or publisher" and "basic source
metadata" — the extracted content is not metadata. If a user could edit
the text, the passages, embeddings, and `tsv` built from it would still
describe the old text, and every citation into it would point at
something that no longer says what was quoted. The only honest way to
change extracted text is to re-run the pipeline, and §6's retry is
already that path.

`Source.author` is the single column behind the label "Author or
publisher". Web extraction finds a publisher (site name) but drops it —
there is no column (`backend/src/ingest/extracted.ts:16`) — so a web
source with no byline arrives with an empty field that the user can now
fill in. Phase 3 adds no column for it: one nullable string serving both
matches §7's own wording, and a `publisher` column would need its own
search tier, its own display rule, and its own migration for a field the
PRD never separates.

### Archive/restore mirrors a space, and is refused in an archived space (decided 2026-08-12)

`POST /sources/:id/archive` sets `archivedAt`; `POST .../restore` clears
it. Both are idempotent (archiving an archived source answers 200 with
the unchanged row), non-destructive (no passage, file, or citation is
touched), and both are `409` inside an archived space with Phase 1's
message — the frozen-space rule from
[[../phase-1-spaces/design]], which REQ-100 records.

`DELETE` stays allowed in an archived space, unchanged: deleting is how a
user cleans up, and refusing it would make archiving a trap. Archiving a
source is not clean-up in that sense — it is a change to what the space's
evidence *is*, which is precisely what freezing an archived space means
to prevent. Restoring the space first is one click.

An archived source stays readable: the reader opens, the content renders,
and a banner says it is archived and excluded from assistant answers.
§7's exclusion is about retrieval and default listings, not about hiding
the document from its owner.

### The reader renders extracted text, not the PDF (decided 2026-08-12)

The reader is a text view. Fidelity to the original page is served by
**Open the original** (`GET /sources/:id/file`, already proxied with
`Range` support — [[../phase-2-ingestion/design]] "Original files are
proxied").

Rejected: embedding a `pdf.js` viewer and drawing the highlight onto the
rendered page's text layer. It is what a user might expect, and it is the
wrong bet for this phase — the highlight would have to be located by
matching the passage text against a *separately re-extracted* text layer,
so the exact locators Phase 2 made structural would be re-derived by
string matching in the browser, which is the one thing this phase exists
to avoid. It also puts a second PDF extraction path in the product, in a
different language runtime, that can disagree with the first. Web and
manual sources have no page image at all, so the text reader is required
regardless; making PDFs the exception would mean two readers and two
highlight mechanisms.

What this costs: figures, tables, and layout are not visible in the
reader. §8 requires "extracted or entered content" to be displayed and
the original to be openable, which this satisfies, but a user reading a
table-heavy paper will need the original. Written down rather than
discovered.

### Reader blocks are persisted, and passages point at them (decided 2026-08-12)

**The change:** a `SourceBlock` table, and two integer columns on
`Passage`.

```prisma
/// One located unit of a source's extracted text — the reader's unit and the
/// unit a citation highlight covers. Written in the same transaction as the
/// source's passages, so the two can never describe different text.
model SourceBlock {
  id             String  @id @default(cuid())
  sourceId       String
  ord            Int     // 1-based, sequential across the source
  text           String
  page           Int?    // PDFs only; structural, from getPage(n)
  paragraphIndex Int?    // web and manual
  heading        String? // nearest preceding heading

  source Source @relation(fields: [sourceId], references: [id], onDelete: Cascade)

  @@unique([sourceId, ord])
  @@index([sourceId, page])
}

model Passage {
  // …existing columns…
  startBlockOrd Int?   // the block range this passage was built from
  endBlockOrd   Int?
}
```

The pipeline already produces exactly these blocks —
`LocatedBlock { text, page?, paragraphIndex?, heading? }`
(`backend/src/ingest/chunk.ts:1`) — and then throws them away, keeping
only their concatenation in `Source.content` and the overlapping chunks
in `Passage`. Persisting them is what makes a reader possible at all.

Why not the alternatives:

- **Split `Source.content` in the reader.** It nearly works: `content` is
  the blocks joined by `\n` with no blank lines
  (`backend/src/ingest/extract-manual.ts:17`,
  `extract-web.ts:66`), so splitting on `\n` reproduces the block list
  and its 1-based `paragraphIndex` exactly. It fails for PDFs, where
  **page number is not recoverable from `content`** — and §8 makes "PDF
  citations open the correct page" an acceptance criterion. A reader that
  re-derives locators from a concatenation is one whitespace change in an
  extractor away from silently pointing at the wrong paragraph.
- **Render the passages themselves.** The units would match the citation
  perfectly, and the text would be visibly duplicated: the chunker
  carries ~15% overlap between the pieces of an over-long paragraph
  (`CHUNK_OVERLAP_CHARS`, `backend/src/ingest/chunk.ts:28`), so a long
  paragraph would appear to repeat itself mid-sentence. Trimming the
  overlap back out in the reader is guesswork about where a split landed.
- **A JSON blob of blocks on `Source`.** No migration for a table, but
  the reader could then only page by loading every block of a 200-page
  PDF and slicing in memory — which is the §19 problem the reader has.
  Rows let the reader ask for one page.

`startBlockOrd`/`endBlockOrd` are nullable so the migration is additive,
and they are what removes string matching from the highlight: a citation
resolves to a passage, a passage names a block range, and the reader
highlights those blocks. No substring search, no "the highlight drifted
by a sentence".

**No backfill.** Sources ingested before this migration have no blocks
and no block range, and the reader falls back (below). The project has no
deployment, so the practical instruction is to reset the dev volume or
re-add the handful of local sources; a backfill script would have to
re-run extraction — which is `retry`, which only accepts a `failed`
source. Recorded in [[tasks]] as a step, not left as a surprise.

### The reader's URL is the citation contract (decided 2026-08-12)

```
/spaces/:spaceId/sources/:sourceId
    ?page=7                 PDF page to open
    &para=p12               paragraph reference (web / manual), as stored
    &passage=<passageId>    the exact target — wins over page/para
    &from=<returnPath>      where the "back" control returns to
```

The reader resolves a target through a **fallback chain**, most exact
first:

1. `passage` → its `startBlockOrd`..`endBlockOrd` → highlight those
   blocks. This is the only branch that cannot be wrong.
2. `passage` present but the row is gone, or has no block range
   (pre-migration source) → fall back to its recorded `page` / `paragraphRef`.
3. `page` / `para` only → navigate there and display the reference, and
   highlight **nothing**. Amended during implementation: this step first
   said "highlight the whole page or paragraph rather than a sentence",
   and what shipped does not, because a page-wide highlight is
   indistinguishable on screen from a resolved passage and REQ-134's own
   rule is that an unresolved location must not be highlighted. The
   reader says "Showing page 7" for this case and reserves "Showing the
   cited passage" for step 1 — see REQ-134 in
   [[../../specs/library-reader/spec]], which records the shipped
   behavior.
4. Nothing resolves → open at the top with a plain notice that the cited
   location is no longer available. Not an error page: the source is
   fine, the pointer is stale.

Step 4 is the case §6/§10's `Citation.stale` flag exists for
(`backend/prisma/schema.prisma:199`, REQ-091), and it is reachable today
by reprocessing a source after seeding a citation — which is how it gets
tested before Phase 4 exists.

`from` carries an in-app path and is validated as one — a same-origin,
absolute-path string — before it is rendered as a link. It is
user-controllable text in the URL bar; treating it as a href without
checking is an open-redirect in a phase that has no reason to have one.

Phase 4 adds `?cite=<citationId>`: the client asks
`GET /citations/:id/target`, which checks ownership and answers the
locator, and then navigates to the URL above. That route is specified and
built here — it is four lines over data that already exists — but it has
no producer until Phase 4, and [[tasks]] marks it as inert. The
alternative, letting the client construct reader URLs from a citation
payload, would put locator interpretation in two places.

### The reader pages the way the source is shaped (decided 2026-08-12)

`GET /sources/:id/blocks` answers in one of two modes:

- `?page=n` — every block with `page = n`, for a PDF. The reader's
  navigation is page-based because §8 asks for exactly that ("navigate by
  PDF page when page data exists"), and `pageCount` comes from
  `GET /sources/:id/outline`.
- `?from=ord&limit=` — a window of consecutive blocks, for web and manual
  sources, which have no pages. `limit` is capped server-side.

Deep-linking to a block that is not in the first window is the reason the
window is a parameter rather than a scroll position: the reader loads
*the window containing the target*, not the first window followed by a
scroll. §19's 2.5 s applies to a 200-page PDF opened at page 137.

`outline` returns `{ pageCount, blockCount, headings: [{ ord, page?, heading }] }`.
Headings are already stored per block, and §6 required them to stay
associated with their passages; surfacing them is what makes a web
article navigable without pages.

### No new activity types, and no new `AppConfig` key (decided 2026-08-12)

§15's activity list is `space created`, `source added`, `source
processing completed or failed`, `answer saved as a note`, `note created,
edited, or converted`, `notebook exported`. Archiving a source and
editing its title are not on it, so Phase 3 writes no `Activity` rows —
deliberately, because the temptation with an existing table is to add
`source.archived` and quietly widen §15.

Likewise no configurable limit: the reader's block-window cap is a safety
valve on a query, not an operator-tunable product limit, so it is a
constant in code next to the handler — the same distinction
[[../phase-2-ingestion/design]] drew for the web fetch's byte cap.

## Frontend

### Structure

```
src/features/sources/
  use-sources.ts          + search params, patch/archive/restore mutations
  use-source-search.ts    debounced query + filter state, synced to the URL
  source-filters.tsx      search input, type tablist, "show archived" toggle
  source-list.tsx         (existing) + archived styling, link to the reader
  edit-source-dialog.tsx  title + author or publisher
  archive-source-dialog.tsx
src/features/reader/
  use-source-content.ts   blocks by page or window, outline, target resolution
  source-reader.tsx       the reader body — a component, not only a route
  reader-header.tsx       metadata, original link, edit / archive / delete
  page-navigator.tsx      page N of M, prev/next, jump-to-page
  block.tsx               one block, highlightable
src/routes/
  source-page.tsx         /spaces/:spaceId/sources/:sourceId
```

`source-reader.tsx` takes its ids and target as props and is rendered by
`source-page.tsx`. Phase 4's three-pane layout
([[../../wireframe/index]] `knowledge_assistant`) mounts the same
component in a pane; a reader that only exists as a route would be
rewritten there.

### Search state lives in the URL

`?q=`, `?type=`, `?archived=` on the library view, so a filtered library
survives a reload and the back button steps through it. The input is
debounced (~250 ms) and each distinct query is its own TanStack Query
key, so results are cached per query and the 500 ms §19 target is
measured against a cold query, not a cached one.

The empty-results state is not the empty-library state: it names the
query, and offers **Clear search** when only `q` is set and **Clear
filters** when a type or archived filter is also active (§7 asks for
either, §16 lists "no source search results" as its own state). The
result count is rendered in an `aria-live="polite"` region — a search
that silently rewrites a list is invisible to a screen reader (§18).

### The highlight

The cited blocks get a background token, a left border, and an
`aria-current` marker plus visually-hidden "cited passage" text — §18
forbids color as the only channel. The reader scrolls the target into
view once, on resolution, and never again; a highlight that re-scrolls on
every render fights the user who is reading around it.

The reference (`Page 7`, `Paragraph 12`, or the section heading) is
displayed beside the highlight, because §8 requires the reference to be
shown and not merely honored. The **back** control renders only when
`from` is present and valid, labelled with where it goes ("Back to the
answer") rather than "Back".

Nothing in the reader mutates the source except the explicit metadata,
archive, and delete controls — §8's "citation navigation does not alter
the source" is a property of the whole screen, and the reader issues no
`POST /spaces/:id/open`-style side effect of its own.

## Migration and dependencies

**Migration:** one — create `SourceBlock` with its unique and index, add
`Passage.startBlockOrd` / `endBlockOrd` (nullable). No backfill; see the
blocks decision.

**Pipeline change:** `persist.ts` writes blocks in the same transaction
that replaces passages, and records each passage's block range. Because
reprocessing already deletes and rewrites passages atomically (REQ-090),
blocks join that same delete-and-rewrite — a source can never be `ready`
with last week's blocks.

**Dependencies:** none, backend or frontend. No PDF renderer (see the
reader decision), no search library — Postgres does both halves of the
query.

## Testing

- **Search** (`backend/test/sources-search.test.ts`): a title-only match,
  a content-only match, both present with the title-match ranked first,
  a query matching a source in a *different* space of the same user
  (absent), `q` combined with `type`, archived excluded by default and
  present under `archived=only`, and a query full of FTS punctuation
  (`"quoted phrase" & -not |`) answering 200 rather than 500.
- **Metadata** (`sources.test.ts` additions): `PATCH` persists and
  round-trips through `GET`; a rejected field (`content`, `type`, `state`)
  answers 400; `PATCH` in an archived space answers 409 (REQ-100); a
  foreign source answers 404.
- **Archive/restore**: idempotent both ways, `archivedAt` surfaced,
  archived source absent from `retrievableSources()` — asserted through
  the exported filter, not by re-deriving it — passages and file
  untouched, and 409 inside an archived space.
- **Blocks and outline** (`backend/test/reader.test.ts`): a PDF fixture's
  `?page=n` returns exactly that page's blocks with the page numbers the
  extraction recorded; a web fixture's window respects `from`/`limit` and
  the server cap; `outline` reports the right `pageCount` and headings;
  ownership 404; a pre-migration source (blocks deleted by hand) degrades
  instead of erroring.
- **Locator round-trip** — the test this phase is really for: ingest each
  of the three fixtures, take a passage from the middle of each, and
  assert that resolving its id yields the block range whose text
  *contains the passage's own text*. That is the end-to-end check that
  Phase 2's locators and Phase 3's blocks describe the same document.
- **Citation targets**: hand-seeded `Citation` rows (Phase 4 owns the
  only real producer) resolved through `GET /citations/:id/target`;
  then reprocess the source and assert the stale path answers the
  fallback rather than a wrong location.
- **Mutation checks**, each must fail exactly one named test: drop the
  `metadata_match` tier from the `ORDER BY`; let `PATCH` accept
  `content`; drop `archived=exclude` from the default list; return
  `endBlockOrd` off by one from the persisted range.
- **Frontend** (Vitest + Testing Library): debounced search hitting the
  API once per settled query, filters combining, the two distinct empty
  states with the right Clear action, a stubbed reader resolving
  `?passage=` and marking the right block, the fallback notice when
  nothing resolves, the back control appearing only for a valid `from`
  and being absent for `https://evil.example`, page navigation moving
  between pages, and the archived banner in the reader.
- **Performance**: 50 sources seeded with real extracted text, the search
  route timed against §19's 500 ms, and a 200-page PDF's reader opened at
  a late page and timed against §19's 2.5 s. Both recorded as numbers in
  the implementation notes, not as "felt fast".

## Cross-references

- [[proposal]] — scope and acceptance criteria.
- [[tasks]] — work breakdown.
- [[../phase-2-ingestion/design]] — the pipeline, locators, chunk
  overlap, the proxied original, and the SSE stream this reuses.
- [[../phase-1-spaces/design]] — the frozen-archived-space rule and the
  `filter` parameter this copies.
- [[../../specs/ingestion/spec]] — REQ-088/089/090/091, REQ-100,
  REQ-101, REQ-107.
- [[../../wireframe/index]] — `source_library` and `knowledge_assistant`,
  layout only.
