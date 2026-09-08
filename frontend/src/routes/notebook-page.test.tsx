import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Note, Notebook, Source, Space } from '@/lib/api';
import { NotebookPage } from '@/routes/notebook-page';
import { NotebookPrintPage } from '@/routes/notebook-print-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const space: Space = {
  id: 'space-1',
  name: 'Sleep and Memory',
  objective: 'Why naps help',
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 1,
  noteCount: 1,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
};
const user = { id: 'u1', name: 'R', email: 'r@example.test' };

const source: Source = {
  id: 'src-1',
  spaceId: 'space-1',
  type: 'pdf',
  title: 'Synaptic Homeostasis',
  author: 'Tononi',
  url: null,
  state: 'ready',
  errorMessage: null,
  archivedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

const note: Note = {
  id: 'note-1',
  spaceId: 'space-1',
  title: 'Slow-wave sleep and plasticity',
  contentRich: {
    type: 'doc',
    question: 'How does SWS affect plasticity?',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SWS downscales synaptic weights.' }] }],
  },
  originType: 'saved_answer',
  originConversationId: 'conv-1',
  originMessageId: 'msg-1',
  citationCount: 2,
  citations: [
    {
      id: 'cite-1',
      sourceId: 'src-1',
      sourceTitle: 'Synaptic Homeostasis',
      quotedText: 'downscales synaptic weights',
      page: 12,
      paragraphRef: null,
      sectionHeading: null,
      stale: false,
      createdAt: '2026-08-01T11:00:00.000Z',
    },
    {
      id: 'cite-2',
      sourceId: 'src-gone',
      sourceTitle: 'A deleted source',
      quotedText: 'gone',
      page: null,
      paragraphRef: 'p3',
      sectionHeading: null,
      stale: true,
      createdAt: '2026-08-01T11:00:00.000Z',
    },
  ],
  convertedSource: null,
  createdAt: '2026-08-01T11:00:00.000Z',
  updatedAt: '2026-08-01T11:00:00.000Z',
};

const notebook: Notebook = {
  id: 'nb-1',
  spaceId: 'space-1',
  contentRich: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Draft title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Opening paragraph.' }] },
    ],
  },
  createdAt: '2026-08-27T09:00:00.000Z',
  updatedAt: '2026-08-27T09:00:00.000Z',
};

