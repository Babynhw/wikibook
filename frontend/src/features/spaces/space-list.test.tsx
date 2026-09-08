import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Space } from '@/lib/api';
import { SpaceList } from '@/features/spaces/space-list';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const space = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
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

describe('SpaceList', () => {
  /** REQ-072 — the most recently opened space is marked, not redirected to. */
  it('marks the first opened space as the one to resume', () => {
    renderWithProviders(
      <SpaceList
        spaces={[
          space({ id: 'a', name: 'Opened recently', lastOpenedAt: '2026-08-10T10:00:00.000Z' }),
          space({ id: 'b', name: 'Never opened' }),
        ]}
      />,
    );

    // The list arrives already ordered by the API; only one card is the resume card.
    expect(screen.getAllByText('Resume')).toHaveLength(1);
    const [resumeCard] = screen.getAllByRole('listitem');
    expect(resumeCard).toHaveTextContent('Opened recently');
    expect(resumeCard).toHaveTextContent('Resume');
  });

  /** REQ-075 — archiving asks first, and the copy says nothing is deleted. */
  it('asks before archiving and states that nothing is deleted', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    stubFetch((path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return jsonResponse({ space: space({ archivedAt: '2026-08-11T10:00:00.000Z' }) });
    });

    renderWithProviders(<SpaceList spaces={[space()]} />);

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/sources, notes, conversations, and notebook are kept/i);
    expect(calls).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Archive space' }));
    await waitFor(() => expect(calls).toContain('POST /api/spaces/space-1/archive'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  /** REQ-073 — a failed submit keeps what was typed and explains the failure. */
  it('keeps the edited name when saving fails', async () => {
    const user = userEvent.setup();
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'space_archived', message: 'This space is archived.' } },
        409,
      ),
    );

    renderWithProviders(<SpaceList spaces={[space()]} />);

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'A better name');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This space is archived.');
    // The dialog stays open with the typed value intact — retyping is not a retry.
    expect(screen.getByLabelText('Name')).toHaveValue('A better name');
  });

  /** REQ-073 — restore has no dialog, so its failure has to report on the card. */
  it('explains a failed restore instead of doing nothing', async () => {
    const user = userEvent.setup();
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'not_found', message: 'We could not find that.' } },
        404,
      ),
    );

    renderWithProviders(
      <SpaceList spaces={[space({ archivedAt: '2026-08-11T10:00:00.000Z' })]} />,
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    // Silence here would read as "restore did nothing" — the card still archived,
    // the button live again, and no reason given (PRD §16).
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not find that.');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  /** REQ-065 — an archived space offers restore, not the writes it would reject. */
  it('offers only restore for an archived space', () => {
    renderWithProviders(
      <SpaceList spaces={[space({ archivedAt: '2026-08-11T10:00:00.000Z' })]} />,
    );

    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
  });
});
