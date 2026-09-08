---
title: Wireframes — design reference
kind: source
sources:
  - wireframe/*/code.html (static mockups, Tailwind v3 CDN)
  - wireframe/*/screen.png (rendered screenshots)
  - ../../frontend/DESIGN.md (canonical tokens)
  - RAG Workspace - PRD.docx §2, §6–§13, §20
created: 2026-08-11
updated: 2026-08-27
tags: [wireframe, design, ui, reference]
---

# Wireframes

Six sample screens showing the intended look and layout of the workspace. Each
folder holds `screen.png` (what it looks like) and `code.html` (a self-contained
static mockup — Tailwind v3 from the CDN, Material Symbols icons, no build step;
open it directly in a browser).

## How to use these

They are a **visual reference, not a specification**. When a wireframe disagrees
with something else, the something else wins:

| Question | Authority |
|---|---|
| Is this feature in the MVP? | the PRD — especially §20's exclusions |
| What are the exact colors, fonts, radii, spacing? | [`frontend/DESIGN.md`](../../frontend/DESIGN.md) → `frontend/src/index.css` |
| How does it behave? | the matching `specs/<capability>/spec.md` |
| What is this thing called? | the domain model (PRD §2) — see the vocabulary table below |
| How is it built? | `frontend/README.md` conventions |

The mockups' tokens were generated from the same palette as `DESIGN.md`
(`primary #003fb1`, Inter + JetBrains Mono), so colors can be trusted — but
**do not copy `code.html` markup or its `tailwind.config` block**. The SPA is
Tailwind v4 with CSS-first `@theme` tokens in `src/index.css`; the mockups are v3
CDN config objects. Copy the *layout and hierarchy*, express it with existing
theme tokens and the primitives in `frontend/src/components/ui/`.

## The screens

| Screen | Shows | Lands in |
|---|---|---|
| [`login/`](login/screen.png) | Split layout: library photo + quiet marketing panel on the left, sign-in form on the right | Phase 0 — implemented as `frontend/src/routes/login-page.tsx`; [[../specs/auth/spec]] |
| [`source_library/`](source_library/screen.png) | Sidebar nav + source cards in a grid, category filters with counts, a citation-extract card, grid/list toggle, sort | Phase 2–3 — ingestion, library + reader. Its **left rail is built** ([[../plan/space-sidebar/proposal]], density/type/Add Source matched 2026-08-27 by [[../plan/space-sidebar-wireframe-parity/proposal]]): space identity, **Add Source**, Sources, Assistant, Notes. Citations and Drafts, its grid/list toggle, sort, and category counts are not. |
| [`knowledge_assistant/`](knowledge_assistant/screen.png) | Three panes: nav, Q&A thread with inline `[1]`/`[2]` citation markers, and a source reader on the right showing the cited page with the passage highlighted plus "other relevant excerpts" | Phase 4 — assistant, retrieval, citations. Its **pane header is built** to the mockup's `h-16` row (icon · truncated title · `author • publisher` line · one control) as `ReaderHeader variant="compact"`, 2026-08-27 by [[../plan/assistant-pane-reader-header/proposal]] — REQ-236. "Other relevant excerpts" is not. The **chat-history hub** at the bare assistant route (2026-08-27, [[../plan/assistant-chat-history/proposal]], REQ-238) is a WikiBookLM addition: the wireframe draws only the thread, and the hub follows a ChatGPT project page instead. |
| [`saved_notes/`](saved_notes/screen.png) | Masonry of note cards, each carrying its provenance (which chat or source it came from) and a convert/handle affordance | Phase 5 — notes, save-as-note, convert-to-source |
| [`source_detail/`](source_detail/screen.png) | The reader: `← Library / Project Alpha` breadcrumb, a ruled-off header (`Edit details · Download · ⋮`, type chip, date, page count), and a bordered viewer — a pager toolbar over a paper-white serif reading column with a large heading | Built 2026-08-27 ([[../plan/source-detail-reader/proposal]]); [[../specs/library-reader/spec]] REQ-236. Its **zoom** controls (−/100%/+/fit) are not adopted: the reader renders extracted text, not the PDF, and PRD §8 asks only for page navigation. |
| [`research_notebook/`](research_notebook/screen.png) | Full-width rich-text document, "Last edited 2 mins ago", with a right-hand Research Panel tabbed Saved Notes / Citations | Phase 6 — **implemented 2026-08-27** as `/spaces/:id/notebook` ([[../specs/notebook/spec]]): the document column, a sticky toolbar the mockup omits, save state where "Last edited" sits, and the panel with the notes list and one note open. Left out on purpose: the **Citations tab** (no PRD counterpart — citations live in the document), "Search Notebooks…" (cross-space), `Private`, the project chip, **Add New Note** (the notes page owns creation). |

The three-pane assistant layout is the most useful of the six: it shows what
citation deep-linking is supposed to *feel* like — answer on the left, the exact
cited page open on the right, the quoted passage highlighted in place (PRD §7/§8).

## Vocabulary: mockup label → domain term

The mockups predate this project's naming. Translate, don't adopt:

| In the mockup | In this codebase |
|---|---|
| Folio | WikiBookLM |
| Project Alpha / "New Project" | **Space** (research space) |
| Workspace (nav item) | the authenticated shell / home |
| Knowledge Assistant / "Folio AI" | the assistant (`Conversation`, `Message`, `Citation`) |
| Saved Notes & Insights | `Note` |
| Notebook / Research Panel | `Notebook` (exactly one per space) + its side panel |
| Citations (nav item) | `Citation` records, surfaced per source |

## Not in scope — do not implement from these mockups

The samples are richer than the MVP. These elements appear on screen but are
**excluded or unspecified**, and PRD §20's exclusions are requirements, not
suggestions:

- **Reading statuses and progress** — `Read (100%)`, `Unread`, `Not Started`, the
  65% progress bar in `source_library`. Excluded by §20.
- **Tags / folders** — the `TAGS` filter in `source_library`, the `#methodology`
  `#ethics` chips in `saved_notes`. Excluded by §20.
- **Social sign-in** — "Tiếp tục với Google" and "Tiếp tục với ORCID" in `login`.
  Not in [[../specs/auth/spec]], which is email + password with DB-backed cookie
  sessions; adding it needs a change proposal, not a copy-paste.
- **Trash, Drafts, notifications, Help, per-user settings** — sidebar and header
  items with no counterpart in the PRD §2 domain model.
- **Cross-space search** — the header "Search workspace…" searches globally;
  retrieval and search are scoped to one space.

Two more deltas that are artifacts of the sample rather than decisions: the
**"Folio" branding** throughout, and the **Vietnamese UI copy** (the product is
English-only per PRD §1 — the wiki is bilingual, the product is not).

**Resolved 2026-08-14: icons are lucide.** Generating the shadcn `sidebar` for
[[../plan/space-sidebar/proposal]] settled this by consequence —
`components.json` says `"iconLibrary": "lucide"`, so the CLI resolves its icon
placeholders to `lucide-react` and installs it. Material Symbols is not adopted;
translate the mockups' icon names at the call site. Tree-shaken per icon, no
webfont, no CDN request — the same reason `index.css` self-hosts its fonts.

## Cross-references

- [[../index]] · [[../AGENTS]] — how this folder fits the wiki's layers.
- [[../specs/auth/spec]] — the only capability of these five that is built.
- [[../plan/phase-0-foundation/design]] — the architecture the later screens land in.
