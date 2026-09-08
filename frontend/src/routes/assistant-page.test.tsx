import { describe, expect, it } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationListItem, Source, Space } from '@/lib/api';
import { AssistantPage } from '@/routes/assistant-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const space = (overrides: Partial<Space> = {}): Space => ({
  id: 's1',
  name: 'Sleep and memory',
  objective: 'How does sleep consolidate memory?',
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 0,
  noteCount: 0,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
  ...overrides,
});

const user = { id: 'u1', name: 'Test Person', email: 'test@example.test' };

const conversations: ConversationListItem[] = [
  {
    id: 'c-new',
    spaceId: 's1',
    title: 'Sleep and recall',
    scopeType: 'space',
    scopeSourceId: null,
    preview: 'What happens to recall after a short night?',
    messageCount: 2,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
  },
  {
    id: 'c-old',
    spaceId: 's1',
    title: 'Consolidation stages',
    scopeType: 'space',
    scopeSourceId: null,
    preview: 'Which stage matters most?',
    messageCount: 6,
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:00:00.000Z',
  },
];

const readySource: Source = {
  id: 'src1',
  spaceId: 's1',
  type: 'web',
  title: 'Sleep Review 2024',
  author: null,
  url: 'https://example.test/sleep',
  state: 'ready',
  errorMessage: null,
  archivedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}|{JSON.stringify(location.state)}
    </output>
  );
}

function renderAssistant(
  handler: Parameters<typeof stubFetch>[0],
  initialEntry = '/spaces/s1/assistant',
) {
  const spy = stubFetch(handler);
  const result = renderWithProviders(
    <>
      <Routes>
        <Route path="/spaces/:spaceId/assistant" element={<AssistantPage />} />
        <Route path="/spaces/:spaceId/assistant/:conversationId" element={<AssistantPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { routerProps: { initialEntries: [initialEntry] } },
  );
  return { ...result, spy };
}

function baseHandler(
  options: { space?: Space; list?: ConversationListItem[]; sources?: Source[] } = {},
) {
  return (path: string, init: RequestInit | undefined): Response => {
    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (path.endsWith('/spaces/s1/conversations') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ conversations: options.list ?? conversations });
    }
    if (path.includes('/sources')) return jsonResponse({ sources: options.sources ?? [] });
    if (path.endsWith('/spaces/s1')) return jsonResponse({ space: options.space ?? space() });
    return jsonResponse({});
  };
}

