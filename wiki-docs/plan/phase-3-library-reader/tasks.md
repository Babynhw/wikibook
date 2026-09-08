---
title: Phase 3 — Tasks
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-12
tags: [phase-3, tasks]
---

# Tasks: Phase 3 — Source library and reader

Backend first again, and inside the backend the **schema and the
pipeline change come before anything else** (T1–T2): the reader is a
consumer of blocks, so building the reader first would mean building it
against a fallback path and then never exercising the real one. Estimated
1.5 weeks ([[../../README]] §6).

## Backend (`backend/`)

### T1 — Blocks in the schema

- [x] `SourceBlock` model per [[design]] ("Reader blocks are persisted"),
      with `@@unique([sourceId, ord])` and `@@index([sourceId, page])`
- [x] `Passage.startBlockOrd` / `endBlockOrd`, both nullable so the
      migration is additive
- [x] One `prisma migrate dev` migration; `pnpm prisma:generate` after it
      (`migrate dev` no longer does — `backend/CLAUDE.md`)
- [x] Dev-data step in `backend/README.md`: there is **no backfill**, so
      sources ingested before this migration have no blocks — reset the
      volume or re-add them

### T2 — The pipeline writes blocks

- [x] `ingest/persist.ts` writes the extraction's `LocatedBlock[]` as
      `SourceBlock` rows **inside the existing transaction** that replaces
      passages, so reprocessing (REQ-090) rewrites both or neither
- [x] `chunkBlocks` returns each passage's source block range; `persist`
      records it as `startBlockOrd` / `endBlockOrd`
- [x] Verify the invariant that makes the reader trustworthy: every
      passage's text is contained in the concatenation of its block range
- [x] `Source.content` keeps its current meaning (the whole extracted
      text); nothing else reads blocks yet

### T3 — Search and filters

- [x] `GET /spaces/:id/sources` accepts `q`, `type`, `archived`
      (`exclude` | `only`, default `exclude`) — the same route, not a new
      one ([[design]] "Search extends the list route")
- [x] One SQL query: `ILIKE` over `title`/`author` for the metadata tier,
      `websearch_to_tsquery` over `Passage.tsv` for the content tier,
      ordered `metadata_match DESC, content_rank DESC, createdAt DESC`
- [x] Space-scoped by construction (§7): the `spaceId` predicate is in the
      query, not applied afterwards
- [x] A query of pure punctuation or unbalanced quotes answers 200
- [x] The response carries source rows only — no snippet, no passage text
      (REQ-107); the query string is not logged with its results (§17)

### T4 — Metadata, archive, restore

- [x] `PATCH /sources/:id` — `title` (required, ≤200) and `author`
      (optional, `''` → `null`) only; any other field is a 400
- [x] `POST /sources/:id/archive` and `.../restore`, both idempotent and
      non-destructive
- [x] All three answer `409` with `ARCHIVED_MESSAGE` inside an archived
      space (REQ-100); `DELETE` stays allowed, unchanged
- [x] `serializeSource` gains `archivedAt` (and `sourceSchema` with it);
      still no `fileKey`, no content
- [x] No `Activity` row for either action — §15's list does not include
      them ([[design]] "No new activity types")

### T5 — The reader's routes

- [x] `GET /sources/:id/blocks` — `?page=n` for PDFs, `?from=&limit=` for
      web and manual, `limit` capped server-side
- [x] `GET /sources/:id/outline` — `{ pageCount, blockCount, headings }`
- [x] `GET /sources/:id` gains `pageCount` and `blockCount` so the reader
      needs one round trip to render its shell
- [x] A source with no blocks (pre-migration) answers an empty block list
      with its counts at zero — the client's fallback, not a 500

### T6 — Citation targets (specified now, inert until Phase 4)

- [x] `GET /citations/:id/target` — ownership-checked, answers
      `{ sourceId, spaceId, passageId?, page?, paragraphRef?, stale }`
