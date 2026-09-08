import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PassageLocation, SourceBlock, SourceDetail, Space } from '@/lib/api';
import { SourcePage } from '@/routes/source-page';
import { safeReturnPath } from '@/features/reader/source-reader';
import { ReaderHeader } from '@/features/reader/reader-header';
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
  sourceCount: 1,
  noteCount: 0,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
  ...overrides,
});

const detail = (overrides: Partial<SourceDetail> = {}): SourceDetail => ({
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
  blockCount: 6,
  pageCount: 3,
  ...overrides,
});

const pageBlocks = (page: number): SourceBlock[] => [
  { ord: page * 2 - 1, text: `Page ${page}, first paragraph.`, page, paragraphIndex: null, heading: null },
  { ord: page * 2, text: `Page ${page}, second paragraph.`, page, paragraphIndex: null, heading: null },
];

const passage = (overrides: Partial<PassageLocation> = {}): PassageLocation => ({
  id: 'psg-1',
  sourceId: 'src-1',
  ord: 2,
  page: 2,
  paragraphRef: null,
  sectionHeading: null,
  startBlockOrd: 3,
  endBlockOrd: 3,
  ...overrides,
});

interface ReaderStub {
  source?: SourceDetail;
  passage?: PassageLocation | 'missing';
  blocks?: (params: URLSearchParams) => SourceBlock[];
  spaceRow?: Space;
}

function renderReader(url: string, stub: ReaderStub = {}) {
  const calls: string[] = [];
  stubFetch((path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (path.startsWith('/api/passages/')) {
      if (stub.passage === 'missing' || stub.passage === undefined) {
        return jsonResponse({ error: { code: 'not_found', message: 'Not found.' } }, 404);
      }
      return jsonResponse({ passage: stub.passage });
    }
    if (path.includes('/blocks')) {
      const params = new URL(path, 'http://localhost').searchParams;
      const blocks = stub.blocks
        ? stub.blocks(params)
        : pageBlocks(Number(params.get('page') ?? 1));
      return jsonResponse({ blocks });
    }
    if (path.startsWith('/api/sources/')) return jsonResponse({ source: stub.source ?? detail() });
    if (path.startsWith('/api/spaces/')) return jsonResponse({ space: stub.spaceRow ?? space() });
    return jsonResponse({});
  });

  const result = renderWithProviders(
    <Routes>
      <Route path="/spaces/:spaceId/sources/:id" element={<SourcePage />} />
    </Routes>,
    { routerProps: { initialEntries: [url] } },
  );
  return { ...result, calls };
}

const citedBlock = () => document.querySelector('[data-cited="true"]');

