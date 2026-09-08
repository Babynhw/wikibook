---
title: Library and reader — spec
kind: spec
status: current
sources:
  - PRD §7 (source library), §8 (source reader), §16 (states), §17 (security), §18 (a11y), §19 (performance), §20 (exclusions)
  - backend/src/routes/sources.ts
  - backend/src/routes/citations.ts
  - backend/src/ingest/chunk.ts · backend/src/ingest/persist.ts · backend/src/ingest/extract-pdf.ts
  - backend/scripts/reprocess-sources.ts
  - backend/prisma/schema.prisma (SourceBlock, Passage.startBlockOrd/endBlockOrd)
  - frontend/src/features/sources/ · frontend/src/features/reader/
created: 2026-08-12
updated: 2026-08-27
tags: [library-reader, spec]
---

Search and filtering inside a research space, the metadata a user can correct,
archive and restore for a single source, and the reader a citation deep-links
into. Written from the Phase 3 implementation
([[../../plan/phase-3-library-reader/proposal|the plan]]) as it was verified on
2026-08-12. MUST / MUST NOT / SHOULD / MAY are RFC 2119.

## Scope

Covers PRD §7 and §8. It does **not** cover how sources are created, processed,
retried, or deleted, or the per-space event stream — that is
[[../ingestion/spec]], whose REQ-088/089 (exact locators), REQ-090 (atomic
reprocess), REQ-100 (archived-space writes), REQ-101 (retrieval eligibility) and
REQ-107 (what a list row may show) this spec builds on. The assistant that will
produce real citations is Phase 4 and unspecified here; `GET /citations/:id/target`
exists and is exercised only against seeded rows (REQ-135). Space-level
archive/restore is [[../spaces/spec]].

## Search and filtering

### REQ-110 — One route lists and searches, always space-scoped

`GET /spaces/:id/sources` MUST accept `q`, `type`, and `archived` and MUST confine
every result to the space in the path (PRD §7). There MUST NOT be a separate
search route.

- GIVEN two spaces of the same user, each holding a source matching `consent`
- WHEN one space is searched
- THEN only that space's source is returned, and searching the other returns only
  its own

### REQ-111 — A title, an author, or the extracted text can find a source

Search MUST match against the title, the author, and the extracted content
(PRD §7). A title or author match MUST match on a substring; a content match MUST
match on a stemmed word.

- GIVEN *Informed Consent Practices* by Ochoa, and *Field Notes* whose text says
  "Consent was obtained from every participant"
- WHEN `q=consent`, `q=onsen`, `q=participants`, or `q=diekelmann` is searched
- THEN the first two return the title match, `participants` returns the
  content match for the stored word "participant", and the author query returns
  its source

Titles are matched with `ILIKE`, so they are **not** stemmed: `studies` does not
match the title *Study Design*, though it matches the body of any source that
discusses studies.

### REQ-112 — A title match ranks above a content-only match

For one query, every source matching on title or author MUST be ordered before
every source matching only on content (PRD §7). Within a tier, ordering is by
full-text rank and then newest-first.

- GIVEN a source with the query in its title and another with it only in its text
- WHEN both match the same query
- THEN the title match is returned first

The rank is a tier in the `ORDER BY`, not a blended weight: a weighted single
vector can only make this usually true.

### REQ-113 — A type filter combines with the query

`type` MUST narrow results to `pdf`, `web`, or `manual` and MUST apply together
with `q` (PRD §7). Neither clears the other.

### REQ-114 — Archived sources are absent unless asked for

The default list and every search MUST exclude archived sources, and
`archived=only` MUST return exactly the archived ones (PRD §7). `archived` MUST
NOT offer a third "include both" value.

### REQ-115 — A malformed or operator-laden query answers 200

A query containing search punctuation MUST NOT fail. `%` and `_` MUST be treated
as literals rather than as wildcards.

- GIVEN the query `&& | - "unclosed`, or `%`
- WHEN it is searched
- THEN the response is 200

