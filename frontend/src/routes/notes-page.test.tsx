import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Note, Space } from '@/lib/api';
import { NotesPage } from '@/routes/notes-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const space: Space = {
  id: 'space-1',
  name: 'Sleep and Memory Workspace',
  objective: 'Investigate sleep consolidation mechanisms',
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 2,
  noteCount: 2,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
};

const user = { id: 'u1', name: 'Researcher', email: 'researcher@example.test' };

const sampleNotes: Note[] = [
  {
    id: 'note-1',
    spaceId: 'space-1',
    title: 'Slow-wave sleep effects on synaptic plasticity',
    contentRich: {
      type: 'doc',
      question: 'How does slow-wave sleep affect plasticity?',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'SWS downscales synaptic weights across neocortex.' }],
        },
      ],
    },
    originType: 'saved_answer',
    originConversationId: 'conv-1',
    originMessageId: 'msg-1',
    citationCount: 1,
    citations: [
      {
        id: 'cite-1',
        sourceId: 'src-1',
        sourceTitle: 'Synaptic Homeostasis Hypothesis',
        quotedText: 'SWS downscales synaptic weights across neocortex.',
        page: 12,
        paragraphRef: 'p3',
        sectionHeading: 'Results',
        stale: false,
        createdAt: '2026-08-01T11:00:00.000Z',
      },
    ],
    convertedSource: null,
    createdAt: '2026-08-01T11:00:00.000Z',
    updatedAt: '2026-08-01T11:00:00.000Z',
  },
  {
    id: 'note-2',
    spaceId: 'space-1',
    title: 'Methodology considerations for EEG trials',
    contentRich: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Electrode impedance must be checked every 2 hours.' }],
        },
      ],
    },
    originType: 'user',
    originConversationId: null,
    originMessageId: null,
    citationCount: 0,
    citations: [],
    convertedSource: null,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
  },
];

function renderNotesPage(
  handler: Parameters<typeof stubFetch>[0],
  initialUrl = '/spaces/space-1/notes',
) {
  stubFetch(handler);
  return renderWithProviders(
    <Routes>
      <Route path="/spaces/:spaceId/notes" element={<NotesPage />} />
    </Routes>,
    { routerProps: { initialEntries: [initialUrl] } },
  );
}

