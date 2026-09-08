import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Notebook } from '@/lib/api';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';
import { authKeys } from '@/features/auth/use-auth';
import { CitationContext } from './citation-node';
import { NotebookEditor, type NotebookEditorHandle } from './notebook-editor';
import { DEBOUNCE_MS } from './use-autosave';
import { readDraft, writeDraft } from './draft-storage';

const notebook: Notebook = {
  id: 'nb-1',
  spaceId: 'space-1',
  contentRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Seed' }] }] },
  createdAt: '2026-08-27T09:00:00.000Z',
  updatedAt: '2026-08-27T09:00:00.000Z',
};

const citation = {
  citationId: 'cite-1',
  sourceId: 'src-1',
  sourceTitle: 'Smith 2023',
  page: 4,
  paragraphRef: null,
  quotedText: 'a quoted line',
};

function renderEditor(props: Partial<{ editable: boolean; notebook: Notebook }> = {}) {
  const ref = createRef<NotebookEditorHandle>();
  const result = renderWithProviders(
    <CitationContext.Provider value={{ spaceId: 'space-1', sourceIds: new Set(['src-1']) }}>
      <NotebookEditor
        ref={ref}
        spaceId="space-1"
        notebook={props.notebook ?? notebook}
        editable={props.editable ?? true}
      />
    </CitationContext.Provider>,
    { routerProps: { initialEntries: ['/spaces/space-1/notebook'] } },
  );
  return { ...result, ref };
}

/** A PUT handler that records bodies and answers with the given responder. */
function putStub(respond: (body: { contentRich: unknown; baseUpdatedAt: string }, n: number) => Response) {
  const bodies: Array<{ contentRich: unknown; baseUpdatedAt: string }> = [];
  stubFetch((path, init) => {
    if (init?.method === 'PUT' && path.endsWith('/spaces/space-1/notebook')) {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return respond(body, bodies.length);
    }
    return jsonResponse({ error: { code: 'not_found', message: 'nope' } }, 404);
  });
  return bodies;
}

const savedResponse = (contentRich: unknown, updatedAt: string) =>
  jsonResponse({ notebook: { ...notebook, contentRich, updatedAt } });

