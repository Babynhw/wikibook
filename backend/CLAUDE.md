# CLAUDE.md — backend

Conventions, layout, and scripts: [README.md](README.md).

The non-negotiables:

- Build Prisma clients with `createPrismaClient()` (Prisma 7 needs a driver adapter).
- Run `pnpm prisma:generate` after schema changes — `migrate dev` no longer does it.
- Every resource route registers `assertAccess(resource, param, minRole)`; non-members get
  404, members below the role get 403, and every write declares `editor` or `owner`.
- Throw `src/lib/errors.ts` helpers; never let internals reach the client (PRD §16).
  That includes `/health`, which is unauthenticated — dependency error messages are
  logged, and only exposed outside production.
- Read configurable limits through `loadLimits()`, never hard-coded (PRD §5).
- Retrieval eligibility is `retrievableSources()` in `src/lib/retrieval-scope.ts` —
  build every retrieval query from it; never re-derive `state: 'ready'` inline
  (PRD §6/§9/§17).
- The worker logs source ids and never source content (PRD §17).
- Uniqueness pre-checks are advisory. Catch the constraint violation too, and answer
  it identically — a differing response under concurrency is an existence oracle.
- `hasEmailProvider` in `src/config.ts` gates the reset-token logging stopgap; the
  server refuses to boot in production while it is false.
- Answer providers go behind the `AnswerProvider` port in `src/lib/answer-provider.ts`.
  Citation resolution, the drop-and-count rule, and the locator copy live in
  `src/lib/answers.ts` — **outside every adapter**, so a new provider cannot
  re-implement them differently (PRD §9).
