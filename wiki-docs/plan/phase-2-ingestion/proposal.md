---
title: Phase 2 — Source ingestion
kind: plan
status: done
created: 2026-08-12
updated: 2026-08-12
tags: [phase-2, ingestion, sources, pipeline, embeddings]
---

# Proposal: Phase 2 — Source ingestion

## Problem

Phase 1 delivered a research space that a user can create, open, and
archive — and then nothing. The space shell renders four empty regions
and an **Add source** button that is deliberately disabled with a hint
([[../phase-1-spaces/design]], `frontend/src/routes/space-page.tsx:125`).
A space with no evidence cannot be searched (Phase 3), cannot be asked a
question (Phase 4), and cannot produce a citation to save as a note
(Phase 5). Ingestion is the bottleneck for every remaining phase.

The infrastructure for it was built in Phase 0 and has never been
exercised: Redis boots and reports healthy but backs no queue
(`backend/src/plugins/redis.ts:15`), the Ollama embeddings client passes
a startup dimension check and then embeds nothing
(`backend/src/lib/embeddings.ts`), and `Source` / `Passage` — including
the `vector(768)` and `tsvector` columns and the GIN index — are empty
tables. The schema comment on `Passage` explicitly defers the ANN-index
question to "Phase 2 when passages are actually written"
(`backend/prisma/schema.prisma:146`).

This is also the first phase where the system does real work on behalf
of a user *after* the request returns, which means it is the phase that
has to get failure right: a state model, a human-readable error, and a
retry that does not duplicate anything (PRD §6).

## Goal

A user can add a PDF, a web article, and a typed text source to a space,
watch each one process, recover from a failure, and end up with passages
that carry an exact location for a future citation.

```
space shell → Add source (PDF | Web link | Text)
            → source appears as Processing
            → Ready  … passages written, embedded, retrieval-eligible
            → Failed … human-readable reason → Retry → Ready
                                             → Delete (confirmed) → gone
```

## Scope

1. **Three source types** (PRD §5) — text-based PDF upload, HTTP(S)
   article URL, and manually entered text. One Add Source affordance
   with three tabs; §5.3 forbids offering "pasted text" and "manual
   source" as separate options.
2. **The processing pipeline** (PRD §6) — validate, preserve the
   original, extract or normalize text, preserve page / paragraph /
   section references, split into passages, embed, mark ready. Run as a
   queued background job so the API request returns immediately.
