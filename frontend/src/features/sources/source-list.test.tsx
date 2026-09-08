import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Source } from '@/lib/api';
import { SourceList } from '@/features/sources/source-list';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const source = (overrides: Partial<Source> = {}): Source => ({
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
  ...overrides,
});

describe('SourceList', () => {
  /** REQ — the card shows title, kind, author, and date added, and nothing §7 forbids. */
  it('shows what a source is and no processing internals', () => {
    stubFetch(() => jsonResponse({}));
    renderWithProviders(<SourceList sources={[source()]} />);

    expect(screen.getByText('Sleep and memory consolidation')).toBeInTheDocument();
    expect(screen.getByText(/PDF · Walker · added/)).toBeInTheDocument();
    // Ready is the expected state, so it carries no badge.
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    for (const forbidden of [/passage/i, /chunk/i, /embedding/i, /vector/i, /score/i]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }
  });

  /** REQ — PRD §18: every state is icon + text, never color alone. */
  it('badges a processing source with text, not just a color', () => {
    stubFetch(() => jsonResponse({}));
    renderWithProviders(<SourceList sources={[source({ state: 'processing' })]} />);

    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  /** REQ — PRD §6/§16: a failure says why in plain language and offers Retry. */
  it('shows the failure message with a Retry action, and retries the source', async () => {
    const person = userEvent.setup();
    const fetchSpy = stubFetch(() =>
      jsonResponse({ source: source({ state: 'processing', errorMessage: null }) }),
    );
    renderWithProviders(
      <SourceList
        sources={[
          source({ state: 'failed', errorMessage: 'This PDF is password protected.' }),
        ]}
      />,
    );

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('This PDF is password protected.')).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Retry' }));

    await vi.waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([path, init]) => path === '/api/sources/src-1/retry' && init?.method === 'POST',
        ),
      ).toBe(true),
    );
  });

  /** REQ — an archived space is read-only for writes, but deleting stays allowed. */
  /**
   * Delete follows its own rule (shared-spaces-v1 "Three roles"): the owner may
   * delete anything, an editor only what they added, a viewer nothing. The card
   * reads the role from the cached space and the caller from the session.
   */
  const asRole = (myRole: 'owner' | 'editor' | 'viewer', addedById = 'someone-else') =>
    stubFetch((path) => {
      if (path.endsWith('/auth/me')) return jsonResponse({ user: { id: 'me', name: 'Me', email: 'me@example.test' } });
      if (path.endsWith('/spaces/space-1')) {
        return jsonResponse({
          space: {
            id: 'space-1', name: 'S', objective: null, archivedAt: null, lastOpenedAt: null,
            createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z',
            sourceCount: 1, noteCount: 0, myRole, ownerName: 'Owner', memberCount: 2,
          },
        });
      }
      void addedById;
      return new Response(null, { status: 204 });
    });

  it('hides Retry in a read-only space and keeps Delete for the owner', async () => {
    asRole('owner');
    renderWithProviders(
      <SourceList sources={[source({ state: 'failed', errorMessage: 'Failed.' })]} readOnly />,
    );

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('offers Delete to an editor only on their own source, and never to a viewer', async () => {
    asRole('editor');
    const { unmount } = renderWithProviders(
      <SourceList sources={[source({ addedBy: { id: 'someone-else', name: 'Minh' } })]} />,
    );
    expect(await screen.findByText(/added .* by Minh/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    unmount();

    asRole('editor');
    const mine = renderWithProviders(<SourceList sources={[source({ addedBy: { id: 'me', name: 'Me' } })]} />);
    expect(await mine.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(mine.getByText(/added .* by you/)).toBeInTheDocument();
    mine.unmount();

    asRole('viewer');
    renderWithProviders(<SourceList sources={[source({ addedBy: { id: 'me', name: 'Me' } })]} readOnly />);
    await screen.findByText(/added .* by you/);
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
  });

  /** REQ — PRD §6: deleting is permanent, so it is confirmed first. */
  it('requires confirmation before deleting, and cancelling deletes nothing', async () => {
    const person = userEvent.setup();
    const fetchSpy = asRole('owner');
    renderWithProviders(<SourceList sources={[source()]} />);

    await person.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Delete “Sleep and memory consolidation”?');
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(
      fetchSpy.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);

    await person.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    await person.click(screen.getByRole('button', { name: 'Delete' }));
    await person.click(screen.getByRole('button', { name: 'Delete source' }));

    await vi.waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([path, init]) => path === '/api/sources/src-1' && init?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  /** REQ — PRD §17: the original is proxied through the API, never a direct URL. */
  it('links a PDF’s original through the API', () => {
    stubFetch(() => jsonResponse({}));
    renderWithProviders(<SourceList sources={[source()]} />);

    expect(screen.getByRole('link', { name: 'Open the original' })).toHaveAttribute(
      'href',
      '/api/sources/src-1/file',
    );
  });
});
