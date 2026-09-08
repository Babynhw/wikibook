import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Source, Space } from '@/lib/api';
import { SpacePage } from '@/routes/space-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const user = { id: 'u1', name: 'Test Person', email: 'test@example.test' };

const space = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
  name: 'Sleep and memory',
  objective: null,
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 2,
  noteCount: 0,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
  ...overrides,
});

const source = (overrides: Partial<Source> = {}): Source => ({
  id: 'src-1',
  spaceId: 'space-1',
  type: 'pdf',
  title: 'Sleep and memory consolidation',
  author: 'Walker',
  url: null,
  state: 'ready',
  errorMessage: null,
  archivedAt: null,
  createdAt: '2026-08-12T10:00:00.000Z',
  updatedAt: '2026-08-12T10:00:00.000Z',
  ...overrides,
});

/** Sources the stub answers with, keyed by the search that should find them. */
const CONSENT = source({ id: 'src-consent', title: 'Informed Consent Practices' });

function renderLibrary(
  respond: (url: URL) => Source[],
  { onCall }: { onCall?: (url: string) => void } = {},
) {
  stubFetch((path, init) => {
    onCall?.(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (path.includes('/open')) return jsonResponse({ space: space() });
    if (path.includes('/sources')) {
      const url = new URL(path, 'http://localhost');
      return jsonResponse({ sources: respond(url) });
    }
    return jsonResponse({ space: space() });
  });

  return renderWithProviders(
    <Routes>
      <Route path="/spaces/:id" element={<SpacePage />} />
    </Routes>,
    { routerProps: { initialEntries: ['/spaces/space-1'] } },
  );
}

describe('source search and filters', () => {
  it('debounces to one request per settled query and keeps the query in the URL', async () => {
    const calls: string[] = [];
    renderLibrary(
      (url) => (url.searchParams.get('q') === 'consent' ? [CONSENT] : [source()]),
      { onCall: (call) => calls.push(call) },
    );

    const input = await screen.findByRole('searchbox', { name: /search this space/i });
    await userEvent.type(input, 'consent');

    expect(await screen.findByText('Informed Consent Practices')).toBeInTheDocument();

    const searches = calls.filter((call) => call.includes('q=consent'));
    // One request for the settled query, not one per keystroke.
    expect(searches).toHaveLength(1);
    // No request was made for an intermediate prefix.
    expect(calls.some((call) => call.includes('q=cons&') || call.includes('q=cons '))).toBe(false);
  });

  it('keeps every keystroke typed while the URL is catching up', async () => {
    const calls: string[] = [];
    renderLibrary(() => [CONSENT], { onCall: (call) => calls.push(call) });

    const input = await screen.findByRole('searchbox', { name: /search this space/i });
    await userEvent.type(input, 'consent');
    // The settled query has reached the URL, and the URL now echoes back into this
    // hook. Adopting that echo unconditionally would reset the input to it and
    // discard anything typed since.
    await waitFor(() => expect(calls.some((call) => call.includes('q=consent'))).toBe(true));

    await userEvent.type(input, ' form');
    expect(input).toHaveValue('consent form');
    await waitFor(() =>
      expect(calls.some((call) => call.includes('q=consent+form'))).toBe(true),
    );
  });

  it('opens with a query already in the URL applied to both input and request', async () => {
    const calls: string[] = [];
    stubFetch((path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/open')) return jsonResponse({ space: space() });
      if (path.includes('/sources')) return jsonResponse({ sources: [CONSENT] });
      return jsonResponse({ space: space() });
    });
    renderWithProviders(
      <Routes>
        <Route path="/spaces/:id" element={<SpacePage />} />
      </Routes>,
      { routerProps: { initialEntries: ['/spaces/space-1?q=consent&type=pdf'] } },
    );

    // A filtered library survives a reload and a shared link, which is the reason
    // the state lives in the URL at all.
    expect(await screen.findByRole('searchbox', { name: /search this space/i })).toHaveValue(
      'consent',
    );
    expect(screen.getByRole('tab', { name: 'PDF' })).toHaveAttribute('aria-selected', 'true');
    expect(calls.some((call) => call.includes('q=consent') && call.includes('type=pdf'))).toBe(
      true,
    );
  });

  it('combines a type filter with the query, and both reach the API', async () => {
    const calls: string[] = [];
    renderLibrary(() => [CONSENT], { onCall: (call) => calls.push(call) });

    const input = await screen.findByRole('searchbox', { name: /search this space/i });
    await userEvent.type(input, 'consent');
    await waitFor(() => expect(calls.some((call) => call.includes('q=consent'))).toBe(true));

    await userEvent.click(screen.getByRole('tab', { name: 'PDF' }));

    await waitFor(() =>
      expect(
        calls.some((call) => call.includes('q=consent') && call.includes('type=pdf')),
      ).toBe(true),
    );
    // The query survives the filter click: §7 requires them to combine.
    expect(screen.getByRole('searchbox', { name: /search this space/i })).toHaveValue('consent');
    expect(screen.getByRole('tab', { name: 'PDF' })).toHaveAttribute('aria-selected', 'true');
  });

  it('asks for archived sources only when told to', async () => {
    const calls: string[] = [];
    renderLibrary((url) => (url.searchParams.get('archived') === 'only' ? [] : [source()]), {
      onCall: (call) => calls.push(call),
    });

    await screen.findByText('Sleep and memory consolidation');
    // The default view never asks for archived sources (PRD §7).
    expect(calls.some((call) => call.includes('archived='))).toBe(false);

    await userEvent.click(screen.getByRole('checkbox', { name: /show archived/i }));
    await waitFor(() =>
      expect(calls.some((call) => call.includes('archived=only'))).toBe(true),
    );
  });

  it('offers Clear search for a query and Clear filters when a filter is on', async () => {
    renderLibrary((url) => (url.searchParams.toString() === '' ? [source()] : []));

    const input = await screen.findByRole('searchbox', { name: /search this space/i });
    await userEvent.type(input, 'nothing matches this');

    // The no-results state is not the empty-library state: it names the query and
    // offers a way back, instead of inviting the user to add evidence they have.
    expect(await screen.findByText(/No sources in this space match/i)).toBeInTheDocument();
    expect(screen.queryByText(/No sources yet/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Sleep and memory consolidation')).toBeInTheDocument();

    // With a filter applied the action becomes Clear filters, because clearing
    // only the query would leave the user still looking at nothing.
    await userEvent.click(screen.getByRole('tab', { name: 'Web link' }));
    expect(await screen.findByText(/No sources match these filters/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Sleep and memory consolidation')).toBeInTheDocument();
  });

  it('announces the result count', async () => {
    renderLibrary(() => [source(), CONSENT]);
    const count = await screen.findByText(/2 sources/);
    expect(count).toHaveAttribute('aria-live', 'polite');
  });
});
