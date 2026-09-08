---
title: Auth — spec
kind: spec
status: current
sources:
  - PRD §3 (account and session), §16 (errors), §17 (security)
  - backend/src/routes/auth.ts
  - backend/src/plugins/session.ts
  - backend/src/middleware/assert-ownership.ts
  - backend/src/routes/health.ts
  - frontend/src/features/auth/
  - frontend/src/lib/api.ts, frontend/src/lib/query-client.ts
created: 2026-08-10
updated: 2026-08-28
tags: [auth, session, ownership, spec]
---

# Spec: Auth

Behavior of registration, sign-in, session lifetime, password reset, and
ownership enforcement, written from the implementation verified at the end of
[[../../plan/phase-0-foundation/tasks|Phase 0]].

Keywords per RFC 2119. Requirement ids are stable; new requirements append.

## Scope

Covers account creation, session handling, password reset, and the
`assertOwnership` guard every resource route depends on. Does **not** cover
spaces, sources, or any other resource — those get their own specs.

The `## Errors` section is cross-cutting rather than auth-specific: the response
envelope and the disclosure rules (including `/health`, REQ-054) apply to every
route in the API, and live here because auth is where they were first enforced.

## Accounts

### REQ-001 — Registration creates an account and signs the user in

The system MUST create a user from a name, an email address, and a password of at
least 8 characters, and MUST establish a session as part of the same request.

- GIVEN no account exists for `a@example.com`
- WHEN `POST /auth/register` is called with a valid name, that email, and a
  password of at least 8 characters
- THEN the response is 201 with `{ user: { id, name, email } }` and sets a
  session cookie.

### REQ-002 — Passwords are stored only as argon2id hashes

The system MUST hash passwords with argon2id and MUST NOT store or return the
plaintext. No response body may include `passwordHash`.

### REQ-003 — Email addresses are normalized and unique

Email addresses MUST be trimmed and lower-cased before storage and comparison,
and MUST be unique across users.

### REQ-004 — Registration does not disclose whether an email is already in use

A registration attempt for an existing address MUST fail with the same status and
an equally generic message as any other rejected registration, and MUST NOT state
that the address is taken. This MUST hold under concurrent submission: the
uniqueness check is advisory, and a request that loses the race to the database
unique constraint MUST produce a byte-identical response to a sequential
duplicate, not a server error.

- GIVEN an account exists for `a@example.com`
- WHEN `POST /auth/register` is called with that address
- THEN the response is 400 with code `registration_failed` and a message that
  does not indicate whether the address exists.

- GIVEN no account exists for `a@example.com`
- WHEN two registrations for that address are submitted concurrently
- THEN exactly one succeeds with 201, and the other is 400 with code
  `registration_failed` and the same body a sequential duplicate receives.

## Sessions

### REQ-010 — Sessions are server-side records referenced by an opaque cookie

The system MUST store each session as a row keyed by a SHA-256 hash of a random
token, and MUST send the token in a cookie that is `HttpOnly` and
`SameSite=Lax`. The cookie MUST additionally be `Secure` when `NODE_ENV` is
`production` (PRD §17 HTTPS-only). The system MUST NOT use a self-contained token
that cannot be revoked server-side.

### REQ-011 — A session survives a page reload

- GIVEN a signed-in user
- WHEN the browser is reloaded and `GET /auth/me` runs during hydration
- THEN the response is 200 with the current user.

### REQ-012 — Sessions slide toward a fresh expiry while in use

The system MUST extend a session's expiry when it is used past the midpoint of
its lifetime, and MUST NOT write on every request.

### REQ-013 — Expired sessions are rejected and cleaned up

A request presenting an expired session MUST be treated as anonymous, the session
row MUST be deleted, and the cookie MUST be cleared.

### REQ-014 — Signing out invalidates the session server-side

- GIVEN a signed-in user with session cookie `C`
- WHEN `POST /auth/logout` succeeds
- THEN the session row is deleted, the cookie is cleared, and a later request
  presenting `C` receives 401.

### REQ-015 — Private endpoints reject anonymous requests

Any endpoint requiring a user MUST answer 401 with code `unauthorized` when no
valid session is presented.

### REQ-016 — Sign-out discards client-side cached data

The client MUST clear its query cache on sign-out so no data belonging to the
previous user remains readable. The signed-out state MUST survive that clearing:
the cache is emptied first and `auth/me` is then set to `null`, so the guard does
not refetch `/auth/me` against the session that was just destroyed while the
authenticated shell is still mounted.

### REQ-017 — A failed session lookup is not a signed-out user

A `/auth/me` request that fails for any reason other than 401 MUST NOT be treated
as "signed out". The client MUST show the failure with a way to retry, and MUST
NOT redirect to `/login` — being bounced to a sign-in form implies the session
ended, which a transient network or server failure does not establish.

- GIVEN a signed-in user
- WHEN hydration's `GET /auth/me` fails with a network error
- THEN the guard renders the error and a retry control, and the URL does not
  change to `/login`.

### REQ-018 — A 401 from any request marks the session lost

