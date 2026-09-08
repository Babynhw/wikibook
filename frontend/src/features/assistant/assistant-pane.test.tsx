import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/utils';
import type { Conversation, ConversationMessage } from '@/lib/api';
import { AssistantPane } from './assistant-pane';
import { renderWithMarkers } from './answer-message';
import { CitationMarker } from './citation-marker';

const conversation: Conversation = {
  id: 'c1',
  spaceId: 's1',
  title: 'Withdrawal pressure',
  scopeType: 'space',
  scopeSourceId: null,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
};

const answer: ConversationMessage = {
  id: 'm2',
  role: 'assistant',
  content: 'Withdrawal felt costly [1], though not everywhere [2].',
  feedback: null,
  grounded: true,
  passagesSent: 12,
  sourcesUsed: [{ id: 'src1', title: 'Consent Practices' }],
  citations: [
    {
      id: 'cit1',
      index: 1,
      sourceId: 'src1',
      sourceTitle: 'Consent Practices',
      quotedText: 'socially costly',
      reference: 'Page 7',
      stale: false,
    },
    {
      id: 'cit2',
      index: 2,
      sourceId: 'src2',
      sourceTitle: 'Site B Report',
      quotedText: 'no such pressure',
      reference: 'Page 3',
      stale: false,
    },
  ],
  savedNoteId: null,
  createdAt: '2026-08-12T00:00:01.000Z',
};

/** An SSE response body delivering these blocks. */
function sseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Like `sseResponse`, but the stream never closes — an answer still in flight. */
function openSseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      // No close(): the connection is still open, as it is mid-answer.
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Routes the calls the pane makes. `messages` is what `GET /conversations/:id`
 * answers, and `stream` is the ask response.
 */
function stubApi(options: {
  messages?: ConversationMessage[];
  stream?: Response | (() => Response);
  askStatus?: number;
  askError?: string;
}) {
  const asks: string[] = [];
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/conversations/c1/messages')) {
      asks.push(String(init?.body ?? ''));
      if (options.askStatus) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'space_archived', message: options.askError ?? 'No.' } }, options.askStatus),
        );
      }
      const stream = typeof options.stream === 'function' ? options.stream() : options.stream;
      return Promise.resolve(stream ?? sseResponse([]));
    }
    if (path.includes('/conversations/c1')) {
      return Promise.resolve(jsonResponse({ conversation, messages: options.messages ?? [] }));
    }
    if (path.includes('/sources')) return Promise.resolve(jsonResponse({ sources: [] }));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', spy);
  return { spy, asks };
}

