import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationMessage, Note, Source } from '@/lib/api';
import { SpaceDialog } from '@/features/spaces/space-dialog';
import { AddSourceDialog } from '@/features/sources/add-source-dialog';
import { ArchiveSourceDialog } from '@/features/sources/archive-source-dialog';
import { DeleteSourceDialog } from '@/features/sources/delete-source-dialog';
import { EditSourceDialog } from '@/features/sources/edit-source-dialog';
import { SourceStateAnnouncer } from '@/features/sources/source-state-badge';
import { CreateNoteDialog } from '@/features/notes/create-note-dialog';
import { ConvertNoteDialog } from '@/features/notes/convert-note-dialog';
import { DeleteNoteDialog } from '@/features/notes/delete-note-dialog';
import { NoteViewer } from '@/features/notes/note-viewer';
import { LinkDialog } from '@/features/notebook/link-dialog';
import { SaveStatus } from '@/features/notebook/save-status';
import { AnswerMessage } from '@/features/assistant/answer-message';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

/**
 * PRD §18, the parts axe cannot see: focus management, live regions, and
 * status that is legible without colour. One test per dialog component, so a
 * dialog that stops returning focus fails by name.
 */

const source: Source = {
  id: 'src-1',
  spaceId: 'space-1',
  type: 'pdf',
  title: 'Synaptic Homeostasis Hypothesis',
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

/** An opener button and, while open, whatever the case renders with a close callback. */
function Harness({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open ? children(() => setOpen(false)) : null}
    </>
  );
}

const dialogs: Array<[string, (close: () => void) => ReactNode]> = [
  [
    'SpaceDialog',
    (close) => (
      <SpaceDialog title="New space" submitLabel="Create" pending={false} error={null} onSubmit={() => {}} onClose={close} />
    ),
  ],
  ['AddSourceDialog', (close) => <AddSourceDialog spaceId="space-1" onClose={close} />],
  ['ArchiveSourceDialog', (close) => <ArchiveSourceDialog source={source} onClose={close} />],
  ['DeleteSourceDialog', (close) => <DeleteSourceDialog source={source} onClose={close} />],
  ['EditSourceDialog', (close) => <EditSourceDialog source={source} onClose={close} />],
  ['CreateNoteDialog', (close) => <CreateNoteDialog spaceId="space-1" onClose={close} />],
  ['ConvertNoteDialog', (close) => <ConvertNoteDialog note={note} onClose={close} />],
  ['DeleteNoteDialog', (close) => <DeleteNoteDialog note={note} onClose={close} />],
  ['LinkDialog', (close) => <LinkDialog open initialHref="" onClose={close} onApply={() => {}} onRemove={() => {}} />],
];

describe('PRD §18 — every dialog closes on Escape and returns focus to its opener', () => {
  for (const [name, render] of dialogs) {
    it(name, async () => {
      const person = userEvent.setup();
      renderWithProviders(<Harness>{render}</Harness>);
      const opener = screen.getByRole('button', { name: 'opener' });

      await person.click(opener);
      const dialog = await screen.findByRole('dialog');
      // Focus moved in — Tab from the opener would otherwise land behind the modal.
      expect(dialog.contains(document.activeElement)).toBe(true);

      await person.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(opener).toHaveFocus();
    });
  }
});