The client MUST treat a 401 from *any* endpoint — not only `/auth/me` — as the
session ending, recording it in one place so the route guard performs the
redirect. A session that expires while the user sits on a page MUST NOT surface
as an endpoint-specific failure message.

- GIVEN a user on the authenticated shell whose session is destroyed server-side
- WHEN the next background request (e.g. the `/health` poll) answers 401
- THEN the client state becomes signed-out and the user is redirected to `/login`.

### REQ-019 — Sign-in returns the user to where they were sent away from

When the guard turns an unauthenticated request away it MUST preserve the
requested location (path, query, and fragment), and a successful sign-in MUST
return there rather than to a fixed landing page. The client MUST only honour an
in-application path, so the stored location cannot become an open redirect.

## Sign-in

### REQ-020 — Valid credentials establish a session

`POST /auth/login` MUST return 200 with the user and set a session cookie when
the email exists and the password verifies. It MUST also update `lastActiveAt`.

### REQ-021 — Failed sign-in reveals nothing about the email

A wrong password and an unknown email address MUST produce byte-identical
responses (status, code, and message).

- GIVEN `a@example.com` exists and `nobody@example.com` does not
- WHEN sign-in is attempted with a wrong password for the first, and any password
  for the second
- THEN both responses are 400 with code `invalid_credentials` and the same body.

### REQ-022 — Sign-in cost does not depend on whether the email exists

The system MUST perform password verification work even when no user matches, so
response timing does not disclose account existence. A stored hash that cannot be
parsed MUST be treated as a failed verification and answer REQ-021's generic
rejection — never a server error, which would single that account out.

### REQ-023 — Credential endpoints are rate limited

`register`, `login`, `forgot`, and `reset` MUST be rate limited per client
(currently 10 requests per minute), and MUST answer 429 when the limit is
exceeded.

## Password reset

### REQ-030 — Reset requests answer identically for known and unknown addresses

`POST /auth/forgot` MUST always answer 200 with the same message, whether or not
an account exists.

- GIVEN `a@example.com` exists and `nobody@example.com` does not
- WHEN `POST /auth/forgot` is called for each
- THEN both responses are 200 with identical bodies.

### REQ-031 — Reset tokens are single-use, expiring, and stored hashed

A reset token MUST be random, stored only as a SHA-256 hash, and MUST expire
(default 1 hour). Once used it MUST be rejected on any later attempt, and the
user's other unused tokens MUST be discarded at the same time.

- GIVEN a valid unused token `T`
- WHEN `POST /auth/reset` succeeds with `T`
- THEN a second request with `T` is rejected with 400 and code
  `invalid_reset_token`.

### REQ-032 — A completed reset changes the password and invalidates all sessions

- GIVEN a user with an active session and a valid token
- WHEN the reset succeeds
- THEN the new password authenticates, the old password does not, and every
  pre-existing session for that user is 401 afterward.

### REQ-033 — A rejected reset changes nothing

An invalid, expired, or already-used token MUST leave the password and all
existing sessions untouched.

### REQ-034 — The console-only delivery stopgap cannot reach production

While no email provider is integrated, the system MUST refuse to start when
`NODE_ENV` is `production`, and MUST NOT log a reset token in that environment.
Reset-request logging MUST NOT record the submitted email address: the endpoint is
unauthenticated, so the address is attacker-supplied input.

- GIVEN `hasEmailProvider` is false
- WHEN the server is started with `NODE_ENV=production`
- THEN it exits non-zero with a message naming the missing provider.

> [!note] Delivery is console-only
> No email provider is integrated yet: the reset token is written to the server
> log (`resetToken`, alongside `userId` rather than the email address), which is
> how the Phase 0 verification obtained it. Choosing a provider is an open
> decision recorded in [[../../plan/phase-0-foundation/proposal]]. When a provider
> lands, this section gains a requirement that the token is never returned in an
> HTTP response, and REQ-034's startup guard is removed.

## Ownership

### REQ-040 — Every resource request is checked against the owning space

Each resource MUST resolve to exactly one owning `Space`, and a request MUST be
authorized by comparing that space's `ownerId` to the session user. Every
resource route MUST register the `assertOwnership` guard (PRD §17).

> [!note] Shared spaces v1 (2026-08-28)
> Generalised: the guard is now `assertAccess(resource, param, minRole)` in
> `backend/src/middleware/assert-access.ts`, and "owner" became "member with a
> role at or above the route's". A non-member is still 404 (REQ-041 unchanged);
> a *member* below the role is 403 `insufficient_role`. See
> [[../sharing/spec]] REQ-283–REQ-284.

### REQ-041 — Foreign and missing resources are indistinguishable

A request for a resource owned by another user MUST answer 404 — not 403 — with
the same body as a request for an id that does not exist, so existence is not
disclosed.

- GIVEN space `S` owned by user A
- WHEN user B requests `S`, and separately requests a non-existent id
- THEN both responses are 404 with identical bodies.

### REQ-042 — Authentication is checked before ownership

An anonymous request to an ownership-scoped route MUST answer 401 without
performing an ownership lookup.

