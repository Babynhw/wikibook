import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddSourceDialog } from '@/features/sources/add-source-dialog';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const sourceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'src-1',
  spaceId: 'space-1',
  type: 'manual',
  title: 'A pasted excerpt',
  author: null,
  url: null,
  state: 'processing',
  errorMessage: null,
  createdAt: '2026-08-12T10:00:00.000Z',
  updatedAt: '2026-08-12T10:00:00.000Z',
  ...overrides,
});

function renderDialog(handler: Parameters<typeof stubFetch>[0]) {
  const onClose = vi.fn();
  const fetchSpy = stubFetch(handler);
  const result = renderWithProviders(<AddSourceDialog spaceId="space-1" onClose={onClose} />);
  return { ...result, onClose, fetchSpy };
}

const writes = (fetchSpy: ReturnType<typeof stubFetch>) =>
  fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('AddSourceDialog', () => {
  /** REQ — one dialog, three tabs; §5.3 forbids separate entry points per kind. */
  it('offers PDF, web link, and text as tabs of a single dialog', () => {
    renderDialog(() => jsonResponse({ source: sourceRow() }, 201));

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['PDF', 'Web link', 'Text']);
    expect(screen.getByRole('tab', { name: 'PDF' })).toHaveAttribute('aria-selected', 'true');
  });

  /** REQ — client-side validation mirrors the server and blocks the request. */
  it('rejects a missing and a malformed web address without calling the API', async () => {
    const person = userEvent.setup();
    const { fetchSpy } = renderDialog(() => jsonResponse({ source: sourceRow() }, 201));

    await person.click(screen.getByRole('tab', { name: 'Web link' }));
    await person.click(screen.getByRole('button', { name: 'Add source' }));
    expect(await screen.findByText('Enter a web address.')).toBeInTheDocument();

    await person.type(screen.getByRole('textbox', { name: 'Web address' }), 'not a web address');
    await person.click(screen.getByRole('button', { name: 'Add source' }));
    expect(await screen.findByText('Enter a valid web address.')).toBeInTheDocument();

    await person.clear(screen.getByRole('textbox', { name: 'Web address' }));
    await person.type(screen.getByRole('textbox', { name: 'Web address' }), 'ftp://files.example.com/paper.pdf');
    await person.click(screen.getByRole('button', { name: 'Add source' }));
    expect(
      await screen.findByText('Only http:// and https:// web addresses can be added.'),
    ).toBeInTheDocument();

    expect(writes(fetchSpy)).toHaveLength(0);
  });

  /** REQ — a text source needs a title and content; both messages name the field. */
  it('requires a title and content on the text tab, then submits what was entered', async () => {
    const person = userEvent.setup();
    const { fetchSpy, onClose } = renderDialog(() => jsonResponse({ source: sourceRow() }, 201));

    await person.click(screen.getByRole('tab', { name: 'Text' }));
    await person.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('Give this text a title.')).toBeInTheDocument();
    expect(screen.getByText('Add some text to make into a source.')).toBeInTheDocument();
    expect(writes(fetchSpy)).toHaveLength(0);

    await person.type(screen.getByRole('textbox', { name: 'Title' }), 'A pasted excerpt');
    await person.type(screen.getByRole('textbox', { name: 'Text' }), 'Memory is consolidated during sleep.');
    await person.type(screen.getByRole('textbox', { name: 'Author' }), 'Walker');
    await person.click(screen.getByRole('button', { name: 'Add source' }));

    const [path, init] = writes(fetchSpy)[0]!;
    expect(path).toBe('/api/spaces/space-1/sources');
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'manual',
      title: 'A pasted excerpt',
      content: 'Memory is consolidated during sleep.',
      author: 'Walker',
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  /** REQ — PRD §16: a rejected submit keeps the input and reports on the field. */
  it('keeps what was typed when the server rejects the source', async () => {
    const person = userEvent.setup();
    const { onClose } = renderDialog(() =>
      jsonResponse(
        {
          error: {
            code: 'manual_too_long',
            message: 'Text is limited to 50000 characters.',
            fields: { content: 'Text is limited to 50000 characters.' },
          },
        },
        400,
      ),
    );

    await person.click(screen.getByRole('tab', { name: 'Text' }));
    await person.type(screen.getByRole('textbox', { name: 'Title' }), 'Long excerpt');
    await person.type(screen.getByRole('textbox', { name: 'Text' }), 'Every word of this must survive.');
    await person.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('Text is limited to 50000 characters.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Long excerpt');
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveValue('Every word of this must survive.');
    expect(onClose).not.toHaveBeenCalled();
  });

  /** REQ — the input survives a tab switch too: nothing is retyped after a look. */
  it('preserves each tab’s input across a switch away and back', async () => {
    const person = userEvent.setup();
    renderDialog(() => jsonResponse({ source: sourceRow() }, 201));

    await person.click(screen.getByRole('tab', { name: 'Web link' }));
    await person.type(screen.getByRole('textbox', { name: 'Web address' }), 'https://example.com/article');
    await person.click(screen.getByRole('tab', { name: 'Text' }));
    await person.type(screen.getByRole('textbox', { name: 'Title' }), 'Kept');
    await person.click(screen.getByRole('tab', { name: 'Web link' }));

    expect(screen.getByRole('textbox', { name: 'Web address' })).toHaveValue('https://example.com/article');
    await person.click(screen.getByRole('tab', { name: 'Text' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Kept');
  });

  /** REQ — PDF only, and the file input is a real one behind its label (§18). */
  it('accepts a PDF, refuses anything else, and asks for a file when none is chosen', async () => {
    const person = userEvent.setup();
    const { fetchSpy } = renderDialog(() =>
      jsonResponse({ source: sourceRow({ type: 'pdf', title: 'paper' }) }, 201),
    );

    await person.click(screen.getByRole('button', { name: 'Add source' }));
    expect(await screen.findByText('Choose a PDF file.')).toBeInTheDocument();
    expect(writes(fetchSpy)).toHaveLength(0);

    // The picker filters by `accept`, but a drop does not — so the guard is what
    // stops a dragged-in .txt, and that is the path worth asserting.
    const dropZone = screen.getByText(/drop one here/i).parentElement!;
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });
    expect(await screen.findByText('Only PDF files can be uploaded.')).toBeInTheDocument();
    expect(writes(fetchSpy)).toHaveLength(0);

    const input = screen.getByLabelText('Choose a PDF');
    await person.upload(input, new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('paper.pdf')).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Add source' }));

    const [path, init] = writes(fetchSpy)[0]!;
    expect(path).toBe('/api/spaces/space-1/sources/upload');
    // Multipart, and the browser writes the content-type with its boundary.
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });
});