describe('SourceReader', () => {
  it('shows PRD §8’s metadata and a link to the original', async () => {
    renderReader('/spaces/space-1/sources/src-1');

    expect(
      await screen.findByRole('heading', { name: 'Sleep and memory consolidation' }),
    ).toBeInTheDocument();
    // PRD §8's metadata, as the source_detail wireframe's header: a type chip, the
    // author, when it was added, and the page count.
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('Walker')).toBeInTheDocument();
    expect(screen.getByText(/Added/)).toBeInTheDocument();
    expect(screen.getByText('3 pages')).toBeInTheDocument();
    // The visible label is the accessible name (WCAG 2.5.3).
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/sources/src-1/file',
    );
    expect(await screen.findByText('Page 1, first paragraph.')).toBeInTheDocument();
  });

  it('opens the page a passage lives on and highlights exactly its blocks', async () => {
    renderReader('/spaces/space-1/sources/src-1?passage=psg-1', { passage: passage() });

    // The passage's own page wins over the first page: a deep link opens where the
    // citation points, not at the top.
    expect(await screen.findByText('Page 2, first paragraph.')).toBeInTheDocument();
    await waitFor(() => expect(citedBlock()).not.toBeNull());
    expect(citedBlock()).toHaveTextContent('Page 2, first paragraph.');
    // Block 4 is on the same page and is not part of the range.
    expect(document.querySelectorAll('[data-cited="true"]')).toHaveLength(1);
    // §8: the reference is displayed, not merely honoured.
    expect(screen.getByText(/Showing the cited passage/)).toHaveTextContent('page 2');
    // The highlight is legible without colour (§18).
    expect(screen.getByText(/Cited passage/)).toBeInTheDocument();
  });

  it('falls back to the page in the link when there is no passage to resolve', async () => {
    renderReader('/spaces/space-1/sources/src-1?page=3');

    expect(await screen.findByText('Page 3, first paragraph.')).toBeInTheDocument();
    // Nothing is highlighted: the link named a page, not a passage.
    expect(citedBlock()).toBeNull();
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();
    // And it does not claim otherwise: "the cited passage" is reserved for a
    // resolved block range, so a page-only link says only where it landed.
    expect(screen.getByText('Showing page 3')).toBeInTheDocument();
    expect(screen.queryByText(/Showing the cited passage/)).not.toBeInTheDocument();
  });

  it('drops the reference once the reader is no longer on the target', async () => {
    renderReader('/spaces/space-1/sources/src-1?passage=psg-1', { passage: passage() });

    expect(await screen.findByText('Page 2, first paragraph.')).toBeInTheDocument();
    expect(screen.getByText(/Showing the cited passage/)).toHaveTextContent('page 2');

    // Paging away leaves the citation behind; a banner still naming page 2 would
    // point at text that is no longer on screen.
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 3, first paragraph.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/Showing the cited passage/)).not.toBeInTheDocument(),
    );

    // Coming back restores it: the target never moved, only the view did.
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('Page 2, first paragraph.')).toBeInTheDocument();
    expect(screen.getByText(/Showing the cited passage/)).toHaveTextContent('page 2');
  });

  it('says the cited location is gone rather than highlighting the wrong thing', async () => {
    renderReader('/spaces/space-1/sources/src-1?passage=psg-gone', { passage: 'missing' });

    expect(await screen.findByText(/cited location is no longer available/i)).toBeInTheDocument();
    expect(citedBlock()).toBeNull();
    // The source itself still reads.
    expect(await screen.findByText('Page 1, first paragraph.')).toBeInTheDocument();
  });

  it('navigates by page and asks the API for that page', async () => {
    const { calls } = renderReader('/spaces/space-1/sources/src-1');
    await screen.findByText('Page 1, first paragraph.');

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('Page 2, first paragraph.')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.includes('/blocks?page=2'))).toBe(true));

    // A typed page beyond the end is clamped to the last one, not rejected.
    await userEvent.clear(screen.getByRole('spinbutton', { name: /page/i }));
    // Enter submits the field — there is no visible "Go" (source_detail wireframe).
    await userEvent.type(screen.getByRole('spinbutton', { name: /page/i }), '99{enter}');
    expect(await screen.findByText('Page 3, first paragraph.')).toBeInTheDocument();
  });

  it('renders a heading block as a heading and the rest as reading paragraphs', async () => {
    renderReader('/spaces/space-1/sources/src-1', {
      blocks: () => [
        { ord: 1, text: 'Early years', page: 1, paragraphIndex: null, heading: 'Early years' },
        { ord: 2, text: 'Born in Ulm, in 1879.', page: 1, paragraphIndex: null, heading: 'Early years' },
      ],
    });

    // A block whose nearest heading is its own text *is* the heading.
    const heading = await screen.findByRole('heading', { level: 2, name: 'Early years' });
    expect(heading).toHaveAttribute('data-ord', '1');
    const body = screen.getByText('Born in Ulm, in 1879.');
    expect(body.tagName).toBe('P');
    expect(body).toHaveAttribute('data-ord', '2');
  });

  it('keeps Archive and Delete behind the overflow menu', async () => {
    renderReader('/spaces/space-1/sources/src-1');
    await screen.findByText('Page 1, first paragraph.');

    // The wireframe's header row is `Edit details · Download · ⋮`.
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps only the original link when a host hides the actions', () => {
    renderWithProviders(
      <ReaderHeader source={detail()} readOnly={false} hideActions onDeleted={() => {}} />,
    );

    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('compact (assistant pane): one row with every §8 field and an icon-only original link', () => {
    const source = detail({ author: 'A. Author', pageCount: 12 });
    renderWithProviders(
      <ReaderHeader source={source} readOnly={false} variant="compact" onDeleted={() => {}} />,
    );

    // The knowledge_assistant wireframe's pane header: title over one metadata line.
    expect(screen.getByRole('heading', { level: 1, name: source.title })).toBeInTheDocument();
    const meta = screen.getByText(/Added/);
    expect(meta).toHaveTextContent('A. Author');
    expect(meta).toHaveTextContent('12 pages');
    // Truncated text stays recoverable on hover.
    expect(meta).toHaveAttribute('title', meta.textContent);
    // The type is an icon, still announced.
    expect(screen.getByText('PDF')).toBeInTheDocument();

    // The original link keeps its full-variant name (REQ-141) with no visible text.
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', `/api/sources/${source.id}/file`);
    expect(link).toHaveTextContent('');

    // Compact implies hideActions.
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('compact (assistant pane): a web source shows its host and opens the original', () => {
    const source = detail({
      type: 'web',
      url: 'https://vi.wikipedia.org/wiki/Cuba',
      pageCount: null,
    });
    renderWithProviders(
      <ReaderHeader source={source} readOnly={false} variant="compact" onDeleted={() => {}} />,
    );

    expect(screen.getByText(/Added/)).toHaveTextContent('vi.wikipedia.org');
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute(
      'href',
      'https://vi.wikipedia.org/wiki/Cuba',
    );
    expect(screen.getByText('Web link')).toBeInTheDocument();
  });

  it('has no duplicate way back: the breadcrumb leads to the space', async () => {
    renderReader('/spaces/space-1/sources/src-1');
    await screen.findByText('Page 1, first paragraph.');

    expect(screen.queryByRole('link', { name: /Back to the space/i })).not.toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs).toHaveTextContent('Library');
    expect(crumbs).toHaveTextContent('Sleep and memory');
  });

  it('has no page navigation for a source without page data', async () => {
    renderReader('/spaces/space-1/sources/src-1', {
      source: detail({ type: 'manual', pageCount: null, blockCount: 2 }),
      blocks: () => [
        { ord: 1, text: 'Typed paragraph one.', page: null, paragraphIndex: 1, heading: null },
        { ord: 2, text: 'Typed paragraph two.', page: null, paragraphIndex: 2, heading: null },
      ],
    });

    expect(await screen.findByText('Typed paragraph one.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('loads the window containing a deep-linked paragraph, not the first one', async () => {
    const { calls } = renderReader('/spaces/space-1/sources/src-1?passage=psg-late', {
      source: detail({ type: 'manual', pageCount: null, blockCount: 400 }),
      passage: passage({ id: 'psg-late', page: null, paragraphRef: 'p200', startBlockOrd: 200, endBlockOrd: 201 }),
      blocks: (params) => {
        const from = Number(params.get('from') ?? 1);
        return [
          { ord: from, text: `Paragraph ${from}.`, page: null, paragraphIndex: from, heading: null },
        ];
      },
    });

    // Window size is 120, so block 200 sits in the window starting at 121.
    await waitFor(() => expect(calls.some((call) => call.includes('from=121'))).toBe(true));
    expect(calls.some((call) => call.includes('from=1&'))).toBe(false);
  });

  it('renders the back control only for an in-app path', async () => {
    renderReader('/spaces/space-1/sources/src-1?from=%2Fspaces%2Fspace-1%3Ftab%3Dnotes');
    expect(await screen.findByRole('link', { name: /Back to the answer/i })).toBeInTheDocument();
  });

  it('ignores an off-site return path', async () => {
    renderReader('/spaces/space-1/sources/src-1?from=https%3A%2F%2Fevil.example');
    await screen.findByRole('heading', { name: 'Sleep and memory consolidation' });
    expect(screen.queryByRole('link', { name: /Back to the answer/i })).not.toBeInTheDocument();

    // A protocol-relative URL is not a path either — this is the check that would
    // otherwise be an open redirect.
    expect(safeReturnPath('//evil.example')).toBeNull();
    expect(safeReturnPath('/\\evil.example')).toBeNull();
    expect(safeReturnPath('https://evil.example')).toBeNull();
    expect(safeReturnPath('/spaces/space-1')).toBe('/spaces/space-1');
  });

  it('explains a processing source and offers Retry on a failed one', async () => {
    const { unmount } = renderReader('/spaces/space-1/sources/src-1', {
      source: detail({ state: 'processing', blockCount: 0, pageCount: null }),
      blocks: () => [],
    });
    expect(await screen.findByText(/still being processed/i)).toBeInTheDocument();
    unmount();

    renderReader('/spaces/space-1/sources/src-1', {
      source: detail({
        state: 'failed',
        errorMessage: 'This PDF is password protected.',
        blockCount: 0,
        pageCount: null,
      }),
      blocks: () => [],
    });
    expect(await screen.findByText('This PDF is password protected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('says an archived source is excluded from answers, and still reads', async () => {
    renderReader('/spaces/space-1/sources/src-1', {
      source: detail({ archivedAt: '2026-08-12T12:00:00.000Z' }),
    });

    expect(await screen.findByText(/will not use it as evidence/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(await screen.findByText('Page 1, first paragraph.')).toBeInTheDocument();
    // Archiving is not offered twice — not even in the overflow menu.
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('hides write actions in an archived space, and keeps reading', async () => {
    renderReader('/spaces/space-1/sources/src-1', {
      spaceRow: space({ archivedAt: '2026-08-12T12:00:00.000Z' }),
    });

    expect(await screen.findByText('Page 1, first paragraph.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument(),
    );
    // Delete is still offered — an archived space is frozen, not a trap.
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('never writes to the source while reading it', async () => {
    const { calls } = renderReader('/spaces/space-1/sources/src-1?passage=psg-1', {
      passage: passage(),
    });
    await screen.findByText('Page 2, first paragraph.');

    // §8: citation navigation does not alter the source. No POST, PATCH, or DELETE
    // leaves the reader on its own.
    expect(calls.filter((call) => !call.startsWith('GET '))).toEqual([]);
  });
});
