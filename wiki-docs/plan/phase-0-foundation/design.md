---
title: Phase 0 — Design
kind: plan
status: done
created: 2026-08-10
updated: 2026-08-10
tags: [phase-0, design]
---

# Design: Phase 0 — Project foundation

## Repository layout

```
WikiBookLM/
├── pnpm-workspace.yaml          # packages: backend, frontend
├── docker-compose.yml           # postgres (pgvector), redis
├── backend/
│   ├── package.json             # fastify, prisma, bullmq, argon2, zod
│   ├── tsconfig.json
│   ├── prisma/
│   │   └── schema.prisma        # full domain model (below)
│   ├── .env.example
│   └── src/
│       ├── index.ts             # bootstrap: env → plugins → routes → listen
│       ├── config.ts            # env parsing (zod) + runtime limits
│       ├── plugins/             # prisma, redis, session, error-handler
│       ├── routes/
│       │   ├── health.ts        # GET /health
│       │   └── auth.ts          # register/login/logout/forgot/reset
│       ├── middleware/
│       │   └── assert-ownership.ts
│       └── lib/
│           └── embeddings.ts    # Ollama client
└── frontend/
    ├── package.json             # react 18, react-router, tanstack-query, tailwind
    ├── vite.config.ts           # dev proxy /api → backend
    └── src/
        ├── main.tsx             # QueryClientProvider + RouterProvider
        ├── routes/              # /login, /register, / (authed home shell)
        └── lib/api.ts           # fetch wrapper, credentials: 'include'
```

## Decisions

### Monorepo: pnpm workspaces

Verified on the dev machine: Node 22, pnpm 10, Docker 29. No Turborepo/Nx
— two packages don't justify the tooling. Shared types can move to a
`packages/shared` workspace later if duplication appears.

### Infrastructure: docker-compose

| Service | Image | Notes |
|---|---|---|
| `db` | `pgvector/pgvector:pg16` | pgvector preinstalled; volume for data |
| `redis` | `redis:7-alpine` | BullMQ backing store (queue used from Phase 2) |

Ollama is **not** in compose — it already runs natively on the host with
`nomic-embed-text` pulled; backend reaches it at
`OLLAMA_BASE_URL=http://localhost:11434`.

### Backend: plain Fastify (decision: no NestJS)

- Fastify v5 + TypeScript, zod for schema validation (via
  `fastify-type-provider-zod`).
- Structure is route-file based, not layered-framework based; services
  get extracted when route files grow, not preemptively.
- Error handler: human-readable messages, never stack traces or provider
  details to the client (PRD §16).

### Database: one PostgreSQL for everything

Relational data + pgvector (vector search) + tsvector (full-text search)
in a single DB. At MVP scale (≤50 sources/space, PRD §5) a dedicated
vector DB adds operational cost with no benefit. First migration runs
`CREATE EXTENSION IF NOT EXISTS vector`.

Prisma schema covers all domain models up front (see
[[../../implementation-plan.md]] §3 for the full sketch): `User`,
`Space`, `Source`, `Passage` (with `embedding vector(768)` as
`Unsupported("vector(768)")`), `Conversation`, `Message`, `Citation`,
`Note`, `Notebook`, `Activity`, `AppConfig`. Defining the schema now —
even though Phase 0 only *uses* `User` and session storage — makes every
later phase a behavior change, not a schema redesign.

### Embeddings: local Ollama, `nomic-embed-text` (768 dims)

- Decision (2026-08-10): local Ollama instead of Voyage/OpenAI — no API
  cost, English-only content (PRD §1) is well served by
  `nomic-embed-text`.
- Client: `POST {OLLAMA_BASE_URL}/api/embed` with
  `{ model, input: string[] }` — batch-capable, returns
  `{ embeddings: number[][] }`.
- **The vector dimension (768) is baked into the Prisma schema.**
  Changing the embedding model later requires a migration + full
  re-embed; the model name and dimension both live in config so the
  mismatch fails loudly at startup.

### Sessions: DB-backed cookie sessions (no JWT)

- `Session` table (id, userId, expiresAt) + `sid` HttpOnly/SameSite=Lax
  cookie; `Secure` in production (PRD §17 HTTPS-only).
- DB-backed so sign-out genuinely invalidates the session server-side
  (PRD §3 "Signing out invalidates the active session") — stateless JWTs
  can't do that without a denylist.
- Passwords hashed with `argon2id`.
- Register/login/forgot all return the same generic error/success shape
  regardless of whether the email exists (PRD §3).
- Password reset: single-use token table with expiry; token delivery is
  console-logged until an email provider is chosen (open decision, see
  proposal).

### `assertOwnership` middleware

Fastify preHandler: resolves the target resource's owning `Space` →
`ownerId` and compares to the session user. Returns 404 (not 403) for
foreign resources so existence isn't leaked. Every resource route added
in later phases must register it — this invariant is restated in the
wiki because it is a PRD hard requirement (§17), not a convention.

### Runtime-configurable limits (PRD §5)

`AppConfig` key-value table seeded with defaults
(`pdf_max_bytes=26214400`, `pdf_max_pages=200`,
`manual_max_chars=100000`, `sources_per_space=50`), read through
`config.ts` with an in-process cache. Environment variables override for
local dev. No code change needed to adjust limits.

### Frontend

- Vite dev server proxies `/api` to the backend so cookies are same-origin
  in development.
- TanStack Query for all server state; an `AuthProvider` route guard
  redirects unauthenticated users to `/login`.
- Tailwind + shadcn/ui primitives from the start so dialogs/forms meet
  PRD §18 accessibility (focus management, Escape-to-close, aria-live).

## Health check contract

`GET /health` → `{ status, db, redis, ollama }` — each dependency probed
with a short timeout; degraded dependencies reported individually. Used
as the Phase 0 acceptance gate and later by deployment probes.

## Cross-references

- [[proposal]] — scope and acceptance criteria.
- [[tasks]] — work breakdown.
- [[../../implementation-plan.md]] — full architecture (§2), data model (§3), API surface (§5).
