import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { MemoryRouter, type MemoryRouterProps } from 'react-router-dom';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';

/**
 * Test-only helpers. Deliberately not exported from anywhere the app imports.
 */

/** The real client, so tests exercise the app's retry and session-lost rules. */
export function testQueryClient(): QueryClient {
  return createQueryClient();
}

export function renderWithProviders(
  ui: ReactNode,
  {
    client = testQueryClient(),
    routerProps,
  }: { client?: QueryClient; routerProps?: MemoryRouterProps } = {},
): RenderResult & { client: QueryClient } {
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter {...routerProps}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

type FetchHandler = (path: string, init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Replaces `fetch` for the duration of a test. `path` is what `api.ts` built —
 * `/api/auth/me` — so a handler can switch on the endpoint the SPA actually
 * calls. Restored automatically by `unstubGlobals` in vitest.config.ts.
 */
export function stubFetch(handler: FetchHandler) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