describe('assistant pane', () => {
  it('renders a stored answer with a marker beside each claim', async () => {
    stubApi({ messages: [answer] });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    await screen.findByText(/Withdrawal felt costly/);
    // Markers are controls, not decoration, and their names say where they go.
    expect(
      screen.getByRole('button', { name: 'Citation 1: Consent Practices, Page 7' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Citation 2: Site B Report, Page 3' }),
    ).toBeInTheDocument();
    // §9 requires the answer to identify the sources it used.
    expect(screen.getByText(/Nguồn đã dùng:/)).toBeInTheDocument();
  });

  it('streams deltas in order while the answer is still arriving', async () => {
    // The stream stays *open*: once it closes, the stored thread becomes the
    // source of truth and the streamed copy is dropped. This test is about the
    // in-flight rendering; the handoff is the next test.
    stubApi({ stream: openSseResponse([
      'data: {"type":"user_message","id":"m1","createdAt":"2026-08-12T00:00:00.000Z"}\n\n',
      'data: {"type":"thinking","text":"Looking at three excerpts"}\n\n',
      'data: {"type":"delta","text":"Participants "}\n\n',
      'data: {"type":"delta","text":"felt pressure."}\n\n',
    ]) });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'Did they feel pressure?');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    // Deltas concatenate in arrival order, not as separate paragraphs.
    await waitFor(() => {
      expect(screen.getByText('Participants felt pressure.')).toBeInTheDocument();
    });
  });

  it('shows a labelled Thinking state while only reasoning has arrived', async () => {
    stubApi({ stream: openSseResponse([
      'data: {"type":"user_message","id":"m1","createdAt":"2026-08-12T00:00:00.000Z"}\n\n',
      'data: {"type":"thinking","text":"Weighing excerpt 0 against excerpt 1"}\n\n',
    ]) });
    const { container } = renderWithProviders(
      <AssistantPane conversation={conversation} spaceId="s1" />,
    );

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'Did they feel pressure?');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    // Twenty seconds of "Searching your sources…" on a model that started
    // immediately is what this replaces.
    await waitFor(() => expect(screen.getByText('Đang suy nghĩ…')).toBeInTheDocument());
    expect(screen.queryByText('Đang tìm trong nguồn tài liệu…')).not.toBeInTheDocument();
    expect(screen.getByText(/Weighing excerpt 0/)).toBeInTheDocument();

    // A state, not the reasoning: a 337-chunk reasoning run would otherwise
    // mutate the live region 337 times (REQ-187).
    const live = container.querySelector('[aria-live="polite"]');
    expect(live!.textContent).toBe('Đang suy nghĩ');
  });

  it('replaces the Thinking state with the answer once text arrives', async () => {
    stubApi({ stream: openSseResponse([
      'data: {"type":"user_message","id":"m1","createdAt":"2026-08-12T00:00:00.000Z"}\n\n',
      'data: {"type":"thinking","text":"Weighing excerpt 0 against excerpt 1"}\n\n',
      'data: {"type":"delta","text":"Participants felt pressure."}\n\n',
    ]) });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'Did they feel pressure?');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    await waitFor(() => {
      expect(screen.getByText('Participants felt pressure.')).toBeInTheDocument();
    });
    // Transient by construction — the reasoning is progress, not product, and
    // nothing persists it.
    expect(screen.queryByText('Đang suy nghĩ…')).not.toBeInTheDocument();
    expect(screen.queryByText(/Weighing excerpt 0/)).not.toBeInTheDocument();
  });

  it('releases the composer on done, before the stream closes', async () => {
    let stored: ConversationMessage[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/conversations/c1/messages')) {
          stored = [answer];
          // Deliberately still open after `done`: the server keeps the stream
          // open to generate the conversation title, a second provider call that
          // can outlast the answer.
          return Promise.resolve(
            openSseResponse([
              'data: {"type":"delta","text":"Withdrawal felt costly [1], though not everywhere [2]."}\n\n',
              'data: {"type":"done","messageId":"m2","grounded":true,"truncated":false}\n\n',
            ]),
          );
        }
        if (path.includes('/conversations/c1')) {
          return Promise.resolve(jsonResponse({ conversation, messages: stored }));
        }
        return Promise.resolve(jsonResponse({ sources: [] }));
      }),
    );
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'Did they feel pressure?');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    // Settling only when the stream *closed* left a finished answer on screen
    // with Ask disabled for as long as titling took — the client half of
    // REQ-232, and the reason moving `done` earlier on the server did nothing
    // on its own.
    await waitFor(() => expect(screen.getByText(/Nguồn đã dùng:/)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Câu hỏi của bạn'), 'next question');
    expect(screen.getByRole('button', { name: 'Hỏi' })).toBeEnabled();
  });

  it('does not offer "Save as note" on the streaming, synthetic answer', async () => {
    stubApi({
      stream: openSseResponse([
        'data: {"type":"delta","text":"Participants felt pressure."}\n\n',
      ]),
    });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'Did they feel pressure?');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    await waitFor(() => {
      expect(screen.getByText('Participants felt pressure.')).toBeInTheDocument();
    });

    // The in-flight answer is synthetic (`pending-answer`): it has no persisted
    // message id, so "Save as note" would call a route that cannot exist. The
    // stored answer — covered by "saves an assistant answer as a note" — gets
    // the button; the streamed copy does not.
    expect(screen.queryByRole('button', { name: /lưu thành ghi chú/i })).not.toBeInTheDocument();
  });

  it('hands off to the stored thread once the answer completes', async () => {
    let stored: ConversationMessage[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/conversations/c1/messages')) {
          // The server has persisted the answer by the time it sends `done`.
          stored = [answer];
          return Promise.resolve(
            sseResponse([
              'data: {"type":"delta","text":"Withdrawal felt costly [1], though not everywhere [2]."}\n\n',
              'data: {"type":"done","messageId":"m2","grounded":true,"truncated":false}\n\n',
            ]),
          );
        }
        if (path.includes('/conversations/c1')) {
          return Promise.resolve(jsonResponse({ conversation, messages: stored }));
        }
        return Promise.resolve(jsonResponse({ sources: [] }));
      }),
    );
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'Did they feel pressure?');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    // The stored answer carries real citation ids, so the markers become usable
    // controls — which the streamed copy's markers only are once ids exist.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Citation 1: Consent Practices, Page 7' }),
      ).toBeEnabled();
    });
    expect(screen.getByText(/Nguồn đã dùng:/)).toBeInTheDocument();
  });

  it('keeps the question and offers Retry when the answer fails', async () => {
    const { asks } = stubApi({
      stream: sseResponse([
        'data: {"type":"error","message":"We could not get an answer just now. Your question is still here — try again."}\n\n',
      ]),
    });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'A question that fails');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    const retry = await screen.findByRole('button', { name: 'Thử lại' });
    expect(screen.getByText(/still here/)).toBeInTheDocument();

    // Retry re-sends the same question — there is no partial answer to restore,
    // and the server persisted none either.
    await userEvent.click(retry);
    await waitFor(() => expect(asks).toHaveLength(2));
    expect(asks[1]).toContain('A question that fails');
  });

  it('shows a §16 refusal message from a non-streaming failure', async () => {
    stubApi({ askStatus: 409, askError: 'This space is archived. Restore it to make changes.' });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const box = await screen.findByLabelText('Câu hỏi của bạn');
    await userEvent.type(box, 'Anything?');
    await userEvent.click(screen.getByRole('button', { name: 'Hỏi' }));

    expect(await screen.findByText(/This space is archived/)).toBeInTheDocument();
  });

  it('renders an ungrounded answer as an insufficiency answer, with no markers', async () => {
    stubApi({
      messages: [
        {
          ...answer,
          id: 'm3',
          content: 'None of the sources in this space matched that question.',
          grounded: false,
          citations: [],
          sourcesUsed: [],
          passagesSent: 12,
        },
      ],
    });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    await screen.findByText(/None of the sources/);
    // Says what happened rather than claiming the evidence was weak: an answer
    // citing none of twelve excerpts can equally mean the citation channel broke,
    // which is exactly how one real misconfiguration went unexplained.
    expect(screen.getByText(/Đã tìm trong 12 đoạn trích/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Citation/ })).not.toBeInTheDocument();
  });

  it('announces status rather than tokens', async () => {
    stubApi({ messages: [answer] });
    const { container } = renderWithProviders(
      <AssistantPane conversation={conversation} spaceId="s1" />,
    );
    await screen.findByText(/Withdrawal felt costly/);

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    // A token-by-token live region reads one sentence to a screen reader eight
    // times; §18 wants the state change announced, not the content re-read.
    expect(live!.textContent).not.toContain('Withdrawal felt costly');
  });

  it('asks a question handed over in router state exactly once, then clears it', async () => {
    // The hub creates the conversation and navigates here with the question; the
    // pane asks it on mount. Re-renders and a Back/refresh must not re-ask.
    // The stream stays open so the question is still the pending one on screen.
    const { asks } = stubApi({ stream: openSseResponse([
      'data: {"type":"user_message","id":"m1","createdAt":"2026-08-12T00:00:00.000Z"}\n\n',
      'data: {"type":"delta","text":"An answer."}\n\n',
    ]) });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />, {
      routerProps: {
        initialEntries: [
          { pathname: '/spaces/s1/assistant/c1', state: { initialQuestion: 'Why the pressure?' } },
        ],
      },
    });

    await waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0]).toContain('Why the pressure?');
    expect(await screen.findByText('Why the pressure?')).toBeInTheDocument();

    // `ask` changes identity as the status moves, so the effect re-runs; the
    // ref is what keeps this at one.
    await screen.findByText(/An answer\./);
    expect(asks).toHaveLength(1);
    // Nothing on screen still names it as the initial question; the pane's own
    // composer is empty, ready for a follow-up.
    expect(screen.getByLabelText('Câu hỏi của bạn')).toHaveValue('');
  });

  it('drops a handed-over question without asking it when the space is read-only', async () => {
    const { asks } = stubApi({ messages: [answer] });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" readOnly />, {
      routerProps: {
        initialEntries: [
          { pathname: '/spaces/s1/assistant/c1', state: { initialQuestion: 'Why the pressure?' } },
        ],
      },
    });

    await screen.findByText(/Withdrawal felt costly/);
    expect(asks).toHaveLength(0);
    expect(screen.queryByText('Why the pressure?')).not.toBeInTheDocument();
  });

  it('disables asking in an archived space but keeps the thread readable', async () => {
    stubApi({ messages: [answer] });
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" readOnly />);

    await screen.findByText(/Withdrawal felt costly/);
    expect(screen.queryByLabelText('Câu hỏi của bạn')).not.toBeInTheDocument();
    expect(screen.getByText(/Hãy khôi phục để đặt câu hỏi mới/)).toBeInTheDocument();
  });

  it('records feedback on an answer', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes('/feedback')) {
          calls.push(String(init?.body ?? ''));
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        if (path.includes('/conversations/c1')) {
          return Promise.resolve(jsonResponse({ conversation, messages: [answer] }));
        }
        return Promise.resolve(jsonResponse({ sources: [] }));
      }),
    );
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Hữu ích' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toContain('useful');
  });

  it('saves an assistant answer as a note and marks button saved', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/messages/m2/save-as-note')) {
          calls.push(path);
          return Promise.resolve(
            jsonResponse(
              {
                note: {
                  id: 'n1',
                  spaceId: 's1',
                  title: 'Saved answer',
                  contentRich: {},
                  originType: 'saved_answer',
                  originConversationId: 'c1',
                  originMessageId: 'm2',
                  citationCount: 2,
                  citations: [],
                  convertedSource: null,
                  createdAt: '2026-08-12T00:00:02.000Z',
                  updatedAt: '2026-08-12T00:00:02.000Z',
                },
              },
              201,
            ),
          );
        }
        if (path.includes('/conversations/c1')) {
          return Promise.resolve(jsonResponse({ conversation, messages: [answer] }));
        }
        return Promise.resolve(jsonResponse({ sources: [] }));
      }),
    );
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    const saveBtn = await screen.findByRole('button', { name: /lưu thành ghi chú/i });
    await userEvent.click(saveBtn);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(await screen.findByText('Đã lưu vào ghi chú')).toBeInTheDocument();
  });

  it('surfaces a save failure as an error message instead of swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/messages/m2/save-as-note')) {
          return Promise.resolve(
            jsonResponse(
              { error: { code: 'space_archived', message: 'This space is archived.' } },
              409,
            ),
          );
        }
        if (path.includes('/conversations/c1')) {
          return Promise.resolve(jsonResponse({ conversation, messages: [answer] }));
        }
        return Promise.resolve(jsonResponse({ sources: [] }));
      }),
    );
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    await userEvent.click(await screen.findByRole('button', { name: /lưu thành ghi chú/i }));

    // A real failure (archived space, rate limit, network) must reach the user,
    // and the button must not claim the answer was saved.
    expect(await screen.findByText('This space is archived.')).toBeInTheDocument();
    expect(screen.queryByText('Đã lưu vào ghi chú')).not.toBeInTheDocument();
  });

  it('re-reads the thread rather than erroring when the answer was already saved', async () => {
    let saveAttempts = 0;
    let conversationReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/messages/m2/save-as-note')) {
          saveAttempts += 1;
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: 'note_already_saved',
                  message: 'This answer has already been saved as a note.',
                },
              },
              409,
            ),
          );
        }
        if (path.includes('/conversations/c1')) {
          conversationReads += 1;
          // The server is the authority on the saved state: the refetch is what
          // supplies the real note id, rather than the client inventing one.
          const messages =
            conversationReads > 1 ? [{ ...answer, savedNoteId: 'n-existing' }] : [answer];
          return Promise.resolve(jsonResponse({ conversation, messages }));
        }
        return Promise.resolve(jsonResponse({ sources: [] }));
      }),
    );
    renderWithProviders(<AssistantPane conversation={conversation} spaceId="s1" />);

    await userEvent.click(await screen.findByRole('button', { name: /lưu thành ghi chú/i }));

    await waitFor(() => expect(saveAttempts).toBe(1));
    // Not an error: the answer *is* a note, so the thread is invalidated and the
    // button settles into its saved state from server truth.
    expect(await screen.findByText('Đã lưu vào ghi chú')).toBeInTheDocument();
    expect(
      screen.queryByText('This answer has already been saved as a note.'),
    ).not.toBeInTheDocument();
  });
});