3. **Processing states** — `processing` → `ready` | `failed`, exposed on
   every source. System states only, never user reading statuses (PRD
   §6, §7's "must not display" list, §20).
4. **Failure, retry, delete** (PRD §6 error handling, §17) — a
   plain-language error message, a retry that reuses the same source row
   and replaces its extraction, and a confirmed permanent delete that
   removes the stored original, the extracted text, the passages, and
   the source's citation rows.
5. **Live state updates over SSE** — the worker publishes each
   transition and the client receives it, instead of asking repeatedly.
   The transport is the one Phase 4 streams assistant tokens over.
6. **Configurable limits** (PRD §5) — `pdf_max_bytes`, `pdf_max_pages`,
   `manual_max_chars`, `sources_per_space` enforced from `AppConfig`
   through `loadLimits()`. The keys and their defaults already exist
   (`backend/src/lib/app-config-defaults.ts`); Phase 2 is the first
   consumer.
7. **Retrieval eligibility as a data-layer invariant** — one exported
   filter (`ready` and not archived) that Phase 4 is required to use,
   established now while there is no assistant to work around it
   (PRD §6/§9/§17).
8. **A minimal source list** in the space shell, replacing the empty
   state: title, type, author or publisher, processing state when not
   ready, and date added — exactly §7's source-list information, with
   none of §7's search, filter, or edit behavior.
9. **`source.added` / `source.ready` / `source.failed` activity rows**,
   continuing Phase 1's decision to write history before the Phase 7
   feed exists (PRD §15).

## Out of scope

- **Search, type filters, archive/restore of a source, editing title and
  author, and the source reader** (PRD §7, §8) — Phase 3. Phase 2 writes
  the `tsv` column the search will use, but exposes no search route.
- **The assistant, retrieval, and citations** (PRD §9) — Phase 4.
  Passages and embeddings are written and are queryable; nothing reads
  them yet.
- **Converting a note into a source** (PRD §12) — Phase 5. It re-enters
  this same pipeline through the manual path, and `Source.originNoteId`
  already exists for it; the plan records what Phase 5 must reuse and
  builds nothing for it.
- **Percentage progress bars or per-stage progress.** §6 defines three
  states; a fourth "extracting, 40%" state is invented scope. The SSE
  stream this phase builds carries state transitions only.
- **Streaming anything other than source state.** The transport is built
  here and Phase 4 reuses it for assistant tokens; Phase 2 publishes no
  other event type.
- **DOCX, PowerPoint, audio, video, OCR for scanned documents,
  Drive/Dropbox/Notion imports** — §20 exclusions. A scanned PDF with no
  text layer is a *failure with a clear message*, not an OCR feature.
- **Headless-browser rendering for JavaScript-only or paywalled pages** —
  extraction failure with a retry action instead ([[../../README]] §7
  risk 3).
- **Reading statuses, tags, folders, importance, highlights,
  annotations** — §20 exclusions, and several appear in the
  `source_library` mockup; see [[../../wireframe/index]].

## Acceptance criteria

From PRD §5 and §6, plus the §21 scenario steps this phase completes.

**Ingestion (§5)**

- A text-based PDF is accepted; a corrupted, password-protected, empty,
  or non-PDF file is rejected with a human-readable reason.
- The original uploaded file is preserved and still retrievable after
  processing.
- A valid HTTP or HTTPS URL yields the page's primary article content
  with navigation, advertising, and cookie notices excluded where
  practical; the original URL is preserved, and title, publisher,
  author, and publication date are captured when available.
- A manual source requires a title and non-empty content, accepts an
  optional author, and becomes available to retrieval after processing.
- The interface offers one manual text option, not two.
- The four limits are enforced and can be changed in `AppConfig` without
  a code change or a redeploy.

**Processing (§6)**

- Every source passes through `processing` and ends in `ready` or
  `failed`.
- Every ready passage can be traced to an exact source location: PDF
  passages carry a page number, web and manual passages carry a
  paragraph or section reference.
- A passage never contains text from more than one source.
- Failed sources never appear in retrieval, and neither do archived
  ones.
- Failed processing shows a human-readable error, and can be retried.
- Retrying produces no duplicate source rows and no duplicate passages;
  reprocessing replaces the previous extraction and retrieval index.
- Citations whose passage did not survive a reprocess are preserved
  where they can be re-matched and marked stale otherwise. (No citation
  can exist until Phase 4, so this is verified against hand-seeded rows —
  see [[tasks]].)
- A failed source can be deleted, deletion asks for confirmation, and it
  removes the file, the text, the passages, and the source's citations.
- PDF page references remain accurate after processing.

**Non-functional**

- An ordinary text-based PDF processes within two minutes at the 90th
  percentile (PRD §19).
- A state change reaches an open space view without the user reloading;
  where the event stream cannot be established, the state still resolves
  (PRD §16).
- Processing state changes are announced to assistive technology and are
  not communicated by color alone (PRD §18).
- Stored originals are encrypted at rest by bucket configuration, and no
  storage endpoint or credential reaches the browser (PRD §17).
- Every source route enforces ownership and answers 404 — never 403 —
  for another user's source (PRD §17).
- Uploaded files are validated before processing, and application logs
  do not contain full source content (PRD §17).

## Cross-references

- [[design]] — decisions: storage, the worker process, extraction
  libraries, chunking, and the retry/reprocess semantics.
- [[tasks]] — work breakdown, split by codebase.
- [[../phase-1-spaces/proposal]] — the space this hangs off, and the
  inert Add Source action this phase activates.
- [[../phase-0-foundation/design]] — the schema, Redis, and the
  embeddings client that were built for this phase.
- [[../../specs/spaces/spec]] — the frozen-archived-space rule that
  source writes inherit.
- [[../../wireframe/index]] — `source_library` layout reference and its
  out-of-scope elements.
- PRD `../../../RAG Workspace - PRD.docx` §2 (Source, Passage,
  Citation), §5 (source types and limits), §6 (processing), §15
  (activity), §16 (states), §17 (security), §18 (a11y), §19
  (performance), §20 (exclusions), §21 (end-to-end scenario).
