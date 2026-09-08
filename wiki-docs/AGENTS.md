# AGENTS.md

Schema for the WikiBookLM project knowledge wiki. Read this file first.

## Purpose

A structured, interlinked collection of notes capturing our understanding
of the WikiBookLM project — a personal research workspace (RAG /
NotebookLM-style) where users organize evidence sources, ask
citation-grounded questions, save answers as notes, and draft findings in
a rich-text notebook. The PRD and the codebases are the raw sources of
truth; this wiki is the maintained synthesis that compounds over time.
Every source ingested and every question answered should leave the wiki
slightly richer.

## Project context

- **Status:** pre-implementation (Phase 0 scaffolding). The PRD and the
  implementation plan are currently the primary sources of truth; as code
  lands in `../backend/` and `../frontend/`, the code becomes
  authoritative and the wiki records the synthesis.
- **`../backend/`** — Node.js + TypeScript API (planned): plain
  **Fastify** (no NestJS), **Prisma** + **PostgreSQL 16 + pgvector**
  (relational data + vector search + full-text search in one DB),
  **BullMQ + Redis** for the source-ingestion pipeline
  (Processing → Ready/Failed), session-cookie auth, SSE streaming for
  assistant answers. Serves the REST API consumed by the frontend.
- **`../frontend/`** — React SPA (planned): Vite + React 18 + TypeScript,
  React Router, TanStack Query (+ Zustand for light UI state), **Tiptap**
  for the notebook and note editors, Tailwind CSS + shadcn/ui.
- **AI layer:** answers via the Claude API (`claude-opus-5`, streaming,
  native Citations with `document` content blocks); **embeddings via
  local Ollama** (`nomic-embed-text`, 768 dims) stored in pgvector;
  conversation titles via `claude-haiku-4-5`.
- **Domain models** (per PRD §2): `User`, `Space` (research space),
  `Source` (pdf | web | manual), `Passage` (chunk with page/paragraph
  locator + embedding), `Conversation`, `Message`, `Citation`, `Note`,
  `Notebook` (exactly one per space), `Activity`, `AppConfig`
  (runtime-configurable limits).
- **Key documents:**
  - `../RAG Workspace - PRD.docx` — the Phase 1 MVP PRD (21 sections);
    treat as a raw source, never modify.
  - `implementation-plan.md` — PRD analysis + architecture + roadmap
    (7 phases). `README.md` currently mirrors this plan.
  - Each codebase may grow its own `CLAUDE.md` with coding conventions;
    this wiki documents *understanding and decisions*, not coding
    conventions — link to those files instead of duplicating them.

## Five layers

1. **Raw sources** (`raw/`, `wireframe/`) — immutable. `raw/` holds symlinks
   to project docs (e.g. the PRD at the repo root, backend/frontend
   READMEs). `wireframe/` holds sample screen designs (`screen.png` +
   static `code.html`) catalogued in [[wireframe/index]]. Never modify
   either; both are inputs, and `wireframe/index.md` is the only file in
   that folder the wiki writes.
2. **Wiki pages** (`pages/`) — LLM-written synthesis. Sub-folders:
   `concepts/`, `entities/`, `operations/`, `sources/`.
3. **Living specs** (`specs/`) — RFC 2119 behavioral requirements per
   capability. Updated **after** implementation to reflect reality.
   Natural capability boundaries follow the PRD: `auth`, `spaces`,
   `ingestion`, `library-reader`, `assistant`, `notes`, `notebook`,
   `export`, `home-activity`.
4. **Change proposals** (`plan/`) — in-flight changes. Each is a folder
   with `proposal.md`, `design.md`, `tasks.md`, optional `research.md`.
5. **Schema** — this file + `index.md` + `log.md` + `specs/AGENTS.md`.

## Page conventions

- Lowercase, kebab-case filenames. One topic per file.
- Noun phrases for concepts/entities/sources; verb phrases for operations.
- Every page has YAML frontmatter: `title`, `kind` (concept|entity|operation|source),
  `sources`, `created`, `updated`, `tags`.
- Suggested sections: `## Summary`, `## Details`, `## Cross-references`,
  `## Sources`, `## Open questions`.
- Cross-references use `[[page-name]]` (Obsidian-compatible). Update on
  every change.