describe('citation markers', () => {
  it('leaves a marker that names no citation as plain text', () => {
    const parts = renderWithMarkers('A claim [1] and a stray [9].', answer.citations.slice(0, 1), () => (
      <span data-testid="marker" />
    ));
    // `[9]` resolves to nothing; inventing a target for it is the thing this
    // phase exists to prevent.
    expect(parts.filter((part) => typeof part === 'string').join('')).toContain('[9]');
  });

  it('resolves through the citation target route rather than building a reader URL', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        requested.push(String(input));
        return Promise.resolve(
          jsonResponse({
            target: {
              sourceId: 'src1',
              spaceId: 's1',
              passageId: 'p1',
              startBlockOrd: 3,
              endBlockOrd: 3,
              page: 7,
              paragraphRef: null,
              sectionHeading: null,
              stale: false,
            },
          }),
        );
      }),
    );

    renderWithProviders(
      <CitationMarker
        citation={answer.citations[0]!}
        spaceId="s1"
        returnTo="/spaces/s1/assistant/c1"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^Citation 1/ }));
    await waitFor(() => expect(requested.some((url) => url.includes('/citations/cit1/target'))).toBe(true));
  });

  it('still resolves on a second click', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        requested.push(String(input));
        return Promise.resolve(
          jsonResponse({
            target: {
              sourceId: 'src1', spaceId: 's1', passageId: 'p1',
              startBlockOrd: 3, endBlockOrd: 3, page: 7,
              paragraphRef: null, sectionHeading: null, stale: false,
            },
          }),
        );
      }),
    );
    const onOpenInPane = vi.fn();
    renderWithProviders(
      <CitationMarker
        citation={answer.citations[0]!}
        spaceId="s1"
        returnTo="/spaces/s1/assistant/c1"
        onOpenInPane={onOpenInPane}
      />,
    );

    const marker = screen.getByRole('button', { name: /^Citation 1/ });
    await userEvent.click(marker);
    await waitFor(() => expect(onOpenInPane).toHaveBeenCalledTimes(1));
    // A `busy` flag left set on the success path made the marker inert after one
    // click — close the reader pane, click again, nothing happened.
    await userEvent.click(marker);
    await waitFor(() => expect(onOpenInPane).toHaveBeenCalledTimes(2));
  });

  it('is disabled when the citation has no id yet', () => {
    renderWithProviders(
      <CitationMarker
        citation={{ ...answer.citations[0]!, id: '' }}
        spaceId="s1"
        returnTo="/spaces/s1/assistant/c1"
      />,
    );
    expect(screen.getByRole('button', { name: /^Citation 1/ })).toBeDisabled();
  });
});