describe('PRD §18 — the note viewer drawer', () => {
  function renderDrawer(override: Partial<Note> = {}) {
    return renderWithProviders(
      <Harness>
        {(close) => (
          <DrawerWithDelete note={{ ...note, ...override }} onClose={close} />
        )}
      </Harness>,
    );
  }

  /** The notes page's arrangement: the drawer, and a Delete dialog it can stack on top. */
  function DrawerWithDelete({ note: current, onClose }: { note: Note; onClose: () => void }) {
    const [deleting, setDeleting] = useState(false);
    return (
      <>
        <NoteViewer note={current} onClose={onClose} onConvert={() => {}} onDelete={() => setDeleting(true)} />
        {deleting ? <DeleteNoteDialog note={current} onClose={() => setDeleting(false)} /> : null}
      </>
    );
  }

  it('takes focus on open, closes on Escape, and returns focus to the opener', async () => {
    const person = userEvent.setup();
    renderDrawer();
    const opener = screen.getByRole('button', { name: 'opener' });

    await person.click(opener);
    const drawer = await screen.findByRole('complementary', { name: 'Original title' });
    expect(screen.getByRole('button', { name: 'Close note viewer' })).toHaveFocus();
    expect(drawer.contains(document.activeElement)).toBe(true);

    await person.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('Escape while editing with unsaved changes keeps the draft and the drawer (PRD §16)', async () => {
    const person = userEvent.setup();
    renderDrawer();
    await person.click(screen.getByRole('button', { name: 'opener' }));
    await person.click(await screen.findByRole('button', { name: 'Edit' }));
    await person.type(screen.getByLabelText('Note Title'), ' edited');

    await person.keyboard('{Escape}');

    expect(screen.getByRole('complementary', { name: 'Original title' })).toBeInTheDocument();
    expect(screen.getByLabelText('Note Title')).toHaveValue('Original title edited');
  });

  it('Escape while editing with nothing typed leaves edit mode and keeps the drawer open', async () => {
    const person = userEvent.setup();
    renderDrawer();
    await person.click(screen.getByRole('button', { name: 'opener' }));
    await person.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Note Title')).toBeInTheDocument();

    await person.keyboard('{Escape}');

    expect(screen.getByRole('complementary', { name: 'Original title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Original title' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Note Title')).toBeNull();
  });

  it('Escape on a dialog stacked over the drawer closes only the dialog', async () => {
    const person = userEvent.setup();
    renderDrawer();
    await person.click(screen.getByRole('button', { name: 'opener' }));
    await person.click(await screen.findByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog');

    await person.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('complementary', { name: 'Original title' })).toBeInTheDocument();
  });

  it('announces the save state in a status region and shows a failed save', async () => {
    const person = userEvent.setup();
    stubFetch((path, init) => {
      if (path.endsWith('/notes/note-1') && init?.method === 'PATCH') {
        return jsonResponse(
          { error: { code: 'validation_failed', message: 'Please check the highlighted fields and try again.' } },
          400,
        );
      }
      return jsonResponse({ notes: [] });
    });
    renderDrawer();
    await person.click(screen.getByRole('button', { name: 'opener' }));
    await person.click(await screen.findByRole('button', { name: 'Edit' }));
    await person.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Save failed'));
    expect(screen.getByRole('alert')).toHaveTextContent('Please check the highlighted fields');
    // The draft is still there to fix (PRD §16).
    expect(screen.getByLabelText('Note Title')).toHaveValue('Original title');
  });
});

describe('PRD §18 — state is announced and legible without colour', () => {
  it('notebook save state renders inside role="status" with a word, not only an icon', () => {
    const noop = vi.fn();
    const { rerender } = render(
      <SaveStatus state={{ kind: 'saving' }} onRetry={noop} onReload={noop} onKeepMine={noop} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');

    rerender(
      <SaveStatus state={{ kind: 'saved', at: '2026-08-27T09:30:00.000Z' }} onRetry={noop} onReload={noop} onKeepMine={noop} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Saved');

    rerender(
      <SaveStatus
        state={{ kind: 'failed', message: 'Could not reach the server.', retrying: false }}
        onRetry={noop}
        onReload={noop}
        onKeepMine={noop}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Save failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    rerender(<SaveStatus state={{ kind: 'idle' }} frozen onRetry={noop} onReload={noop} onKeepMine={noop} />);
    expect(screen.getByRole('status')).toHaveTextContent('Read-only');
  });

  it('a source moving through processing is announced in role="status" once it changes', () => {
    const { rerender } = render(<SourceStateAnnouncer state="processing" title="Sleep Review" />);
    // The first render is what is already on screen: nothing to announce.
    expect(screen.getByRole('status')).toHaveTextContent('');

    rerender(<SourceStateAnnouncer state="ready" title="Sleep Review" />);
    expect(screen.getByRole('status')).toHaveTextContent('Sleep Review is ready to use.');

    rerender(<SourceStateAnnouncer state="failed" title="Sleep Review" />);
    expect(screen.getByRole('status')).toHaveTextContent('Sleep Review could not be processed.');
  });

  it('a stale citation marker in an answer says so in its name', () => {
    const message: ConversationMessage = {
      id: 'msg-2',
      role: 'assistant',
      content: 'Recall drops [1] and rebounds [2].',
      feedback: null,
      grounded: true,
      passagesSent: 4,
      sourcesUsed: [{ id: 'src-1', title: 'Synaptic Homeostasis Hypothesis' }],
      citations: [
        { id: 'mc-1', index: 1, sourceId: 'src-1', sourceTitle: 'Synaptic Homeostasis Hypothesis', quotedText: 'q', reference: 'p. 12', stale: false },
        { id: 'mc-2', index: 2, sourceId: 'src-gone', sourceTitle: 'A removed paper', quotedText: 'q', reference: 'p. 3', stale: true },
      ],
      savedNoteId: null,
      createdAt: '2026-08-20T10:00:05.000Z',
    };
    renderWithProviders(
      <AnswerMessage message={message} spaceId="space-1" conversationId="conv-1" returnTo="/spaces/space-1/assistant/conv-1" />,
    );
    expect(
      screen.getByRole('button', { name: 'Citation 1: Synaptic Homeostasis Hypothesis, p. 12' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Citation 2: A removed paper, p. 3 (passage no longer available)' }),
    ).toBeInTheDocument();
  });
});
