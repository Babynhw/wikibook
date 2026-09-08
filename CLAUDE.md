# CLAUDE.md

WikiBookLM — a personal RAG research workspace. Read `README.md` for setup.

## Where things live

- `backend/` — Fastify + Prisma API. Conventions: `backend/README.md`.
- `frontend/` — Vite + React SPA. Conventions: `frontend/README.md`;
  design tokens: `frontend/DESIGN.md`.
- `wiki-docs/` — project knowledge wiki (plans, designs, specs). Its own rules
  live in `wiki-docs/AGENTS.md`; read it before touching anything in there.
- `RAG Workspace - PRD.docx` — the MVP PRD. Read-only; cite as "PRD §N".

## Working agreements

- The PRD's exclusions are requirements: §20 lists what the MVP must *not* have.
  Adding an excluded feature is a spec violation, not a bonus.
- Retrieval eligibility is a data-layer invariant, not a prompt concern: failed
  or archived sources and unconverted notes must never reach retrieval
  (PRD §6/§9/§17).
- Every resource is access-scoped through its `Space`'s `SpaceMember` rows. New
  resource routes register `assertAccess(resource, param, minRole)`: a
  non-member gets 404 — never 403 — and a member below the route's role gets
  403. Every write route declares `editor` or `owner`
  (`wiki-docs/plan/shared-spaces-v1/design.md`).
- Configurable limits (PRD §5) are read from `AppConfig` at runtime; do not
  hard-code them.
- A change that touches both codebases is still one plan folder under
  `wiki-docs/plan/`, split by codebase inside `tasks.md`.
- After finishing a planned phase: tick its `tasks.md`, set `status: done`,
  write or update the matching `wiki-docs/specs/<capability>/spec.md` from the
  behavior that was actually verified, and append to `wiki-docs/log.md`.
