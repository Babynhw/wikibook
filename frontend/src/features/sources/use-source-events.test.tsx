import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import type { Source, Space } from '@/lib/api';
import { SpacePage } from '@/routes/space-page';
import { resetStreamFallback } from '@/features/sources/use-source-events';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

/**
 * A hand-written `EventSource`: jsdom has none, and the point of these tests is
 * to drive open / message / error from the outside, which the real one hides.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.(new Event('open'));
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  fail() {
    this.onerror?.(new Event('error'));
  }

  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!last) throw new Error('no EventSource was opened');
    return last;
  }
}

const space: Space = {
  id: 'space-1',
  name: 'Sleep and memory',
  objective: null,
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 1,
  noteCount: 0,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
};

const source = (overrides: Partial<Source> = {}): Source => ({
  id: 'src-1',
  spaceId: 'space-1',
  type: 'pdf',
  title: 'Sleep and memory consolidation',
  author: null,
  url: null,
  state: 'processing',
  errorMessage: null,
  archivedAt: null,
  createdAt: '2026-08-12T10:00:00.000Z',
  updatedAt: '2026-08-12T10:00:00.000Z',
  ...overrides,
});

/** Renders the space with a mutable source library and counts list fetches. */
function renderSpace(sources: Source[] = [source()]) {
  const listFetches = { count: 0 };
  stubFetch((path, init) => {
    if (path.endsWith('/auth/me')) {
      return jsonResponse({ user: { id: 'u1', name: 'Test Person', email: 't@example.test' } });
    }
    if (path.endsWith('/sources') && (init?.method ?? 'GET') === 'GET') {
      listFetches.count += 1;
      return jsonResponse({ sources });
    }
    return jsonResponse({ space });
  });

  const rendered = renderWithProviders(
    <Routes>
      <Route path="/spaces/:id" element={<SpacePage />} />
    </Routes>,
    { routerProps: { initialEntries: ['/spaces/space-1'] } },
  );
  return { ...rendered, listFetches };
}

describe('useSourceEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    resetStreamFallback();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** REQ — one stream per open space, with the session cookie attached. */
  it('opens one credentialed stream for the space on mount', async () => {
    renderSpace();

    expect(await screen.findByText('Sleep and memory consolidation')).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest.url).toBe('/api/spaces/space-1/events');
    expect(FakeEventSource.latest.init?.withCredentials).toBe(true);
  });

  /** REQ — an event patches the cached source; no list refetch per transition. */
  it('moves a card from processing to ready and announces it', async () => {
    const { listFetches } = renderSpace();

    expect(await screen.findByText('Processing')).toBeInTheDocument();
    const afterFirstLoad = listFetches.count;

    FakeEventSource.latest.emit({ sourceId: 'src-1', state: 'ready' });

    await waitFor(() => expect(screen.queryByText('Processing')).not.toBeInTheDocument());
    // §18: the change is announced politely, not left to be noticed.
    expect(await screen.findByText('Sleep and memory consolidation is ready to use.')).toBeInTheDocument();
    // Patched from the payload — the event cost no extra request.
    expect(listFetches.count).toBe(afterFirstLoad);
  });

  /** REQ — a failure event carries its message and the Retry action with it. */
  it('moves a card to failed with the reason from the event', async () => {
    renderSpace();

    expect(await screen.findByText('Processing')).toBeInTheDocument();
    FakeEventSource.latest.emit({
      sourceId: 'src-1',
      state: 'failed',
      errorMessage: 'This PDF is password protected.',
    });

    expect(await screen.findByText('This PDF is password protected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  /** REQ — the stream has no replay, so every (re)connect refetches the list. */
  it('refetches the list on connect and on every reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { listFetches } = renderSpace();

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.latest.open();
    await vi.waitFor(() => expect(listFetches.count).toBeGreaterThanOrEqual(2));
    const afterConnect = listFetches.count;

    // A stream that opened and then dropped reconnects rather than falling back.
    FakeEventSource.latest.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    FakeEventSource.latest.open();
    await vi.waitFor(() => expect(listFetches.count).toBeGreaterThan(afterConnect));
  });

  /** REQ — two failed opens drop the feature to a 5 s poll for the session. */
  it('falls back to polling after two failed opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { listFetches } = renderSpace();

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.latest.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    FakeEventSource.latest.fail();

    // The library says so rather than looking live while it is not (§16).
    expect(await screen.findByText(/Live updates are unavailable/i)).toBeInTheDocument();
    // No third attempt: the stream is given up on for the session.
    expect(FakeEventSource.instances).toHaveLength(2);

    const beforePoll = listFetches.count;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(listFetches.count).toBeGreaterThan(beforePoll));
  });

  /** REQ — a source added elsewhere is not knowable from the payload alone. */
  it('refetches when an event names a source this client has not seen', async () => {
    const { listFetches } = renderSpace();

    expect(await screen.findByText('Processing')).toBeInTheDocument();
    const before = listFetches.count;

    FakeEventSource.latest.emit({ sourceId: 'src-elsewhere', state: 'ready' });

    await waitFor(() => expect(listFetches.count).toBeGreaterThan(before));
  });

  /** REQ — without EventSource at all, the library still resolves (§16). */
  it('polls when the environment has no EventSource', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('EventSource', undefined);
    const { listFetches } = renderSpace();

    expect(await screen.findByText(/Live updates are unavailable/i)).toBeInTheDocument();
    const before = listFetches.count;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(listFetches.count).toBeGreaterThan(before));
  });
});