function stubApi(
  overrides: { space?: Space; notebook?: Notebook; puts?: unknown[]; presence?: { id: string; name: string }[] } = {},
) {
  const puts = overrides.puts ?? [];
  stubFetch((path, init) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/spaces/space-1/notebook/presence') {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse({ users: [...(overrides.presence ?? []), ...(init?.method === 'POST' ? [user] : [])] });
    }
    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (url.pathname === '/api/spaces/space-1') return jsonResponse({ space: overrides.space ?? space });
    if (url.pathname === '/api/spaces/space-1/notebook') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return jsonResponse({ notebook: { ...(overrides.notebook ?? notebook), contentRich: body.contentRich, updatedAt: '2026-08-27T09:30:00.000Z' } });
      }
      return jsonResponse({ notebook: overrides.notebook ?? notebook });
    }
    if (url.pathname === '/api/spaces/space-1/notes') return jsonResponse({ notes: [note] });
    if (url.pathname === '/api/notes/note-1') return jsonResponse({ note });
    if (url.pathname === '/api/spaces/space-1/sources') {
      return jsonResponse({ sources: url.searchParams.get('archived') === 'only' ? [] : [source] });
    }
    return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${path}` } }, 404);
  });
  return puts;
}

function renderPage(path = '/spaces/space-1/notebook') {
  return renderWithProviders(
    <Routes>
      <Route path="/spaces/:spaceId/notebook" element={<NotebookPage />} />
      <Route path="/spaces/:spaceId/notebook/print" element={<NotebookPrintPage />} />
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe('NotebookPage (Phase 6, PRD §13)', () => {
  it('loads the notebook into the editor, lights the rail item, and offers Export', async () => {
    stubApi();
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Notebook', level: 1 })).toBeInTheDocument();
    const editor = await screen.findByRole('textbox', { name: 'Notebook' });
    expect(editor).toHaveTextContent('Draft title');
    expect(editor).toHaveTextContent('Opening paragraph.');
    expect(screen.getByRole('link', { name: 'Notebook' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
  });

  it('lists notes in the Research panel, opens one in place, and Insert citation drops a chip without remounting the editor', async () => {
    const puts = stubApi();
    renderPage();
    const editorBefore = await screen.findByRole('textbox', { name: 'Notebook' });
    const panel = screen.getByRole('region', { name: 'Research panel' });
    expect(await within(panel).findByText('Slow-wave sleep and plasticity')).toBeInTheDocument();

    fireEvent.click(within(panel).getByText('Slow-wave sleep and plasticity'));
    expect(await within(panel).findByText('How does SWS affect plasticity?')).toBeInTheDocument();
    expect(within(panel).getByText('SWS downscales synaptic weights.')).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Insert citation: Synaptic Homeostasis' }));
    const chip = await screen.findByRole('link', { name: 'Open citation: Synaptic Homeostasis, p. 12' });
    expect(chip.getAttribute('href')).toContain('cite=cite-1');
    expect(chip.getAttribute('href')).toContain('from=%2Fspaces%2Fspace-1%2Fnotebook');

    // The editor is the same DOM node it was before the panel did anything.
    expect(screen.getByRole('textbox', { name: 'Notebook' })).toBe(editorBefore);

    // Back to the list, still the same editor; the insert is being saved.
    fireEvent.click(within(panel).getByRole('button', { name: 'Back to notes' }));
    expect(await within(panel).findByText('Slow-wave sleep and plasticity')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Notebook' })).toBe(editorBefore);
    await waitFor(() => expect(puts.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(JSON.stringify(puts[0])).toContain('"citationId":"cite-1"');
  });

  it('a chip whose source no longer exists says so', async () => {
    stubApi();
    renderPage();
    const panel = screen.getByRole('region', { name: 'Research panel' });
    fireEvent.click(await within(panel).findByText('Slow-wave sleep and plasticity'));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Insert citation: A deleted source' }));
    expect(
      await screen.findByRole('link', { name: 'Open citation: A deleted source, ¶ p3 (source removed)' }),
    ).toBeInTheDocument();
  });

  it('⌘B with the caret in the editor does not collapse the rail', async () => {
    stubApi();
    renderPage();
    const editor = await screen.findByRole('textbox', { name: 'Notebook' });
    const rail = document.querySelector('[data-slot="sidebar"][data-state]')!;
    expect(rail).toHaveAttribute('data-state', 'expanded');
    fireEvent.keyDown(editor, { key: 'b', metaKey: true });
    expect(rail).toHaveAttribute('data-state', 'expanded');
    // Elsewhere on the page the generated shortcut still works.
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    await waitFor(() => expect(rail).toHaveAttribute('data-state', 'collapsed'));
  });

  it('an archived space is read-only: banner, no toolbar, no Insert citation, Export still offered', async () => {
    stubApi({ space: { ...space, archivedAt: '2026-08-20T00:00:00.000Z' } });
    renderPage();
    expect(await screen.findByText(/This space is archived/)).toBeInTheDocument();
    const editor = await screen.findByRole('textbox', { name: 'Notebook' });
    expect(editor).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Research panel' });
    fireEvent.click(await within(panel).findByText('Slow-wave sleep and plasticity'));
    await within(panel).findByText('How does SWS affect plasticity?');
    expect(within(panel).queryByRole('button', { name: /Insert citation/ })).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('link', { name: /Open in reader/ })).toHaveLength(2);
  });

  it('the Research panel can be closed and reopened', async () => {
    stubApi();
    renderPage();
    await screen.findByRole('textbox', { name: 'Notebook' });
    fireEvent.click(screen.getByRole('button', { name: 'Close research panel' }));
    expect(screen.queryByRole('region', { name: 'Research panel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Research panel' }));
    expect(screen.getByRole('region', { name: 'Research panel' })).toBeInTheDocument();
  });

  it('a notebook that fails to load shows the error with Retry, not a blank page', async () => {
    // The query client retries a 5xx twice (query-client.ts) before it is an
    // error, so the API stays down until the user presses Retry.
    let down = true;
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.endsWith('/spaces/space-1')) return jsonResponse({ space });
      if (path.endsWith('/spaces/space-1/notebook')) {
        return down
          ? jsonResponse({ error: { code: 'internal_error', message: 'Something went wrong on our side.' } }, 500)
          : jsonResponse({ notebook });
      }
      return jsonResponse({ notes: [], sources: [] });
    });
    renderPage();
    expect(await screen.findByText('Something went wrong on our side.', {}, { timeout: 8000 })).toBeInTheDocument();
    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('textbox', { name: 'Notebook' })).toBeInTheDocument();
  }, 10_000);
});

describe('NotebookPrintPage (Phase 6, PRD §14)', () => {
  it('renders name, objective, the document, and the source list; prints once; hides every control from print', async () => {
    const printed = vi.fn();
    vi.stubGlobal('print', printed);
    window.print = printed;
    stubApi({
      notebook: {
        ...notebook,
        contentRich: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Findings' }] },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Sleep helps ' },
                {
                  type: 'citation',
                  attrs: { citationId: 'cite-1', sourceId: 'src-1', sourceTitle: 'Old title', page: 12, paragraphRef: null, quotedText: 'q' },
                },
                { type: 'text', text: ' and ' },
                {
                  type: 'citation',
                  attrs: { citationId: 'cite-9', sourceId: 'src-gone', sourceTitle: 'Removed one', page: null, paragraphRef: 'p3', quotedText: 'q' },
                },
              ],
            },
          ],
        },
      },
    });
    renderPage('/spaces/space-1/notebook/print');

    expect(await screen.findByRole('heading', { name: 'Sleep and Memory', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Why naps help/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Findings' })).toBeInTheDocument();
    const sources = screen.getByRole('region', { name: 'Sources' });
    // Live title wins over the copied one; a removed source is named as such.
    expect(sources).toHaveTextContent('[1]');
    expect(sources).toHaveTextContent('Synaptic Homeostasis — Tononi — p. 12');
    expect(sources).not.toHaveTextContent('Old title');
    expect(sources).toHaveTextContent('[2]');
    expect(sources).toHaveTextContent('Removed one, ¶ p3 (source removed)');

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    await waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // The on-screen controls are marked print-hidden.
    expect(screen.getByRole('navigation', { name: 'Print controls' }).className).toContain('print:hidden');
  });

  // --- Shared spaces v1: role and presence --------------------------------------

  it('a viewer reads the notebook: no toolbar, an explanation, Export still offered', async () => {
    stubApi({ space: { ...space, myRole: 'viewer', ownerName: 'Tan', memberCount: 2 } });
    renderPage();
    const editor = await screen.findByRole('textbox', { name: 'Notebook' });
    expect(editor).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByText(/editing it needs an editor role/)).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('steps back to read mode when someone else is already editing, until Edit anyway', async () => {
    stubApi({ presence: [{ id: 'u-other', name: 'Minh' }] });
    renderPage();
    expect(await screen.findByText(/Minh is editing this notebook right now/)).toBeInTheDocument();
    const editor = screen.getByRole('textbox', { name: 'Notebook' });
    await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'false'));
    // Announced as a state: the header's live region carries the name.
    expect(screen.getAllByText('Minh is editing').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Edit anyway' }));
    await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'true'));
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit anyway' })).not.toBeInTheDocument();
  });

  it('heartbeats while editing and clears presence on unmount', async () => {
    const puts: unknown[] = [];
    stubApi({ puts });
    const spy = vi.mocked(globalThis.fetch);
    const { unmount } = renderPage();
    await screen.findByRole('textbox', { name: 'Notebook' });
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([input, init]) => String(input).endsWith('/notebook/presence') && init?.method === 'POST'),
      ).toBe(true),
    );
    unmount();
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([input, init]) => String(input).endsWith('/notebook/presence') && init?.method === 'DELETE'),
      ).toBe(true),
    );
  });
});
