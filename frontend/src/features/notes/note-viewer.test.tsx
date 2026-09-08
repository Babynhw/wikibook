import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Note } from '@/lib/api';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';
import { NoteViewer } from './note-viewer';

const note: Note = {
  id: 'note-1',
  spaceId: 'space-1',
  title: 'Original title',
  contentRich: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original body text.' }] }],
  },
  originType: 'user',
  originConversationId: null,
  originMessageId: null,
  citationCount: 0,
  citations: [],
  convertedSource: null,
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
};

function renderViewer(override: Partial<Note> = {}) {
  return renderWithProviders(
    <NoteViewer
      note={{ ...note, ...override }}
      onClose={vi.fn()}
      onConvert={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

/** A document deeper than the walker's 100-level bound. */
function deeplyNestedDoc() {
  let node: Record<string, unknown> = {
    type: 'paragraph',
    content: [{ type: 'text', text: 'Buried past the depth bound.' }],
  };
  for (let i = 0; i < 120; i += 1) {
    node = { type: 'blockquote', content: [node] };
  }
  return { type: 'doc', content: [node] };
}

describe('NoteViewer', () => {
  it('shows the note read-only until Edit is pressed', async () => {
    renderViewer();
    expect(screen.getByRole('complementary', { name: 'Original title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText('Original body text.')).toBeInTheDocument();
  });

  it('Cancel discards the draft and restores the original title and content', async () => {
    const user = userEvent.setup();
    renderViewer();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const [titleInput, contentTextarea] = screen.getAllByRole('textbox');
    await user.clear(titleInput!);
    await user.type(titleInput!, 'Edited title');
    await user.clear(contentTextarea!);
    await user.type(contentTextarea!, 'Edited body text.');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Back in the read view with the ORIGINAL values — the abandoned draft did
    // not survive the cancel, and does not resurface on the next click of Edit.
    expect(screen.getByRole('heading', { name: 'Original title' })).toBeInTheDocument();
    expect(screen.getByText('Original body text.')).toBeInTheDocument();
    expect(screen.queryByText('Edited title')).not.toBeInTheDocument();
    expect(screen.queryByText('Edited body text.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const [titleAgain, contentAgain] = screen.getAllByRole('textbox');
    expect(titleAgain!).toHaveValue('Original title');
    expect(contentAgain!).toHaveValue('Original body text.');
  });

  it('labels both editor controls with real <label> elements', async () => {
    const user = userEvent.setup();
    renderViewer();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // getByLabelText only resolves through a genuine label/for association —
    // an unlabelled textarea announces as "edit text, blank" (PRD §18).
    expect(screen.getByLabelText('Note Title')).toHaveValue('Original title');
    expect(screen.getByLabelText('Note content')).toHaveValue('Original body text.');
  });

  it('withholds Edit on a note too deeply nested to read in full', () => {
    // The walk truncated, so the editor's text is a lossy view of the document.
    // Offering Edit would let a save rewrite `contentRich` from that truncated
    // text and destroy whatever the walk could not reach.
    renderViewer({ contentRich: deeplyNestedDoc() });

    expect(screen.getByText(/nested too deeply to show in full/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('still offers Edit on a note the walk read to the bottom', () => {
    renderViewer();
    expect(screen.queryByText(/nested too deeply/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  /** PRD §16 "note save failure": the message shows, the draft stays, Save changes retries. */
  it('a failed save shows the error, keeps the edited text, and saves on the next try (REQ-211)', async () => {
    const user = userEvent.setup();
    let failing = true;
    const bodies: unknown[] = [];
    stubFetch((path, init) => {
      if (path.endsWith('/notes/note-1') && init?.method === 'PATCH') {
        bodies.push(JSON.parse(String(init.body)));
        if (failing) {
          return jsonResponse({ error: { code: 'internal_error', message: 'Something went wrong on our side.' } }, 500);
        }
        return jsonResponse({ note: { ...note, title: 'Edited title' } });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderViewer();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const [titleInput] = screen.getAllByRole('textbox');
    await user.clear(titleInput!);
    await user.type(titleInput!, 'Edited title');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Edited title');

    failing = false;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('button', { name: 'Edit' });
    expect(bodies).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
