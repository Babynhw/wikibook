---
title: Phase 0 — Project foundation
kind: plan
status: done
created: 2026-08-10
updated: 2026-08-10
tags: [phase-0, infrastructure, auth, scaffolding]
---

# Proposal: Phase 0 — Project foundation

## Problem

The repository contains only placeholder `backend/` and `frontend/`
directories. Nothing can be built, run, or tested. Every later phase
(ingestion, assistant, notebook — see `../../implementation-plan.md`)
assumes a running API, a database with pgvector, a job queue, and an
authenticated user context.

## Goal

A skeleton that runs end-to-end on a developer machine:

```
docker compose up  →  prisma migrate  →  backend health check OK
                   →  frontend loads and calls the API
                   →  a user can register, log in, log out
```

## Scope

1. **Monorepo** — pnpm workspaces; `backend/` and `frontend/` as
   TypeScript packages.
2. **Local infrastructure** — `docker-compose.yml` with PostgreSQL 16 +
   pgvector and Redis. Ollama runs natively on the host (already
   installed, `nomic-embed-text` pulled) and is *not* containerized.
3. **Backend skeleton** — plain Fastify server with health check; full
   Prisma schema for all domain models (PRD §2 plus `Passage`,
   `Activity`, `AppConfig`); first migration enabling the `vector`
   extension; runtime config module for the PRD §5 limits; Ollama
   embeddings client.
4. **Frontend skeleton** — Vite + React 18 + TypeScript, React Router,
   TanStack Query, Tailwind CSS.
5. **Auth** — register / login / logout / password reset with session
   cookies (HttpOnly) + argon2, and an `assertOwnership` middleware
   skeleton (PRD §3, §17).

Auth is in scope for Phase 0 deliberately: every resource in the PRD is
ownership-scoped, so building routes before auth means retrofitting all
of them later.

## Out of scope

Source ingestion, retrieval, the assistant, notes, notebook, export,
home/activity — Phases 2–7 in [[../../implementation-plan.md]]. No
deployment setup (local dev only). No email delivery integration —
password-reset tokens are logged to the console until a provider is
chosen (open decision).

## Acceptance criteria

- `pnpm install` at the root installs both packages.
- `docker compose up -d` starts Postgres (with pgvector available) and
  Redis; `pnpm --filter backend prisma migrate dev` applies the schema.
- `GET /health` returns 200 with DB, Redis, and Ollama reachability.
- The embeddings client returns a 768-dim vector for a sample string via
  local Ollama `nomic-embed-text`.
- A new user can register, reach an authenticated screen, refresh the
  browser without losing the session, and sign out (session invalidated)
  — PRD §3 acceptance criteria.
- Auth errors do not reveal whether an email address exists (PRD §3).
- Unauthenticated requests to private routes are rejected (401), and a
  cross-user request to another owner's resource is rejected (404/403)
  via `assertOwnership`.

## Cross-references

- [[../../implementation-plan.md]] — architecture and roadmap this phase implements.
- PRD `../../../RAG Workspace - PRD.docx` §2 (data objects), §3 (account
  and session), §5 (configurable limits), §17 (security).
- [[design]] — technical decisions for this phase.
- [[tasks]] — work breakdown.