- Pages that span both codebases (e.g. the end-to-end citation
  navigation flow, or SSE answer streaming) should state which side owns
  which part and cite files in both repos.

## Wireframes

`wireframe/` holds five sample screens — login, source library, knowledge
assistant, saved notes, research notebook — as a rendered `screen.png` plus
a self-contained `code.html`. Read [[wireframe/index]] before using them; it
maps each screen to the phase and spec it informs, translates the mockups'
vocabulary to this project's domain terms, and lists the elements that are
out of MVP scope.

The rules that matter:

- **Visual reference, never a specification.** A wireframe shows layout and
  hierarchy. Behavior comes from `specs/`, scope from the PRD, tokens from
  `../frontend/DESIGN.md`.
- **A feature drawn in a mockup is not an approved feature.** The samples
  include reading statuses, tags, social sign-in, and a trash — §20
  exclusions and unspecified extras. Implementing one because it appears on
  screen is a spec violation; it needs a `plan/` proposal first.
- **Never copy `code.html` markup or its `tailwind.config`.** The mockups are
  Tailwind v3 via CDN; the SPA is v4 with CSS-first `@theme` tokens. Copy the
  layout, express it with existing tokens and `frontend/src/components/ui/`
  primitives.
- **The mockups' branding and language are artifacts**, not requirements:
  they say "Folio" and their copy is Vietnamese; the product is WikiBookLM
  and English-only (PRD §1).
- When a screen is implemented, record the *verified* behavior in the
  capability's spec and cross-reference the wireframe — the spec, not the
  mockup, becomes the truth.

## Operations

### Ingest (a new source)

1. Place or symlink the source in `raw/`. Never modify it.
2. Read the source. Discuss key takeaways with the user.
3. Create/update `pages/sources/<slug>.md` summarizing the source.
4. Update affected concept/entity/operation pages: revise summaries, add
   cross-references, note contradictions, surface open questions.
5. Update `index.md`. Append an `ingest` entry to `log.md`.

A single source can touch 5-15 wiki pages. Don't be shy about touching
many — that is the whole point.

### Query (a question)

1. Read `index.md` to find candidate pages.
2. Read those pages (and raw sources they cite, when needed).
3. Synthesize an answer with citations. Cite both wiki pages and raw sources.
4. If the answer is worth keeping, file it back as a new page or section.

### Update spec (requirement change or new feature)

1. Read existing `specs/<capability>/spec.md` and related `plan/` proposals.
2. Add/update REQ-NNN entries with RFC 2119 keywords and GIVEN/WHEN/THEN.
   The PRD's acceptance criteria (per section) are the seed requirements.
3. If spec diverges from built code, add a `> [!warning] Spec-vs-code`
   Obsidian callout explaining the discrepancy.
4. Update cross-references. Update `index.md`. Append `update` to `log.md`.

### Create change proposal

1. Create `plan/<change-name>/` with `proposal.md`, `design.md`, `tasks.md`.
2. Add cross-references between proposal and spec.
3. Update `index.md` plan section. Append `create` to `log.md`.
4. After implementation: mark tasks `[x]`, set `status: done`, update spec.
5. A change that touches both backend and frontend is still **one**
   proposal — split the work inside `tasks.md` by codebase, don't create
   two plans.

### When to skip spec / plan

Skip for: bug fixes of 1–2 lines, config tweaks, hotfixes, behavior-preserving
refactors. When in doubt, at least add a `log.md` entry.

### Lint (periodic health check)

1. Walk every page: stale claims, broken `[[links]]`, orphan pages,
   contradictions, missing cross-references.
2. Check specs for spec-vs-code drift. Add/update `> [!warning] Spec-vs-code`
   callouts where needed.
3. Look for topics mentioned but lacking a page.
4. Append a `lint` entry to `log.md`.

## index.md

Catalog of all wiki content: **Pages** (by kind), **Specs** (REQ range),
**Plan** (status + one-line description). Read it first on every query.
The LLM reviews and updates it on every change — not mechanically.

## log.md

Append-only. Each entry: `## [YYYY-MM-DD] <verb> | <title>`.
Verbs: `ingest`, `query`, `lint`, `create`, `update`, `delete`,
`restructure`, `bootstrap`. Keep entries short (1-3 lines).

## Spec-driven conventions

See **`specs/AGENTS.md`** for full spec format, callout types, change
proposal structure, feature workflow (including research step), and
commands to create/verify specs.

