---
title: Phase 0 — Tasks
kind: plan
status: done
created: 2026-08-10
updated: 2026-08-10
tags: [phase-0, tasks]
---

# Tasks: Phase 0 — Project foundation

Ordered so the skeleton runs end-to-end (T1–T4) before auth (T5).
Estimated 1–1.5 weeks total ([[../../implementation-plan.md]] §6).

## T1 — Monorepo & infrastructure (root)

- [x] `pnpm-workspace.yaml` + root `package.json` (scripts: `dev`, `build`, `lint`)
- [x] `docker-compose.yml`: `pgvector/pgvector:pg16` (volume, healthcheck)
      + `redis:7-alpine`
- [x] Root `.gitignore`, `.env.example` documentation in README
- [x] Verify: `docker compose up -d` → both containers healthy

## T2 — Backend skeleton (`backend/`)

- [x] Package setup: Fastify 5, TypeScript, tsx (dev), zod,
      `fastify-type-provider-zod`
- [x] `src/config.ts`: zod-parsed env (`DATABASE_URL`, `REDIS_URL`,
      `OLLAMA_BASE_URL`, `EMBEDDING_MODEL=nomic-embed-text`,
      `EMBEDDING_DIM=768`, `SESSION_*`) + `AppConfig` limits loader with
      in-process cache
- [x] Prisma: full `schema.prisma` (all domain models incl. `Passage`
      with `Unsupported("vector(768)")`), first migration with
      `CREATE EXTENSION IF NOT EXISTS vector`, seed script for
      `AppConfig` defaults (PRD §5 limits)
- [x] Plugins: prisma client, redis client, centralized error handler
      (no stack traces to client — PRD §16)
- [x] `GET /health` probing db / redis / ollama with timeouts
- [x] `src/lib/embeddings.ts`: Ollama `POST /api/embed` batch client;
      startup assertion that returned dimension === `EMBEDDING_DIM`
- [x] Verify: `prisma migrate dev` clean; health returns all-OK; embed
      smoke test returns 768-dim vector

## T3 — Frontend skeleton (`frontend/`)

- [x] Vite + React 18 + TS scaffold; Tailwind CSS; shadcn/ui init
- [x] React Router routes: `/login`, `/register`, `/` (authed shell)
- [x] TanStack Query provider + `lib/api.ts` fetch wrapper
      (`credentials: 'include'`, JSON errors normalized)
- [x] Vite dev proxy `/api` → `http://localhost:4000`
- [x] Verify: frontend renders health status fetched from backend

## T4 — End-to-end wiring

- [x] Root `pnpm dev` runs backend + frontend concurrently
- [x] README quick-start: prerequisites (Docker, Ollama +
      `ollama pull nomic-embed-text`), setup commands
- [x] Verify full loop: `docker compose up` → migrate → seed →
      backend up → frontend calls API

## T5 — Auth (backend + frontend)

Backend:
- [x] `Session` + `PasswordResetToken` tables (already in schema) wired
      to session plugin: `sid` HttpOnly cookie, sliding `expiresAt`
- [x] `POST /auth/register` (argon2id hash), `POST /auth/login`,
      `POST /auth/logout` (server-side session delete), `GET /auth/me`
- [x] `POST /auth/forgot` + `POST /auth/reset`: single-use expiring
      token, console-logged delivery (email provider TBD)
- [x] Identical response shapes whether or not the email exists (PRD §3)
- [x] `assertOwnership` preHandler (space → ownerId; 404 for foreign
      resources) + unit tests
- [x] Rate limit auth endpoints (`@fastify/rate-limit`)

Frontend:
- [x] Login/register/forgot/reset forms (accessible labels, error
      states preserved on failure — PRD §16/§18)
- [x] Auth guard: unauthenticated → redirect `/login`; `GET /auth/me`
      hydration on load (session survives refresh — PRD §3)
- [x] Sign-out clears query cache and redirects

Verification (PRD §3 acceptance criteria):
- [x] New user registers → reaches authed screen
- [x] Refresh keeps session; logout invalidates it (second request 401)
- [x] Private route without session → 401; foreign resource → 404
- [x] Auth errors don't reveal email existence

## Exit criteria

All acceptance criteria in [[proposal]] pass. On completion: mark tasks
`[x]`, set frontmatter `status: done`, write/update `specs/auth/spec.md`
from the verified behavior, and append a `log.md` entry.

## Implementation notes (2026-08-10)

Deviations and details worth carrying forward; the spec is
[[../../specs/auth/spec]].

- **Prisma 7** requires a driver adapter (`@prisma/adapter-pg`) instead of a
  connection string on the client, and configuration moved to
  `backend/prisma.config.ts`. `prisma migrate dev` no longer regenerates the
  client — `prisma generate` is a separate step.
- **No HNSW index on `Passage.embedding`.** Prisma has no `Hnsw` index type, so a
  hand-written one appears as drift and `migrate dev` proposes dropping it on
  every later migration. Exact KNN is well inside the §19 budget at MVP scale;
  revisit in Phase 2 when passages are actually written. The `tsvector` GIN index
  *is* declarable and is in the schema.
- **Ollama has no `nomic-embed-text` startup hard-fail when simply absent**: a
  dimension mismatch exits the process, an unreachable service only warns and is
  reported by `/health` as degraded, so the API stays workable offline.
- **Sessions** store a SHA-256 of a 32-byte random token rather than the token
  itself, and slide their expiry only past the halfway point to avoid a write per
  request.
- **Ports**: API `4000`, SPA `5173`, Postgres `5432`, Redis `6379`.

## Cross-references

- [[proposal]] · [[design]] · [[../../specs/auth/spec]] · [[../../implementation-plan.md]]
