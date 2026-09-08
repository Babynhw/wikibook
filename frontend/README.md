# frontend

Vite + React 18 + TypeScript SPA for WikiBookLM. Tailwind CSS v4 with the design
tokens from [`DESIGN.md`](DESIGN.md); TanStack Query for all server state.

## Scripts

| Script | Does |
|---|---|
| `pnpm dev` | Vite dev server on `:5173`, proxying `/api` → `:4000` |
| `pnpm build` | Type-check and build to `dist/` |
| `pnpm lint` | Type-check only |
| `pnpm test` | Vitest + Testing Library, jsdom, no backend needed |
| `pnpm test:watch` | The same suite in watch mode |

The backend must be running for anything past the login screen; start both with
`pnpm dev` from the repository root.

## Layout

```
src/main.tsx              QueryClientProvider + BrowserRouter
src/app.tsx               Route table
src/index.css             Tailwind v4 @theme tokens from DESIGN.md
src/lib/api.ts            fetch wrapper + endpoint types
src/lib/query-client.ts   QueryClient factory: retry + session-lost rules
src/lib/utils.ts          cn() class combiner
src/components/ui/        Hand-written shadcn-style primitives
src/components/           error-boundary.tsx
src/features/auth/        Session hooks, route guard, form frame
src/routes/               login, register, forgot, reset, home, space, source, notes, assistant, notebook (+ print), members, space activity, invite
src/features/notebook/    Tiptap editor, autosave, citation node, Research panel, export menu, presence
src/features/members/     Roster, invites, roles (shared spaces); `useSpaceRole` in features/spaces gates every write affordance
src/test/                 setup.ts + render/fetch helpers (test-only)
**/*.test.tsx             Colocated beside the unit under test
```

## Conventions

- **All API access goes through `src/lib/api.ts`.** It sends
  `credentials: 'include'`, normalizes the backend's `{ error: { code, message,
  fields } }` envelope into `ApiError`, and turns a network failure — or a 2xx
  whose body isn't the JSON we expect — into a readable message rather than a raw
  `TypeError` further down.
- **Requests go to the relative path `/api`, never an absolute origin**, so the
  session cookie is same-origin. In development the Vite proxy strips the prefix
  (`/api/auth/me` → `:4000/auth/me`); **a deployment must do the same rewrite**,
  since the backend mounts its routes at the root. There is no
  `VITE_API_BASE_URL` escape hatch on purpose: a cross-origin API would need CORS
  plus `SameSite=None` cookies, which PRD §17 rules out.
- **Field errors render next to their field.** `ApiError.fields` maps field name →
  message; pass it to `<Field error={...}>`, which wires `aria-invalid` and
  `aria-describedby`.
- **A failed submit keeps what the user typed** (PRD §16). Inputs are controlled,
  and mutations never reset form state on error.
- **Session state lives in one query** (`useCurrentUser`). A 401 resolves to
  `null` instead of throwing, so the guard can distinguish "signed out" from
  "request failed" — and it *does*: `RequireAuth` renders a retry affordance for a
  failed request and only redirects when the answer is genuinely `null`.
  Sign-out clears the whole query cache, then re-plants `me: null`.
- **A 401 from anywhere means the session is gone.** `createQueryClient()` records
  that once (query and mutation cache `onError` → `setQueryData(authKeys.me,
  null)`) and lets the guard redirect, so a session that expires mid-visit doesn't
  surface as a per-screen "could not reach the API". It is a factory rather than a
  module-level client so that rule is testable.
- **Colors and fonts come from theme tokens**, never literal hex values — see
  `src/index.css` and `DESIGN.md`. Inter and JetBrains Mono are self-hosted via
  `@fontsource-variable/*`; nothing is loaded from a CDN.

## Tests

`pnpm test` — Vitest in jsdom with Testing Library. No backend, no Docker: `fetch`
is stubbed per test with `stubFetch` from `src/test/utils.tsx`, which hands back
real `Response` objects so `api.ts` parses exactly what it parses in production.

- **Tests are named after the requirement they hold**, citing the REQ id from
  [`wiki-docs/specs/auth/spec.md`](../wiki-docs/specs/auth/spec.md). The client
  half of that spec — REQ-016/017/018/019/052/053 — is what this suite exists for.
- **Query behavior is asserted through the real `createQueryClient()`**, so the
  retry policy and the session-lost rule under test are the ones the app ships.
- **Assert on accessible queries** (`getByLabelText`, `getByRole`,
  `toHaveAccessibleDescription`). A test that can only find an element by class
  name or test id would pass while the form was unusable with a screen reader.
- The `clear()`-then-`setQueryData` order in `useLogout` and the hint-before-error
  order in `Field` are both load-bearing and both have a test whose comment says
  so — they look like style, and a later "simplification" would silently undo them.