## Tooling

Use the built-in search tools over both codebases:

- **Known target** (file name, function name, exact string) →
  grep/code search scoped to `../backend/src/` or the relevant
  `../frontend/src/` folder.
- **API surface questions** → start from the Fastify route definitions
  in `../backend/src/` (routes + zod/typebox schemas).
- **Data model questions** → `../backend/prisma/schema.prisma` and its
  migrations.
- **Ingestion pipeline questions** → the BullMQ workers in
  `../backend/src/` (extract → chunk → embed → ready).
- **Frontend data-flow questions** → the feature folder in
  `../frontend/src/` (TanStack Query hooks → API client → components).
- **"What should this screen look like?"** → [[wireframe/index]] for the
  layout, `../frontend/DESIGN.md` for the tokens. Read the index first: it
  says which parts of each mockup are out of scope.
- **PRD questions** → the extracted text of `../RAG Workspace - PRD.docx`
  (convert with `textutil -convert txt` when needed; do not edit the docx).

Exclude `node_modules/`, `dist/`, and generated Prisma client output from
searches — build artifacts, not source.

## Boundaries

### Always

- Update cross-references (`[[...]]`) when modifying any page.
- Append `log.md` after every change.
- Update `index.md` when pages/specs/plans are created, renamed, or deleted.
- Cite raw sources for factual claims (PRD section numbers, e.g. "§6",
  are the preferred citation form while the project is pre-code).
- Use English for all wiki content.
- Update spec frontmatter `updated` date on every spec edit.

### Ask first

- Delete or archive a plan/spec.
- Restructure `index.md` beyond adding/removing entries.
- Rename a wiki page (breaks inbound `[[links]]`).
- Create a new top-level directory.

### Never

- Write to `raw/`. Treat sources as read-only.
- Edit `wireframe/*/code.html` or `wireframe/*/screen.png` — they are
  samples, not project code. Only `wireframe/index.md` is maintained.
- Treat a wireframe as authorization for a feature the PRD excludes (§20)
  or a spec does not describe.
- Write to `../backend/` or `../frontend/` from a wiki task — the wiki
  documents the code; code changes happen in their own sessions.
- Touch `.obsidian/`. That is the user's Obsidian config.
- Edit `index.md` mechanically without reviewing the catalog.
- Duplicate content — link to existing pages instead.
- Modify spec requirements to match code without adding a
  `> [!warning] Spec-vs-code` callout explaining the divergence.

## Non-obvious patterns

These are counterintuitive decisions that agents cannot infer from the
file structure alone:

- **Specs are updated AFTER implementation, not before.** The spec is the
  *current truth* of what was built, not a forward-looking design doc.
  Write the spec first to define WHAT, then update it after code lands to
  reflect what was actually built — including divergences via callouts.
- **The PRD's scope exclusions are requirements too.** PRD §20 lists what
  MVP must NOT have (reading statuses, tags/folders, annotation tools,
  summarize mode, etc.). Specs and proposals should treat adding an
  excluded feature as a spec violation, not a nice-to-have.
- **Retrieval-eligibility is a hard invariant, not a prompt concern.**
  Failed/archived sources and unconverted notes must never enter
  retrieval (PRD §6/§9/§17). Any page or spec about the assistant should
  restate this as a data-layer filter.
- **`raw/` uses symlinks, not copies.** This ensures the wiki always
  reflects the latest version of the source docs without manual sync.
  Never replace a symlink with a copy.
- **When spec and code conflict, code wins — but the spec must record
  the gap.** Don't silently edit the spec to match code. Instead, add a
  `> [!warning] Spec-vs-code` callout so the original intent is preserved
  alongside the reality.
- **`index.md` is human-curated, not auto-generated.** The LLM reviews
  the catalog on each change and updates it thoughtfully. Mechanical
  regeneration would lose summaries and metadata.
- **One spec per capability, not per feature.** Features come and go via
  `plan/` proposals, but the spec accumulates all REQs for a capability
  over time. A single `specs/spaces/spec.md` covers create, rename,
  archive/restore, and any future research-space features.
- **`README.md` in this folder currently duplicates
  `implementation-plan.md`.** Treat `implementation-plan.md` as the
  canonical copy; if they drift, trust it and flag the drift rather than
  reconciling silently.