describe('AssistantPage hub', () => {
  /** REQ-170 — the bare route lists every conversation; it no longer jumps to the newest. */
  it('lists the conversations most recent first and stays on the hub', async () => {
    renderAssistant(baseHandler());

    const nav = await screen.findByRole('navigation', { name: 'Chats' });
    const links = nav.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent('Sleep and recall');
    expect(links[0]).toHaveTextContent('What happens to recall after a short night?');
    expect(links[1]).toHaveTextContent('Consolidation stages');

    expect(screen.getByLabelText('Your question')).toHaveAttribute(
      'placeholder',
      'Ask a question in Sleep and memory…',
    );
    // Not redirected.
    expect(screen.getByTestId('location')).toHaveTextContent('/spaces/s1/assistant|');
  });

  /** A chat starts with its question: one create, then the thread with the question in flight. */
  it('creates a conversation on submit and carries the question to the thread', async () => {
    const calls: string[] = [];
    renderAssistant((path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/spaces/s1/conversations') && init?.method === 'POST') {
        return jsonResponse(
          {
            conversation: {
              id: 'c-created',
              spaceId: 's1',
              title: 'New conversation',
              scopeType: 'space',
              scopeSourceId: null,
              createdAt: '2026-08-27T10:00:00.000Z',
              updatedAt: '2026-08-27T10:00:00.000Z',
            },
          },
          201,
        );
      }
      if (path.includes('/conversations/c-created/messages')) {
        // The stream never closes in this test; the question being in flight is
        // what is asserted.
        return new Response(new ReadableStream(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (path.endsWith('/conversations/c-created')) {
        return jsonResponse({
          conversation: {
            id: 'c-created',
            spaceId: 's1',
            title: 'New conversation',
            scopeType: 'space',
            scopeSourceId: null,
            createdAt: '2026-08-27T10:00:00.000Z',
            updatedAt: '2026-08-27T10:00:00.000Z',
          },
          messages: [],
        });
      }
      return baseHandler()(path, init);
    });

    await userEvent.type(await screen.findByLabelText('Your question'), 'Does a nap help recall?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/spaces/s1/assistant/c-created|'),
    );
    expect(calls.filter((call) => call === 'POST /api/spaces/s1/conversations')).toHaveLength(1);
    // The question is in flight on the thread, and the state it rode in on is gone.
    await waitFor(() =>
      expect(calls.some((call) => call.endsWith('/conversations/c-created/messages'))).toBe(true),
    );
    expect(await screen.findByText('Does a nap help recall?')).toBeInTheDocument();
    // The `replace` that drops the state lands a tick after the ask starts.
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/spaces/s1/assistant/c-created|null'),
    );
    expect(screen.getByRole('link', { name: '← Chats' })).toHaveAttribute('href', '/spaces/s1/assistant');
  });

  /** REQ-171 / REQ-239 — the first question is asked with the scope chosen on the hub. */
  it('creates the conversation with the source scope chosen in the composer', async () => {
    const bodies: string[] = [];
    renderAssistant((path, init) => {
      if (path.endsWith('/spaces/s1/conversations') && init?.method === 'POST') {
        bodies.push(String(init.body));
        return jsonResponse(
          {
            conversation: {
              id: 'c-scoped',
              spaceId: 's1',
              title: 'New conversation',
              scopeType: 'source',
              scopeSourceId: 'src1',
              createdAt: '2026-08-27T10:00:00.000Z',
              updatedAt: '2026-08-27T10:00:00.000Z',
            },
          },
          201,
        );
      }
      if (path.includes('/conversations/c-scoped')) {
        return new Response(new ReadableStream(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return baseHandler({ sources: [readySource] })(path, init);
    });

    const scope = await screen.findByLabelText('Asking about');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Only “Sleep Review 2024”' })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(scope, 'src1');
    const field = screen.getByLabelText('Your question');
    expect(field).toHaveAttribute('placeholder', 'Ask a question about “Sleep Review 2024”…');

    await userEvent.type(field, 'What does this review say about naps?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0]!)).toEqual({ scopeType: 'source', scopeSourceId: 'src1' });
  });

  /** PRD §16 — a failed create keeps the draft and says why beside the field. */
  it('keeps the question and shows the error when the conversation cannot be created', async () => {
    renderAssistant((path, init) => {
      if (path.endsWith('/spaces/s1/conversations') && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } }, 429);
      }
      return baseHandler()(path, init);
    });

    const field = await screen.findByLabelText('Your question');
    await userEvent.type(field, 'Does a nap help recall?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(field).toHaveValue('Does a nap help recall?');
    expect(screen.getByTestId('location')).toHaveTextContent('/spaces/s1/assistant|');
  });

  /** §16 — the composer waits for the space, so a draft is never lost to the archived swap. */
  it('offers no composer until the space is known', async () => {
    let releaseSpace: (() => void) | undefined;
    const spaceGate = new Promise<void>((resolve) => {
      releaseSpace = resolve;
    });
    renderAssistant(async (path, init) => {
      if (path.endsWith('/spaces/s1')) {
        await spaceGate;
        return jsonResponse({ space: space({ archivedAt: '2026-08-15T00:00:00.000Z' }) });
      }
      return baseHandler()(path, init);
    });

    await screen.findByRole('navigation', { name: 'Chats' });
    expect(screen.getByTestId('composer-loading')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();

    releaseSpace!();
    expect(await screen.findByText(/This space is archived/)).toBeInTheDocument();
    expect(screen.queryByTestId('composer-loading')).not.toBeInTheDocument();
  });

  /** REQ-175 — a scope the server refuses keeps both the draft and the chosen scope. */
  it('keeps the draft and the chosen scope when the server refuses the source scope', async () => {
    renderAssistant((path, init) => {
      if (path.endsWith('/spaces/s1/conversations') && init?.method === 'POST') {
        return jsonResponse(
          { error: { code: 'source_not_retrievable', message: 'This source cannot be asked about right now.' } },
          409,
        );
      }
      return baseHandler({ sources: [readySource] })(path, init);
    });

    const scope = await screen.findByLabelText('Asking about');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Only “Sleep Review 2024”' })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(scope, 'src1');
    const field = screen.getByLabelText('Your question');
    await userEvent.type(field, 'What about naps?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be asked about');
    expect(field).toHaveValue('What about naps?');
    expect(scope).toHaveValue('src1');
    expect(screen.getByTestId('location')).toHaveTextContent('/spaces/s1/assistant|');
  });

  /** REQ-174 — archived: reading stays, asking goes. */
  it('hides the composer in an archived space but still lists the chats', async () => {
    renderAssistant(baseHandler({ space: space({ archivedAt: '2026-08-15T00:00:00.000Z' }) }));

    await screen.findByRole('navigation', { name: 'Chats' });
    expect(await screen.findByText(/This space is archived/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();
  });

  it('says so instead of pointing at a composer when an archived space has no chats', async () => {
    renderAssistant(baseHandler({ space: space({ archivedAt: '2026-08-15T00:00:00.000Z' }), list: [] }));
    expect(await screen.findByRole('heading', { name: 'No conversations yet' })).toBeInTheDocument();
    expect(screen.queryByText(/Ask a question above/)).not.toBeInTheDocument();
  });
});