- [x] Resolution order is the one in [[design]] ("The reader's URL is the
      citation contract"): passage block range → recorded locator →
      nothing, and `stale` is reported rather than hidden
- [x] Marked inert in the spec: no producer exists until Phase 4 (REQ-091
      is the same situation Phase 2 tested against seeded rows)

### T7 — Backend tests

- [x] `test/sources-search.test.ts` — title-only, content-only, both with
      the title match first, a match in another space of the same user
      absent, `q` + `type` combined, archived excluded by default and
      returned under `archived=only`, punctuation-only query
- [x] `test/sources.test.ts` additions — `PATCH` round-trip, rejected
      fields, 409 in an archived space, 404 for a foreign source,
      archive/restore idempotency, `archivedAt` surfaced
- [x] Archived source is absent from `retrievableSources()` **through the
      exported filter**, and its passages and stored file survive
- [x] `test/reader.test.ts` — page mode against a PDF fixture with known
      page content, window mode with the server cap, `outline` counts and
      headings, ownership 404, and a blocks-deleted source degrading
- [x] The locator round-trip test for all three source types: a passage's
      text is contained in its block range's text
- [x] `test/citations-target.test.ts` — hand-seeded rows, then a
      reprocess, asserting the stale fallback rather than a wrong location
- [x] Mutation checks, each failing exactly one named test: drop the
      metadata tier from `ORDER BY`; let `PATCH` accept `content`; drop
      the default `archived=exclude`; shift `endBlockOrd` by one.
      **A mutation check is not done until the mutation is reverted and
      the suite is green** ([[../phase-2-ingestion/tasks]])

## Frontend (`frontend/`)

### T8 — Data layer

- [x] `use-sources.ts` — search params in the query key, plus `patch`,
      `archive`, `restore` mutations patching the cached row
- [x] `use-source-search.ts` — debounced `q` (~250 ms) and filter state
      synced to `?q=&type=&archived=`, so a filtered library survives a
      reload and the back button
- [x] `features/reader/use-source-content.ts` — outline, blocks by page or
      window, and target resolution through the fallback chain
- [x] `lib/api.ts` — the new endpoints, `archivedAt` / `pageCount` /
      `blockCount` on `Source`, and the block and outline types

### T9 — Library UI

- [x] `source-filters.tsx` — search input, type tablist, "show archived"
      toggle; filters and query stay applied together (§7)
- [x] Result count in an `aria-live="polite"` region (§18)
- [x] The **no-results** state, distinct from the empty-library state:
      names the query, **Clear search** when only `q` is set,
      **Clear filters** when a filter is also active (§7, §16)
- [x] `source-list.tsx` — rows link to the reader; archived rows are
      visibly archived (icon + text, never color alone) and keep the §7
      list fields with nothing added
- [x] `edit-source-dialog.tsx` (title + "Author or publisher") and
      `archive-source-dialog.tsx`; the existing delete and retry
      affordances stay where they are

### T10 — Reader UI

- [x] Route `/spaces/:spaceId/sources/:sourceId` → `source-page.tsx`
      rendering `source-reader.tsx`, which takes props so Phase 4 can
      mount it in a pane
- [x] `reader-header.tsx` — title, author or publisher, type, original URL
      or **Open the original**, date added, and the edit / archive /
      delete controls
- [x] `page-navigator.tsx` — page N of M, prev/next, jump-to-page, fully
      keyboard reachable; rendered only when page data exists (§8)
- [x] Target resolution: `?passage=` → block range, else `?page=`/`?para=`,
      else a plain "this location is no longer available" notice
- [x] The highlight — background token **plus** border **plus** visually
      hidden "cited passage" text, the reference displayed beside it,
      scrolled into view exactly once
- [x] The **back** control renders only for a valid same-origin
      `?from=` path, labelled with its destination; an absolute URL is
      ignored
- [x] A `processing` or `failed` source opens a state, not an empty
      document; failed offers Retry (§16). An archived source opens with a
      banner saying it is excluded from assistant answers
- [x] Deep-linking loads **the window containing the target**, not the
      first window followed by a scroll
- [x] Nothing on this screen mutates the source except the explicit
      controls (§8)

### T11 — Frontend tests

- [x] Debounce issues one request per settled query; filters combine; the
      two empty states render the right Clear action
- [x] A stubbed reader resolves `?passage=` and marks the right block;
      the unresolvable case shows the notice
- [x] The back control is absent for `?from=https://evil.example` and
      present for `/spaces/x/…`
- [x] Page navigation moves pages and requests the right page; the
      archived banner renders; a failed source shows message + Retry
- [x] Tests cite REQ ids once the spec is written
      ([[../../specs/AGENTS]])

## Exit criteria

- [x] Every acceptance criterion in [[proposal]] is exercised — by test
      where possible, by hand otherwise, and anything unverified is
      written down rather than dropped
- [x] A word that appears only in a PDF's body finds that PDF; a word in a
      title outranks it; both are confined to the space
- [x] A hand-written reader URL naming a passage from each of the three
      source types opens the right location with the right reference
      shown — the §8 acceptance criteria, checked by hand as well as by
      test
- [x] Search over a 50-source space measured under 500 ms and a 200-page
      PDF's reader opened at a late page measured under 2.5 s (PRD §19),
      both recorded as numbers
- [x] An archived source is absent from the default list, absent from
      `retrievableSources()`, still readable, and restorable
- [x] Metadata edits survive a refresh; extracted content is not editable
      through any route
- [x] Reprocessing a source rewrites its blocks and passages together,
      and a citation into it either re-matches or reports itself stale
- [x] `specs/library-reader/spec.md` written from the verified behavior,
      numbering from **REQ-110** (REQ-109 is the highest id in use), with
      `index.md` updated, `log.md` appended, `tasks.md` ticked and
      `status: done`
- [x] The unexecuted Phase 2 integration tests are run against the
      compose stack in this phase's session and the caveat in
      [[../../specs/ingestion/spec]] is resolved or restated

## Implementation notes (2026-08-12)

Every task above is implemented; the verified behavior is written up in
[[../../specs/library-reader/spec]]. Backend 93 → 114 tests, frontend 82 → 100.
The deviations from [[design]] and the things a later phase needs to know:

- **`GET /passages/:id` was added; the design forgot it.** The design said the
  reader resolves `?passage=<id>` to a block range and then listed only
  `/citations/:id/target` under the API surface — but a Phase 3 reader has no
  citations to resolve, so there was no route behind the URL contract this phase
  exists to establish. The passage route answers the same locator shape as the
  citation route and deliberately omits the passage *text*: the reader highlights
  a range, and §17's habit is to keep content out of payloads that do not need it.
  `assertOwnership` gained `passage` and `citation` resolvers, both through
  `source.space.ownerId` (a citation's `messageId`/`noteId` are nullable, so
  neither can carry the check).
- **Reads were being rate-limited at the write routes' 60/minute, and this phase
  is what made it matter.** `@fastify/rate-limit` *pushes* its hook into
  `routeOptions.onRequest`; Phase 2 shared one `ownedSpace`/`ownedSource` object
  across every route in the file, so all of them shared one array and each route
  ran every other route's limiter. Searching is one request per settled query, so
  a user typing for two minutes hit 429 — with a `bad_request` envelope. The
  options are now factories returning fresh arrays, reads have their own 600/minute
  bucket, and `test/sources-library.test.ts` runs 70 searches as the regression.
  Found while measuring §19, not by the suite; `backend/README.md` records the
  rule.
- **`websearch_to_tsquery` parses operators, including bare negation.** `-consent`
  becomes `!'consent'` and matches every source *without* the word — so a query of
  pure punctuation like `&& | - "unclosed` is a 200 that returns almost everything
  rather than an empty result. That is websearch semantics and it is kept; the
  test asserts the operator behavior rather than emptiness, which is what the
  first draft wrongly assumed.
- **The page-jump field carries no `min`/`max`.** With them, an out-of-range value
  fails constraint validation and the browser *blocks* the submit, so a typed 99 in
  a 3-page source did nothing. The clamp is in JS, which is what the field
  promises; the attributes would have made "clamped, not rejected" false.
- **`scrollIntoView` is called optionally.** It does not exist in jsdom, and an
  unguarded call threw inside an effect and unmounted the whole reader — the
  highlight is drawn either way, so a missing convenience must not take the screen
  down.
- **Deep links resolve before the location is derived.** The first version set the
  page from whatever had arrived, so a `?passage=` link raced its own lookup: the
  source detail landed first, page 1 was chosen, and the late target could not move
  it (the location is owned by the user's navigation after arrival, by design). The
  reader now waits for the passage lookup to settle, and holds the blocks request
  until the location is known so a deep link costs one fetch rather than two.
- **`sources.test.ts` shared one registered user.** The suite had grown to an
  eleventh `registerUser`, which is one over `/auth/register`'s 10/minute, so the
  last test failed with a 429 that looked like a delete bug. Every test there is
  isolated by its own *space*, so they share an account and only the ownership test
  asks for a second — the fix the helper's own comment prescribes.
- **Mutation checks.** Dropping the `metadata_match` tier, letting `PATCH` accept
  `content`, and dropping the default `archived=exclude` each failed exactly one
  named test. Shifting `endBlockOrd` by one at `persist.ts` failed two — the
  locator round-trip and the reprocess test — because both assert the range
  directly; that is coverage, not duplication, so neither was loosened. Reverting
  the shared-route-options fix failed three, including the new rate-limit test.
- **§19, measured.** With 50 sources of real prose in one space, search worst-case
  24 ms (median 20 ms) against a 500 ms budget; a 200-page PDF's reader opened at
  page 190 took 1.9 ms for the blocks, 2.7 ms for the outline, and 3.2 ms for the
  detail — the §19 2.5 s budget is a client-side number and the server is nowhere
  near it. Numbers from a throwaway suite, not committed.
- **Hand-verified against the running stack** (API + worker + real Ollama
  embeddings + MinIO + a real fetch of `example.com`): a manual source, a web
  source, and an uploaded 3-page PDF all reached `ready`; `?q=consent` ranked the
  title match first; `participants` matched stemmed content; the PDF was found by
  `naps`, a word only on its page 3; `GET /sources/:id/blocks?page=2` returned only
  page 2's text; the page-2 passage resolved to block 2; `PATCH` persisted and
  refused `content` with a 400; archive/restore round-tripped and was idempotent.
  The browser UI itself was not driven — the Chrome extension was not connected in
  this session — so the reader's rendering rests on its Vitest suite.
- **The Phase 2 caveat is resolved.** The integration tests that had never run
  (`sources.test.ts`, `events.test.ts`) were run against the compose stack here;
  the only failure was the register-limit flake above.