Queries are parsed with `websearch_to_tsquery`, so its operators are honored:
`"declarative memory"` matches only where the words are adjacent, and a leading
`-` excludes. A query that is *only* a negation therefore matches nearly
everything — that is the operator working, not a failure.

### REQ-116 — A result row shows what §7 lists, and no snippet

A row MUST carry title, type, author or publisher, processing state, whether it is
archived, and the date added, and MUST NOT carry extracted text, a matched
snippet, passage data, or a storage key (PRD §7, §17, REQ-107).

### REQ-117 — Searching is not throttled at the write limit

Reads of the library MUST NOT share a rate-limit budget with writes to the same
path (PRD §7 makes search a normal interaction; §16 forbids a failure the user
cannot act on).

- GIVEN a signed-in user
- WHEN 70 searches are issued in one minute
- THEN every one answers 200

`@fastify/rate-limit` pushes its hook into `routeOptions.onRequest`, so route
option objects MUST be built per route; sharing one array made every route run
every other route's limiter.

### REQ-118 — The client asks once per settled query, and the query lives in the URL

The client MUST debounce the search input so one settled query is one request, and
MUST reflect `q`, `type`, and `archived` in the URL so a filtered library survives
a reload and the back button.

The URL is written from the settled query and therefore echoes back a render later.
The input MUST adopt a query that arrives from *outside* (a deep link, the back
button) and MUST ignore its own echo: adopting it unconditionally resets the input
and discards any keystroke typed since the write.

- GIVEN a settled query that has reached the URL
- WHEN the user keeps typing
- THEN the input keeps every character and the next settled query is the full one

### REQ-119 — No results is its own state, with the apt clear action

An empty result set MUST be presented distinctly from an empty library and MUST
offer **Clear search** when only a query is applied, or **Clear filters** when a
type or archived filter is also applied (PRD §7, §16).

### REQ-120 — The result count is announced

The number of results MUST be rendered in a polite live region (PRD §18): a search
that silently rewrites a list is invisible to a screen reader.

## Source metadata

### REQ-121 — Title and author or publisher are editable, and nothing else

`PATCH /sources/:id` MUST accept `title` and `author` and MUST reject any other
field with 400 (PRD §7/§8). `type`, `url`, `content`, `state`, and `fileKey` MUST
NOT be editable.

- GIVEN a ready source
- WHEN `PATCH` is sent with `content`, `state`, `type`, or `url`
- THEN the response is 400 and the stored extracted text is unchanged

The extracted text is derived: editing it would leave every passage, embedding,
and citation describing text the source no longer contains. Reprocessing
(REQ-090) is the only path that changes it.

### REQ-122 — An edit persists, and an empty author clears the field

A title MUST be non-empty after trimming; an empty author MUST be stored as null
rather than as a blank string. The change MUST survive a refetch.

An **omitted** `author` MUST leave the stored value alone; only `null` or `''`
clears it. The two MUST stay distinguishable, so the schema keeps an absent key
`undefined` rather than mapping it to `null`.

- GIVEN a source with an author
- WHEN `PATCH` is sent with a title and no `author` key
- THEN the response is 200 and the stored author is unchanged

### REQ-123 — Archiving and restoring a source are idempotent and non-destructive

`POST /sources/:id/archive` and `.../restore` MUST answer 200 whether or not the
source is already in that state, MUST NOT re-stamp an existing `archivedAt`, and
MUST leave passages, blocks, the stored original, and citations untouched
(PRD §7).

`archivedAt` MUST be the time the archiving request ran — never a value captured
when the route was registered, which would record the server's boot time for every
archive in the process's lifetime and can precede the source's own `createdAt`.

- GIVEN a source archived at some point after the server started
- WHEN the response is read
- THEN `archivedAt` is at or after both the request time and `createdAt`

### REQ-124 — An archived source leaves retrieval and returns on restore