## Errors

### REQ-050 — Error responses are a uniform envelope with no internals

Every error MUST be `{ error: { code, message, fields? } }` with a
human-readable message. Responses MUST NOT contain stack traces, SQL, file paths,
or provider details; those go to the server log only (PRD §16).

### REQ-054 — Health output discloses liveness, not infrastructure

`GET /health` is unauthenticated. It MUST report each dependency's reachability,
and in production MUST NOT include the underlying failure message — connection
targets, hostnames, and ports are internals under REQ-050. The full error MUST be
written to the server log in every environment. Outside production the message
MAY be included, so a developer can diagnose from the response.

- GIVEN the database is unreachable and `NODE_ENV` is `production`
- WHEN `GET /health` is called
- THEN the response reports `db.ok === false` with no `detail` field, and the
  connection error appears in the log.

### REQ-051 — Validation failures identify the offending fields

A request failing schema validation MUST answer 400 with code
`validation_failed` and a `fields` map of field name to message, so the client
can render each message beside its input.

### REQ-052 — A failed submission preserves user input

The client MUST keep the values a user entered when a submission fails, and MUST
show the error without clearing the form (PRD §16).

### REQ-053 — Form errors are announced and associated with their inputs

Field messages MUST be linked to their input via `aria-describedby` with
`aria-invalid` set, and form-level messages MUST be announced (PRD §18). A
*failure* MUST be announced assertively (`role="alert"`); a *confirmation* — the
identical reset-request reply of REQ-030, the completed reset of REQ-032 — MUST be
announced politely (`role="status"`) rather than interrupting the screen reader,
and is the only variant that may contain a link. Where a field carries both a hint
and an error, `aria-describedby` MUST list them in DOM order so the spoken order
matches the visual one.

## Verification

All requirements above were exercised at the close of Phase 0, and again after the
2026-08-10 hardening pass (29 backend tests across 5 files):

- `backend/test/auth.test.ts` — REQ-001, 002, 004, 010, 011, 014, 015, 020, 021,
  030, 031, 032, 033, 050, 051.
- `backend/test/auth-hardening.test.ts` — REQ-004 under concurrency, REQ-022
  corrupt-hash branch. Kept separate from `auth.test.ts` so the two suites do not
  share a `/auth/register` rate-limit bucket.
- `backend/test/assert-ownership.test.ts` — REQ-040, 041, 042.
- `backend/test/health.test.ts` — REQ-054 both branches, plus the security
  headers.
- `backend/test/embeddings.test.ts` — the Ollama client's error classification
  (stubbed `fetch`; not an auth requirement, listed for completeness).
- Manual end-to-end run through the Vite proxy — register → `/auth/me` →
  logout → 401 → login → forgot → reset with the logged token → old session 401
  → replay rejected. Re-verified: `/health` 200 all-OK, `degraded` with Redis
  stopped, concurrent registration answering 201 + 400.

The client half is covered as of 2026-08-11 by 38 frontend tests across 7 files
(Vitest + Testing Library in jsdom, `fetch` stubbed with real `Response` objects,
no backend required):

- `frontend/src/features/auth/require-auth.test.tsx` — REQ-011 (hydration renders
  a status, not a redirect), REQ-015, REQ-017 (network failure and 500 both render
  an error with a retry, and neither redirects; the retry recovers).
- `frontend/src/features/auth/use-auth.test.tsx` — REQ-016 (cache emptied *and*
  `auth/me` left `null`, not `undefined`), plus 401 → `null` and the login cache
  seed.
- `frontend/src/lib/query-client.test.ts` — REQ-018 for both a background query
  and a mutation, that a non-401 failure leaves the session alone, and the
  no-retry-on-4xx policy.
- `frontend/src/routes/login-page.test.tsx` — REQ-052 (input preserved, message
  beside its field), REQ-021 as the client renders it, REQ-019 including three
  rejected open-redirect targets.
- `frontend/src/components/ui/field.test.tsx` and `alert.test.tsx` — REQ-053: label
  association, `aria-invalid`, description order, and assertive-vs-polite roles.
- `frontend/src/lib/api.test.ts` — the error envelope (REQ-050/051), 401
  classification, 204, both fallback branches, the malformed-2xx rejection, and a
  transport failure becoming a readable message.

Each of the six behaviors fixed in the review pass was confirmed to be
*load-bearing*: re-introducing the original defect one at a time made exactly the
intended test fail (8 failures across 6 mutations), so these are regression tests
rather than restatements of the code.

Still not covered by an automated test: REQ-012 (sliding expiry), REQ-013 (expired
session cleanup), REQ-022 *timing* parity specifically (the corrupt-hash branch is
covered, the wall-clock symmetry is not), REQ-023 (rate limiting), and REQ-034 (the
production startup guard — asserting it needs a subprocess boot). All five are
backend-side.

## Cross-references

- [[../../plan/phase-0-foundation/proposal]] · [[../../plan/phase-0-foundation/design]] · [[../../plan/phase-0-foundation/tasks]]
- `backend/README.md` — where the ownership and error conventions are enforced.