describe('NotebookEditor autosave (Phase 6, PRD §13)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opening the notebook without editing saves nothing and writes no draft', async () => {
    const bodies = putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:00:30.000Z'));
    renderEditor();
    // `setEditable` emits `update` unless told not to — this is the regression
    // that would PUT an identical document on every mount.
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3));
    expect(bodies).toHaveLength(0);
    expect(readDraft('nb-1')).toBeNull();
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
  });

  it('a 401 marks the session lost so the guard can redirect, and keeps the draft', async () => {
    putStub(() => jsonResponse({ error: { code: 'unauthorized', message: 'You need to sign in to continue.' } }, 401));
    const { ref, client } = renderEditor();
    client.setQueryData(authKeys.me, { id: 'u1', name: 'R', email: 'r@example.test' });
    act(() => ref.current!.getEditor()!.commands.insertContent(' typed'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await screen.findByText('Save failed');
    expect(client.getQueryData(authKeys.me)).toBeNull();
    expect(JSON.stringify(readDraft('nb-1')?.doc)).toContain('typed');
  });

  it('after a 400 the next edit tries again instead of leaving the editor unsaveable', async () => {
    const bodies = putStub((body, n) =>
      n === 1
        ? jsonResponse({ error: { code: 'invalid_document', message: 'Not a document the editor produces.' } }, 400)
        : savedResponse(body.contentRich, '2026-08-27T09:20:00.000Z'),
    );
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' first'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await screen.findByText('Save failed');
    // No automatic retry for a 400…
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(bodies).toHaveLength(1);
    // …but an edit is a new attempt.
    act(() => ref.current!.getEditor()!.commands.insertContent(' second'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('a 413 stops the loop until the next edit', async () => {
    const bodies = putStub((body, n) =>
      n === 1
        ? jsonResponse({ error: { code: 'FST_ERR_CTP_BODY_TOO_LARGE', message: 'Request body is too large' } }, 413)
        : savedResponse(body.contentRich, '2026-08-27T09:21:00.000Z'),
    );
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' big'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await screen.findByText('Save failed');
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(bodies).toHaveLength(1);
    act(() => ref.current!.getEditor()!.commands.insertContent(' smaller'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await waitFor(() => expect(bodies).toHaveLength(2));
  });

  it('saves once after a burst of edits, carrying the base updatedAt, and reports Saving → Saved', async () => {
    const bodies = putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:01:00.000Z'));
    const { ref } = renderEditor();
    const editor = ref.current!.getEditor()!;

    act(() => {
      editor.commands.insertContent(' one');
      editor.commands.insertContent(' two');
    });
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(bodies).toHaveLength(0);

    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.baseUpdatedAt).toBe(notebook.updatedAt);
    expect(JSON.stringify(bodies[0]!.contentRich)).toContain('two');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    // A clean save clears the across-tab draft.
    expect(readDraft('nb-1')).toBeNull();
  });

  it('keeps the draft and retries with backoff after a 500, then clears it on success', async () => {
    let calls = 0;
    const bodies = putStub((body) => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: { code: 'internal_error', message: 'Something went wrong on our side.' } }, 500)
        : savedResponse(body.contentRich, '2026-08-27T09:02:00.000Z');
    });
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' kept'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));

    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The text typed is in storage while the save is failing (§13 "must not be lost").
    expect(JSON.stringify(readDraft('nb-1')?.doc)).toContain('kept');

    // First backoff step is 2 s; the retry happens on its own.
    await act(() => vi.advanceTimersByTimeAsync(2100));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(readDraft('nb-1')).toBeNull();
  });

  it('Retry saves immediately', async () => {
    let calls = 0;
    const bodies = putStub((body) => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: { code: 'internal_error', message: 'down' } }, 500)
        : savedResponse(body.contentRich, '2026-08-27T09:03:00.000Z');
    });
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' x'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await screen.findByText('Save failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('a conflict stops and offers Reload (server wins) or Keep mine (re-save with the server base)', async () => {
    const serverDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another tab' }] }] };
    const bodies = putStub((body, n) =>
      n === 1
        ? jsonResponse(
            {
              error: { code: 'notebook_conflict', message: 'This notebook was changed somewhere else.' },
              notebook: { ...notebook, contentRich: serverDoc, updatedAt: '2026-08-27T09:05:00.000Z' },
            },
            409,
          )
        : savedResponse(body.contentRich, '2026-08-27T09:06:00.000Z'),
    );
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' mine'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));

    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    expect(screen.getByText(/changed somewhere else/)).toBeInTheDocument();

    // Keep mine: the second PUT uses the server's updatedAt as its base.
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.baseUpdatedAt).toBe('2026-08-27T09:05:00.000Z');
    expect(JSON.stringify(bodies[1]!.contentRich)).toContain('mine');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('Reload after a conflict replaces the document with the server copy and drops the draft', async () => {
    const serverDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another tab' }] }] };
    putStub(() =>
      jsonResponse(
        {
          error: { code: 'notebook_conflict', message: 'changed elsewhere' },
          notebook: { ...notebook, contentRich: serverDoc, updatedAt: '2026-08-27T09:05:00.000Z' },
        },
        409,
      ),
    );
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' mine'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await screen.findByRole('button', { name: 'Reload' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(ref.current!.getEditor()!.getText()).toBe('From another tab');
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(readDraft('nb-1')).toBeNull();
  });

  it('a 409 space_archived stops without retrying and keeps the text', async () => {
    const bodies = putStub(() =>
      jsonResponse({ error: { code: 'space_archived', message: 'This space is archived.' } }, 409),
    );
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' late'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    expect(screen.getByText('This space is archived.')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(bodies).toHaveLength(1);
    expect(ref.current!.getEditor()!.getText()).toContain('late');
  });

  it('applies a same-base draft silently and saves it', async () => {
    writeDraft('nb-1', {
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Recovered' }] }] },
      baseUpdatedAt: notebook.updatedAt,
      savedAt: '2026-08-27T09:00:30.000Z',
    });
    const bodies = putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:07:00.000Z'));
    const { ref } = renderEditor();
    expect(ref.current!.getEditor()!.getText()).toBe('Recovered');
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('offers an older-base draft instead of applying it; Discard clears it', async () => {
    writeDraft('nb-1', {
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stale draft' }] }] },
      baseUpdatedAt: '2026-08-26T00:00:00.000Z',
      savedAt: '2026-08-26T00:00:30.000Z',
    });
    putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:08:00.000Z'));
    const { ref } = renderEditor();
    expect(ref.current!.getEditor()!.getText()).toBe('Seed');
    const restore = screen.getByRole('button', { name: 'Restore' });
    expect(restore).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(readDraft('nb-1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('Restore applies the older draft and saves it over the server copy', async () => {
    writeDraft('nb-1', {
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stale draft' }] }] },
      baseUpdatedAt: '2026-08-26T00:00:00.000Z',
      savedAt: '2026-08-26T00:00:30.000Z',
    });
    const bodies = putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:09:00.000Z'));
    const { ref } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(ref.current!.getEditor()!.getText()).toBe('Stale draft');
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.baseUpdatedAt).toBe(notebook.updatedAt);
  });

  it('a throwing storage does not break editing or saving', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const bodies = putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:10:00.000Z'));
    const { ref } = renderEditor();
    act(() => ref.current!.getEditor()!.commands.insertContent(' ok'));
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    setItem.mockRestore();
  });
});

describe('NotebookEditor toolbar and keys (PRD §13, §18)', () => {
  beforeEach(() => window.localStorage.clear());

  it('toolbar buttons are pressed toggles that follow the editor state', async () => {
    putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:11:00.000Z'));
    const { ref } = renderEditor();
    const editor = ref.current!.getEditor()!;
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const bold = within(toolbar).getByRole('button', { name: 'Bold' });
    expect(bold).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(bold);
    await waitFor(() => expect(bold).toHaveAttribute('aria-pressed', 'true'));
    expect(editor.isActive('bold')).toBe(true);

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Heading 2' }));
    await waitFor(() =>
      expect(within(toolbar).getByRole('button', { name: 'Heading 2' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(editor.isActive('heading', { level: 2 })).toBe(true);

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Block quote' }));
    await waitFor(() => expect(editor.isActive('blockquote')).toBe(true));
    expect(within(toolbar).getByRole('button', { name: 'Block quote' })).toHaveAttribute('aria-pressed', 'true');

    const undo = within(toolbar).getByRole('button', { name: 'Undo' });
    expect(undo).not.toBeDisabled();
    fireEvent.click(undo);
    await waitFor(() => expect(editor.isActive('blockquote')).toBe(false));
    expect(within(toolbar).getByRole('button', { name: 'Redo' })).not.toBeDisabled();

    // History groups the heading and the quote into one undo step; start the
    // list checks from a plain paragraph either way.
    act(() => editor.commands.setParagraph());
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Bulleted list' }));
    await waitFor(() => expect(editor.isActive('bulletList')).toBe(true));
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Numbered list' }));
    await waitFor(() => expect(editor.isActive('orderedList')).toBe(true));
    expect(editor.isActive('bulletList')).toBe(false);
  });

  it('the link dialog has a labelled field, refuses an unsafe protocol next to it, and applies a safe one', async () => {
    const person = userEvent.setup();
    putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:12:00.000Z'));
    const { ref } = renderEditor();
    const editor = ref.current!.getEditor()!;
    act(() => editor.commands.selectAll());

    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    const field = await screen.findByLabelText('Link address');
    await person.clear(field);
    await person.type(field, 'javascript:alert(1)');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/starts with http/)).toBeInTheDocument();
    // What was typed is still there (PRD §16).
    expect(field).toHaveValue('javascript:alert(1)');

    await person.clear(field);
    await person.type(field, 'https://example.com/a');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByLabelText('Link address')).not.toBeInTheDocument());
    expect(editor.getAttributes('link').href).toBe('https://example.com/a');
  });

  it('⌘B in the editor bolds and never reaches the window (the rail shortcut)', () => {
    putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:13:00.000Z'));
    const { ref } = renderEditor();
    const editor = ref.current!.getEditor()!;
    const reachedWindow = vi.fn();
    window.addEventListener('keydown', reachedWindow);
    act(() => editor.commands.selectAll());

    // jsdom is not a Mac, so ProseMirror reads `Mod` as Ctrl; the editor stops
    // both modifiers regardless.
    fireEvent.keyDown(editor.view.dom, { key: 'b', ctrlKey: true });
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(editor.isActive('bold')).toBe(true);
    fireEvent.keyDown(editor.view.dom, { key: 'b', metaKey: true });
    expect(reachedWindow).not.toHaveBeenCalled();

    // Other keys still propagate normally.
    fireEvent.keyDown(editor.view.dom, { key: 'k', metaKey: true });
    expect(reachedWindow).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', reachedWindow);
  });

  it('⌘S flushes the pending save at once', async () => {
    const bodies = putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:14:00.000Z'));
    const { ref } = renderEditor();
    const editor = ref.current!.getEditor()!;
    act(() => editor.commands.insertContent(' now'));
    expect(bodies).toHaveLength(0);
    fireEvent.keyDown(editor.view.dom, { key: 's', metaKey: true });
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('read-only: no toolbar, "Read-only" instead of a save state, and insertCitation is a no-op', () => {
    const bodies = putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:15:00.000Z'));
    const { ref } = renderEditor({ editable: false });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(ref.current!.getEditor()!.isEditable).toBe(false);
    act(() => ref.current!.insertCitation(citation));
    expect(ref.current!.getEditor()!.getText()).toBe('Seed');
    expect(bodies).toHaveLength(0);
  });

  it('insertCitation adds one chip whose link carries the locator and the way back', async () => {
    putStub((body) => savedResponse(body.contentRich, '2026-08-27T09:16:00.000Z'));
    const { ref } = renderEditor();
    act(() => ref.current!.insertCitation(citation));
    const chip = await screen.findByRole('link', { name: 'Open citation: Smith 2023, p. 4' });
    expect(chip).toHaveAttribute('title', 'a quoted line');
    expect(chip.getAttribute('href')).toBe(
      '/spaces/space-1/sources/src-1?cite=cite-1&page=4&from=%2Fspaces%2Fspace-1%2Fnotebook',
    );
    const json = JSON.stringify(ref.current!.getEditor()!.getJSON());
    expect(json).toContain('"type":"citation"');
    expect(json).toContain('"citationId":"cite-1"');
    // Never focused before: the chip went to the end, after the seed text.
    expect(ref.current!.getEditor()!.getText()).toMatch(/^Seed/);
  });
});