describe('NotesPage (Phase 5, PRD §10, §11, §12)', () => {
  it('renders empty notes state with create and ask assistant prompts', async () => {
    renderNotesPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/spaces/space-1/notes')) return jsonResponse({ notes: [] });
      return jsonResponse({ space });
    });

    expect(await screen.findByRole('heading', { name: 'Saved Notes' })).toBeInTheDocument();
    expect(await screen.findByText('No saved notes yet')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /create a note/i })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /ask assistant/i })).toBeInTheDocument();
  });

  it('renders list of notes with origin badges, snippets, and citation counts', async () => {
    renderNotesPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/spaces/space-1/notes')) return jsonResponse({ notes: sampleNotes });
      return jsonResponse({ space });
    });

    expect(await screen.findByText('Slow-wave sleep effects on synaptic plasticity')).toBeInTheDocument();
    expect(screen.getByText('Methodology considerations for EEG trials')).toBeInTheDocument();
    expect(screen.getByText('Saved Answer')).toBeInTheDocument();
    expect(screen.getByText('User Note')).toBeInTheDocument();
    expect(screen.getByText('1 citation')).toBeInTheDocument();
  });

  it('searches server-side through the debounced ?q= query and supports clearing search', async () => {
    const person = userEvent.setup();
    const searchCalls: string[] = [];

    renderNotesPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/spaces/space-1/notes')) {
        const q = new URL(path, 'http://localhost').searchParams.get('q') ?? '';
        if (q) searchCalls.push(q);
        const notes = q
          ? sampleNotes.filter((note) => note.title.toLowerCase().includes(q.toLowerCase()))
          : sampleNotes;
        return jsonResponse({ notes });
      }
      return jsonResponse({ space });
    });

    const searchInput = await screen.findByPlaceholderText('Search notes...');
    await person.type(searchInput, 'synaptic');

    // One request for the settled query (the input debounces), and the list
    // narrows to the title match the server returned.
    await waitFor(() => expect(searchCalls).toContain('synaptic'));
    await waitFor(() =>
      expect(screen.queryByText('Methodology considerations for EEG trials')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Slow-wave sleep effects on synaptic plasticity')).toBeInTheDocument();

    await person.clear(searchInput);
    await person.type(searchInput, 'nonexistent query');

    expect(await screen.findByText(/No notes match “nonexistent query”/i)).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: /clear search/i }));
    await waitFor(() =>
      expect(screen.getByText('Methodology considerations for EEG trials')).toBeInTheDocument(),
    );
  });

  it('creates a new manual note via CreateNoteDialog', async () => {
    const person = userEvent.setup();
    const calls: Array<{ method: string; body: unknown }> = [];

    renderNotesPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/spaces/space-1/notes')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          calls.push({ method: 'POST', body });
          const newNote: Note = {
            id: 'note-3',
            spaceId: 'space-1',
            title: body.title,
            contentRich: body.contentRich,
            originType: 'user',
            originConversationId: null,
            originMessageId: null,
            citationCount: 0,
            citations: [],
            convertedSource: null,
            createdAt: '2026-08-01T13:00:00.000Z',
            updatedAt: '2026-08-01T13:00:00.000Z',
          };
          return jsonResponse({ note: newNote }, 201);
        }
        return jsonResponse({ notes: sampleNotes });
      }
      return jsonResponse({ space });
    });

    const newNoteBtn = await screen.findByRole('button', { name: /new note/i });
    await person.click(newNoteBtn);

    expect(screen.getByRole('heading', { name: 'New Note' })).toBeInTheDocument();
    await person.type(screen.getByLabelText(/title/i), 'Hypothesis on delta waves');
    await person.type(
      screen.getByLabelText(/content/i),
      'Delta wave coherence predicts recall improvement.',
    );

    await person.click(screen.getByRole('button', { name: 'Create note' }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.body).toEqual({
      title: 'Hypothesis on delta waves',
      contentRich: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Delta wave coherence predicts recall improvement.' }],
          },
        ],
      },
    });
  });

  /** PRD §16 "note save failure": the field error lands on Title and the typed text survives. */
  it('a refused create keeps the typed note and shows the error on its field (REQ-210)', async () => {
    const person = userEvent.setup();
    renderNotesPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/spaces/space-1/notes')) {
        if (init?.method === 'POST') {
          return jsonResponse(
            {
              error: {
                code: 'validation_error',
                message: 'Please check the highlighted fields and try again.',
                fields: { title: 'A note with this title already exists.' },
              },
            },
            400,
          );
        }
        return jsonResponse({ notes: sampleNotes });
      }
      return jsonResponse({ space });
    });

    await person.click(await screen.findByRole('button', { name: /new note/i }));
    await person.type(screen.getByLabelText(/title/i), 'Duplicate title');
    await person.type(screen.getByLabelText(/content/i), 'Body that must survive.');
    await person.click(screen.getByRole('button', { name: 'Create note' }));

    expect(await screen.findByText('A note with this title already exists.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toHaveValue('Duplicate title');
    expect(screen.getByLabelText(/content/i)).toHaveValue('Body that must survive.');
  });

  it('opens NoteViewer, displays question, answer, citations, and allows editing and saving', async () => {
    const person = userEvent.setup();
    const updateCalls: Array<{ id: string; body: unknown }> = [];

    renderNotesPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.endsWith('/notes/note-1')) {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(init.body as string);
          updateCalls.push({ id: 'note-1', body });
          return jsonResponse({
            note: {
              ...sampleNotes[0],
              title: body.title || sampleNotes[0]!.title,
              contentRich: body.contentRich || sampleNotes[0]!.contentRich,
            },
          });
        }
        return jsonResponse({ note: sampleNotes[0] });
      }
      if (path.includes('/spaces/space-1/notes')) return jsonResponse({ notes: sampleNotes });
      return jsonResponse({ space });
    });

    const openButtons = await screen.findAllByRole('button', { name: /open/i });
    await person.click(openButtons[0]!);

    // Viewer opened
    expect(await screen.findByRole('complementary', { name: /slow-wave sleep/i })).toBeInTheDocument();
    expect(screen.getByText('Original Question')).toBeInTheDocument();
    expect(screen.getByText('How does slow-wave sleep affect plasticity?')).toBeInTheDocument();
    expect(screen.getByText('Attached Citations (1)')).toBeInTheDocument();
    expect(screen.getByText(/Synaptic Homeostasis Hypothesis/i)).toBeInTheDocument();
    expect(screen.getByText(/Open cited passage in reader/i)).toBeInTheDocument();

    // Click Edit
    await person.click(screen.getByRole('button', { name: 'Edit' }));
    const titleInput = screen.getByLabelText(/note title/i);
    await person.clear(titleInput);
    await person.type(titleInput, 'Slow-wave sleep and cortical plasticity (revised)');

    await person.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect((updateCalls[0]!.body as { title: string }).title).toBe(
      'Slow-wave sleep and cortical plasticity (revised)',
    );
  });

  it('converts a note to an evidence source with confirmation dialog (PRD §12)', async () => {
    const person = userEvent.setup();
    const convertCalls: string[] = [];

    renderNotesPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/convert-to-source')) {
        convertCalls.push(path);
        return jsonResponse(
          {
            source: {
              id: 'src-converted-1',
              spaceId: 'space-1',
              type: 'manual',
              title: 'Methodology considerations for EEG trials',
              author: 'User note',
              url: null,
              state: 'processing',
              errorMessage: null,
              archivedAt: null,
              createdAt: '2026-08-01T14:00:00.000Z',
              updatedAt: '2026-08-01T14:00:00.000Z',
            },
          },
          201,
        );
      }
      if (path.includes('/spaces/space-1/notes')) return jsonResponse({ notes: sampleNotes });
      return jsonResponse({ space });
    });

    const convertButtons = await screen.findAllByRole('button', { name: /convert/i });
    await person.click(convertButtons[1]!); // Note 2 (user note)

    expect(
      await screen.findByRole('heading', { name: 'Convert Note to Evidence Source' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Snapshot & Provenance Guarantee/i)).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Convert to source' }));

    await waitFor(() => expect(convertCalls.length).toBe(1));
    expect(convertCalls[0]).toContain('/notes/note-2/convert-to-source');
  });

  it('deletes a note with confirmation dialog', async () => {
    const person = userEvent.setup();
    const deleteCalls: string[] = [];

    renderNotesPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/notes/note-2') && init?.method === 'DELETE') {
        deleteCalls.push(path);
        return jsonResponse(null, 204);
      }
      if (path.includes('/spaces/space-1/notes')) return jsonResponse({ notes: sampleNotes });
      return jsonResponse({ space });
    });

    const deleteButtons = await screen.findAllByRole('button', { name: /delete note/i });
    await person.click(deleteButtons[1]!); // Note 2

    expect(
      await screen.findByText(/Delete “Methodology considerations for EEG trials”?/i),
    ).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Delete note' }));

    await waitFor(() => expect(deleteCalls.length).toBe(1));
  });

  it('shows read-only alert and withholds every write action when the space is archived', async () => {
    const person = userEvent.setup();
    renderNotesPage((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.endsWith('/notes/note-1')) return jsonResponse({ note: sampleNotes[0] });
      if (path.includes('/spaces/space-1/notes')) return jsonResponse({ notes: sampleNotes });
      return jsonResponse({ space: { ...space, archivedAt: '2026-08-10T10:00:00.000Z' } });
    });

    expect(
      await screen.findByText(/This space is archived\. Notes are read-only/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new note/i })).not.toBeInTheDocument();

    // The banner's claim is kept on the cards: no Convert, no Delete.
    expect(screen.queryByRole('button', { name: /convert/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete note/i })).not.toBeInTheDocument();

    // ... and the viewer offers neither Edit, Convert, nor Delete once opened.
    const openButtons = await screen.findAllByRole('button', { name: /open/i });
    await person.click(openButtons[0]!);
    expect(
      await screen.findByRole('complementary', { name: /slow-wave sleep/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Convert to source' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('round-trips a multi-paragraph note through an edit without flattening it', async () => {
    const person = userEvent.setup();
    const updateCalls: Array<{ body: Record<string, unknown> }> = [];

    const multiParagraphNote: Note = {
      ...sampleNotes[0]!,
      id: 'note-4',
      title: 'Two paragraphs survive editing',
      contentRich: {
        type: 'doc',
        question: 'How does SWS affect plasticity?',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] },
        ],
      },
    };

    renderNotesPage((path, init) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.endsWith('/notes/note-4')) {
        if (init?.method === 'PATCH') {
          updateCalls.push({ body: JSON.parse(init.body as string) });
          return jsonResponse({ note: multiParagraphNote });
        }
        return jsonResponse({ note: multiParagraphNote });
      }
      if (path.includes('/spaces/space-1/notes')) {
        return jsonResponse({ notes: [multiParagraphNote] });
      }
      return jsonResponse({ space });
    });

    const openButtons = await screen.findAllByRole('button', { name: /open/i });
    await person.click(openButtons[0]!);
    await screen.findByRole('complementary', { name: /two paragraphs survive editing/i });

    await person.click(screen.getByRole('button', { name: 'Edit' }));
    await person.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateCalls.length).toBe(1));
    const contentRich = updateCalls[0]!.body.contentRich as {
      content: Array<{ type: string; content: Array<{ text: string }> }>;
    };
    expect(contentRich.content).toHaveLength(2);
    expect(contentRich.content[0]!.content[0]!.text).toBe('First paragraph.');
    expect(contentRich.content[1]!.content[0]!.text).toBe('Second paragraph.');
  });
});