An archived source MUST be absent from `retrievableSources()` and MUST return to it
when restored (PRD §7/§9/§17, REQ-101). Archiving is the only way the product sets
`archivedAt` on a source.

### REQ-125 — Metadata edits and archiving are frozen in an archived space

`PATCH`, `archive`, and `restore` MUST answer 409 with the archived-space message
while the owning space is archived (REQ-100). `GET` and `DELETE` MUST stay allowed.

Deleting stays allowed because it is how a user cleans up; archiving a source is a
change to what the space's evidence *is*, which is what freezing prevents.

### REQ-126 — Ownership is a 404 on every route

Every route in this spec MUST answer 404 — never 403 — for a source, passage, or
citation belonging to another user, and 401 when unauthenticated (PRD §17).

## The reader's text

### REQ-127 — A source's text is stored as located blocks

Extraction MUST persist its located blocks as rows carrying a 1-based ordinal, the
page for a PDF, the paragraph index for a web or manual source, and the nearest
heading — written in the same transaction that writes the source's passages, so
blocks and passages can never describe different text (PRD §6/§8).

A block that *is* a heading carries its own text as its nearest heading
(`heading === text`). That is the whole convention: no block type column. Web
extraction folds headings into the blocks under them and emits no heading block,
so only PDF blocks satisfy it today
([[../../plan/source-detail-reader/design|design]] "A heading is a block whose
`heading` is its own text").

### REQ-234 — PDF blocks are paragraphs, and a larger line is a heading

PDF extraction MUST group printed lines into paragraphs by their geometry — a
line continues the paragraph when its baseline gap is at most 1.9 font heights,
its font size is within 12 %, and its left edge sits on the paragraph's column —
and MUST emit a line set at least 1.15 × the document's character-weighted median
font height, of at most two lines and 120 characters, as its own heading block.
A hyphen at a line end followed by a lowercase letter MUST be closed
(`Wurtem-` / `berg` → `Wurtemberg`). No paragraph spans a page (REQ-128).

- GIVEN a page with a 24pt title over two 12pt lines 14pt apart and a third line 36pt below
- WHEN it is extracted
- THEN there are three blocks: the title with `heading` equal to itself, the two lines joined by one space, and the third line — the latter two carrying the title as their heading

A page whose lines do not read top to bottom — rotated text, or more than a
fifth of consecutive lines moving *up* the page — MUST fall back to one block per
line with no heading. A document under three lines has no median to compare
against and MUST produce no heading.

### REQ-235 — Citation rematch ignores whitespace

`rematchCitations` MUST compare the quoted text and the passage text with runs
of whitespace collapsed to one space, so a quote that spanned a printed line
break before a reflow (REQ-234) is still matched after it.

- GIVEN a citation whose `quotedText` contains `\n` where the new passage has a space
- WHEN the source is reprocessed
- THEN the citation points at the new passage and is not `stale`

### REQ-128 — Every passage names the block range it was built from

A passage MUST record the first and last block ordinal it covers, and the
concatenated text of that range MUST contain the passage's text. A PDF passage's
range MUST lie on one page (REQ-089).

- GIVEN a ready PDF, web, and manual source
- WHEN each passage's block range is read
- THEN the range's text contains the passage's text, and a paged passage's blocks
  all carry its page

The pieces of an over-long single paragraph all carry that paragraph's block range:
the pieces overlap, so a narrower range would be a guess.

### REQ-129 — Reprocessing replaces blocks with passages, atomically

Reprocessing MUST delete and rewrite blocks in the same transaction as passages,
restarting ordinals at 1 (REQ-090). A source MUST NOT be `ready` with one run's
blocks and another's passages.

There is no route to reprocess a `ready` source (PRD §8 never asks a user to
re-extract). `backend/scripts/reprocess-sources.ts` (`pnpm reprocess:sources
<id> | --all [--type pdf] [--dry-run]`) does it as maintenance: the same atomic
`ready → processing` guard as `POST /sources/:id/retry`, the settled job
removed, and a fresh enqueue with the standard job options — the worker then
runs this REQ. It skips sources in archived spaces.

### REQ-130 — The reader reads a PDF by page and everything else by window

`GET /sources/:id/blocks` MUST answer with a page's blocks when `page` is given and
with a bounded window from `from` otherwise, and MUST cap the window server-side
(PRD §8, §19).

- GIVEN a 12-paragraph manual source
- WHEN `from=9&limit=3` is requested, or `limit=100000`
- THEN blocks 9–11 are returned, and the absurd limit is clamped rather than
  refused

Given both, the two parameters MUST narrow rather than compete: `page` selects the
page and `from` is a further lower bound on the ordinal, so `page=2&from=<last ord
on page 2>` answers exactly that block and a `from` past the page answers nothing.

### REQ-131 — The outline reports pages, headings, and size

`GET /sources/:id/outline` MUST report the block count, the highest page number
(null where there is no page data), and one entry per heading run in source order
(PRD §8, and §6's rule that headings stay associated with their text).
`GET /sources/:id` MUST carry `blockCount` and `pageCount` so the reader can
render its shell in one round trip.

### REQ-132 — A source with no blocks degrades instead of failing

A source ingested before blocks existed MUST answer an empty block list and zeroed
counts rather than an error (PRD §16).

## Citation navigation

### REQ-133 — The reader is a URL that names a location

The reader MUST be addressable as
`/spaces/:spaceId/sources/:sourceId?passage=&page=&para=&from=`, where `passage`
is the exact target and takes precedence over `page` and `para` (PRD §8).

### REQ-134 — A location resolves most-exact-first, and says so when it cannot

Resolution MUST proceed: the passage's block range; else the page or paragraph the
link carries; else a plain notice that the cited location is no longer available.
The last case MUST NOT be presented as an error, and MUST NOT highlight a guessed
location.

- GIVEN a link naming a passage that no longer exists
- WHEN the reader opens
- THEN the source renders from the top with the notice, and nothing is highlighted

Only a resolved block range is highlighted. A `page`- or `para`-only link navigates
and displays its reference, and MUST NOT be described as showing a cited passage —
the reader says "Showing page 7" there and reserves "Showing the cited passage" for
the block-range case, because a page-wide highlight is indistinguishable on screen
from an exact one.

- GIVEN a link naming only a page
- WHEN the reader opens
- THEN that page is shown with its reference, and no block is marked as cited

### REQ-135 — A citation resolves through the API, not the client

`GET /citations/:id/target` MUST answer a citation's location — passage id, block
range, page, paragraph reference, section heading, and whether it is stale — after
checking ownership, preferring the passage's current locator over the citation's
recorded copy (PRD §6/§8).

- GIVEN a citation whose passage did not survive a reprocess
- WHEN its target is resolved
- THEN `stale` is true, the block range is null, and the recorded paragraph
  reference is answered

> [!note] Inert until Phase 4
> Nothing produces citations yet, so this route and REQ-134's stale path are
> exercised against hand-seeded rows. Phase 4 adds `?cite=<citationId>`, which
> resolves here and then navigates to REQ-133's URL — locator interpretation stays
> in one place.

### REQ-136 — A passage's location is answerable without its text

`GET /passages/:id` MUST answer the ordinal, page, paragraph reference, heading,
and block range for a passage the user owns, and MUST NOT include the passage text
(PRD §17): the reader highlights a range and has no use for it.

### REQ-137 — The cited blocks are highlighted by more than colour, and the reference is shown

The cited blocks MUST be marked by background, border, and text available to
assistive technology, and the page, paragraph, or section reference MUST be
displayed (PRD §8, §18). The reader MUST scroll the target into view once and MUST
NOT re-scroll on later renders.

The reference describes the target, so it MUST be shown only while the reader is on
the page or window the target lies in: once the user navigates elsewhere it MUST
disappear rather than name a location that is no longer on screen.

- GIVEN a reader opened on a cited passage on page 2
- WHEN the user moves to page 3 and back
- THEN the reference is absent on page 3 and present again on page 2

### REQ-138 — A deep link loads the window containing its target

The reader MUST open the page or window the target lies in, not the first one
followed by a scroll (PRD §8, §19).

- GIVEN a 400-paragraph source and a link to a passage starting at block 200
- WHEN the reader opens
- THEN it requests the window containing block 200 and never the first window

### REQ-139 — A return control renders only for an in-app path

`from` MUST be rendered as a link only when it is a same-origin absolute path, and
MUST be ignored for an absolute or protocol-relative URL (PRD §8, §17). The control
MUST name where it goes.

### REQ-140 — Reading never modifies the source

Opening the reader, resolving a citation, and paging MUST issue no write: no state
change, no `lastOpenedAt`-style stamp, no passage rewritten (PRD §8).

- GIVEN a reader opened at a citation
- WHEN the page has settled
- THEN every request it made was a `GET`

## The reader's screen

### REQ-141 — The reader shows §8's metadata and offers the original

The reader MUST show title, author or publisher, type, the original URL or file,
and the date added, and MUST offer to open or download the original — proxied
through the API, never presigned (PRD §8, §17, REQ-108).

### REQ-142 — The reader offers no excluded affordance

The reader MUST NOT include reading-status controls, highlighting or annotation
tools, Save Cited Passage, a dedicated Summarize action, or source comparison
(PRD §8, §20). It MUST NOT show a placeholder for the current-source assistant
scope, which is Phase 4's.

§8's highlight is drawn by the system for a citation; that is not a user tool.

### REQ-143 — Page navigation exists only where page data does

Prev/next and a jump-to-page control MUST be offered when the source has page data
and MUST NOT be rendered otherwise (PRD §8). A page number outside the document
MUST be clamped, not rejected.

The field carries no `min`/`max` attributes: constraint validation blocks the
submit instead of clamping, which would make the promise false.

The jump field has no visible "Go": it is a form, so Enter submits it, and the
chevrons cover the pointer path (the `source_detail` wireframe's toolbar).

### REQ-236 — The reader's page follows the `source_detail` wireframe

The route MUST open with a breadcrumb `← Library / <space>` and no second link
back to the space; the `?from=` return control (REQ-139) is the only extra line.
The header MUST be ruled off from the viewer and offer, in order, **Edit
details**, **Download** (PDF) or **Open original** (web), and an overflow menu
holding **Archive** and **Delete**; `readOnly` hides Edit and Archive, an
archived source hides Archive, and `hideActions` hides Edit and the menu while
keeping the original link (REQ-141).

The assistant's reader pane MUST render the header's **compact** variant, after
the `knowledge_assistant` wireframe's pane header: one row of type icon (its
label screen-reader-only), the title in the mono label face truncated with an
ellipsis, and a single truncated line carrying every REQ-141 field
(`author · host or page count · Added <date> · Archived`), with the original
link as an icon-only control whose accessible name is the full variant's visible
text. Compact implies `hideActions`, and draws no rule of its own — the pane's
wrapper owns the one border under the header. Both truncated texts MUST be
recoverable through `title` ([[../../plan/assistant-pane-reader-header/proposal]]).

Extracted text MUST render in the reading face (`--font-serif`, Lora, 16px on a
28px line) in a centred column of `max-w-2xl`; a heading block (REQ-127's
convention) MUST render as a `text-2xl` `<h2>` in the UI face, keeping
`data-ord` and the REQ-137 cited markers.

> [!warning] Spec-vs-code
> Written as 18px on a 32px line with a `text-3xl` heading, after the
> `source_detail` wireframe's "large 18px column". The operator reduced both by
> one step (`text-base leading-7`, `text-2xl`) in commit `3fbae00` on
> 2026-08-27, outside any plan — the same `Block` renders inside the assistant's
> reader pane, where the larger size left few lines in view. The spec now
> records the shipped size; the wireframe remains the larger one.

- GIVEN blocks `{ord 1, text "Early years", heading "Early years"}` and `{ord 2, text "Born…", heading "Early years"}`
- WHEN the reader renders them
- THEN ord 1 is a level-2 heading and ord 2 is a `<p>`, both carrying their `data-ord`

### REQ-144 — A processing, failed, or archived source explains itself

The reader MUST say a source is still processing rather than showing an empty
document, MUST show a failed source's plain-language reason with **Retry** beside
it, and MUST say an archived source is excluded from the assistant's evidence while
still rendering its text (PRD §16, §7).

## Verification

Verified 2026-08-12 against the running stack: Postgres 16 + pgvector, Redis, and
MinIO from `docker compose`, the API on `:4000` with its worker as a separate
process, and real `nomic-embed-text` embeddings from a local Ollama.

Suites: backend 93 → **114** tests (18 files), frontend 82 → **100** (16 files).
Both green, `pnpm lint` clean in each package.

| REQ | Covered by |
|---|---|
| REQ-110–REQ-116 | `backend/test/sources-library.test.ts` (space scoping, both tiers, substring and stemmed matches, `q`+`type`, archived default and `archived=only`, punctuation and operator queries) |
| REQ-117 | `backend/test/sources-library.test.ts` — 70 consecutive searches |
| REQ-118–REQ-120 | `frontend/src/features/sources/source-search.test.tsx` |
| REQ-121–REQ-126 | `backend/test/sources-library.test.ts` (`PATCH` round-trip and rejections, idempotent archive/restore, `retrievableSources()` through the exported filter, 409 in an archived space, 404/401 across the routes) |
| REQ-127–REQ-129 | `backend/test/ingest/chunk.test.ts` (block ranges, over-long paragraph), `backend/test/reader.test.ts` (locator round-trip for all three source types, reprocess rewriting both) |
| REQ-130–REQ-132 | `backend/test/reader.test.ts` (page mode, window mode and clamp, outline counts and heading runs, blocks-deleted degradation) |
| REQ-133–REQ-134, REQ-137–REQ-140, REQ-143–REQ-144 | `frontend/src/features/reader/source-reader.test.tsx` |
| REQ-135–REQ-136 | `backend/test/reader.test.ts` (`/passages/:id` without text, seeded citation target, stale fallback after a reprocess) |
| REQ-141–REQ-142 | `frontend/src/features/reader/source-reader.test.tsx` (metadata line, original link) — the absence of excluded affordances is asserted only for the archive/edit pair |
| REQ-234 | `backend/test/ingest/extract-pdf.test.ts` (heading + merged paragraph + gap split, hyphen join, heading carried across pages without merging, bottom-to-top fallback, threshold edges on `groupParagraphs` / `joinLines`, a centred two-line title as one heading, an over-long large-type line kept apart from the body, same-baseline re-join, geometry from the first non-blank item, character-weighted median, two-column vs scrambled order) |
| REQ-235 | `backend/test/ingest/pipeline.test.ts` — a quote with `\n` and doubled spaces survives a reprocess |
| REQ-236 | `frontend/src/features/reader/source-reader.test.tsx` (heading block as `h2`, `Edit details · Download · ⋮`, Archive/Delete in the menu and Delete opening its dialog, Delete still offered in an archived space, `hideActions` keeping only the original link, no "Back to the space", Enter submits the page field; compact: `h1` title, one metadata line with author / page count / host / `Added` and a matching `title`, type label in the document, icon-only `Download` / `Open original` links by name and `href`, no Edit / More actions) |

Re-verified 2026-08-27 for REQ-234–REQ-236: backend 225 tests (25 files),
frontend 167 (23 files), both `pnpm lint` clean, `pnpm build` green. The one
real PDF in the dev database (a browser print-to-PDF of a Vietnamese article)
went from 49 line blocks on page 1 to 11 paragraph blocks with its title as a
heading block, and all 25 of its citations rematched with none `stale` — after
`MAX_LINE_GAP_RATIO` was raised from the designed 1.6 to 1.9, because that PDF's
leading is 1.63. Not verified: how the page *looks* in a browser — the Chrome
extension was unavailable, so REQ-236's typography and layout are asserted only
in jsdom and the compiled stylesheet.

Checked by hand against the running stack, over HTTP rather than through the test
harness: a manual source, a web source fetched from `example.com`, and an uploaded
3-page PDF all reaching `ready`; `q=consent` ranking the title match first;
`participants` finding the stemmed content; the PDF found by `naps`, a word only on
its page 3; `blocks?page=2` returning only page 2's text; the page-2 passage
resolving to block 2 with `startBlockOrd = endBlockOrd = 2`; `PATCH` persisting and
refusing `content` with 400; archive removing the source from the default list,
`archived=only` returning it, a second archive being a no-op, and restore putting
it back.

Mutation checks — each failed the named test and was reverted before the suite was
re-run green: dropping the `metadata_match` tier from the `ORDER BY` (REQ-112);
letting `PATCH` accept `content` (REQ-121); dropping the default
`archived=exclude` (REQ-114); shifting `endBlockOrd` by one in `persist.ts`
(REQ-128, which failed both the round-trip and the reprocess test); and restoring
the shared route-options object (REQ-117, plus two archived-space tests).

§19, measured on this machine with 50 sources of prose in one space: search
worst-case 24 ms (median 20 ms) against the 500 ms target; the unfiltered list
2.6 ms; and for a 200-page PDF, `blocks?page=190` 1.9 ms, `outline` 2.7 ms,
`GET /sources/:id` 3.2 ms — all far inside §19's 2.5 s, which is a client-side
budget the server no longer threatens.

> [!warning] The reader was not driven in a real browser
> `source-reader.test.tsx` exercises the reader through jsdom with a stubbed
> `fetch`; the Chrome extension was unavailable in this session, so no run loaded
> the SPA and clicked a citation link. Two things that suite cannot see: how the
> highlight looks, and whether `scrollIntoView` lands the cited block somewhere
> readable. The API side of every §8 acceptance criterion was checked by hand over
> HTTP (above).

> [!warning] REQ-142's exclusions are argued, not asserted
> No test enumerates the affordances the reader must *not* have — a test that
> asserts the absence of a control nobody wrote passes for the wrong reason. The
> guard is the §20 list in [[../../plan/phase-3-library-reader/proposal]]; if a
> later phase adds a Summarize button, this spec is what it violates.

> [!note] No backfill for pre-Phase-3 sources
> The migration adds `SourceBlock` and the two `Passage` columns without
> backfilling: rebuilding blocks means re-running extraction, which is what retry
> already is. Such sources open in the reader through REQ-132 and REQ-134's
> fallback, with no text to page through. The project is pre-release, so the
> instruction is to re-add them or reset the volume (`README.md`).

Not covered by an automated test: the `archived=only` view's own §16 empty state;
the reader's "Earlier / Later" window controls beyond the deep-link case; and the
`?para=` branch of REQ-133 (the `?page=` and `?passage=` branches are covered, and
all three share one resolver).

## Cross-references

- [[../../plan/phase-3-library-reader/proposal]] · [[../../plan/phase-3-library-reader/design]] · [[../../plan/phase-3-library-reader/tasks]]
- [[../ingestion/spec]] — the pipeline these blocks and locators come from.
- [[../spaces/spec]] — the space these routes sit inside, and its frozen-archived rule.
- [[../auth/spec]] — ownership, the error envelope, and the client session rules.
- [[../../wireframe/index]] — `source_library` for the library, `knowledge_assistant`
  for what a citation landing should feel like. Layout only.
