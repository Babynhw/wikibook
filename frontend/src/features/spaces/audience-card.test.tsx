import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Space } from '@/lib/api';
import { AudienceCard } from './audience-card';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

/**
 * The "Audience & style" card (wiki-docs/plan/space-audience-style).
 *
 * Owner writes, every role reads, and the card says plainly what it does not do —
 * the sentence that stops it being mistaken for a content restriction, which is
 * the one thing this design refuses to be.
 */
const space = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
  name: 'Grade 8 climate unit',
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
  memberCount: 2,
  ...overrides,
});

describe('audience & style card', () => {
  it('lets the owner write a note, and counts against the configured cap', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch((path, init) => {
      if (path.endsWith('/spaces/space-1/audience') && init?.method === 'PUT') {
        return jsonResponse({ space: space({ audienceInstruction: 'Vietnamese, plain words.' }) });
      }
      return jsonResponse({ spaces: [] });
    });

    renderWithProviders(<AudienceCard space={space({ audienceInstructionMaxChars: 40 })} />);

    const field = screen.getByLabelText('Who are these answers for?');
    await user.type(field, 'Vietnamese, plain words.');
    expect(screen.getByText('24 / 40')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([path]) => String(path).endsWith('/audience'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ audience: 'Vietnamese, plain words.' });
    });
  });

  it('refuses to submit over the cap, and says so before the server has to', async () => {
    const user = userEvent.setup();
    stubFetch(() => jsonResponse({ spaces: [] }));
    renderWithProviders(<AudienceCard space={space({ audienceInstructionMaxChars: 10 })} />);

    await user.type(screen.getByLabelText('Who are these answers for?'), 'far too long a note');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders the note read-only for an editor, with no way to change it', () => {
    renderWithProviders(
      <AudienceCard space={space({ myRole: 'editor', audienceInstruction: 'Plain English.' })} />,
    );

    expect(screen.getByText('Plain English.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('Who are these answers for?')).toBeNull();
  });

  it('renders nothing for a viewer when no note is set', () => {
    const { container } = renderWithProviders(<AudienceCard space={space({ myRole: 'viewer' })} />);
    // An empty labelled box on every space that never uses this would be a
    // standing invitation to fill it in.
    expect(container).toBeEmptyDOMElement();
  });

  it('is read-only in an archived space, for the owner too (REQ-065)', () => {
    renderWithProviders(
      <AudienceCard space={space({ archivedAt: '2026-08-02T10:00:00.000Z', audienceInstruction: 'Plain English.' })} />,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('says what it does not do, so it is not mistaken for a content restriction', () => {
    renderWithProviders(<AudienceCard space={space()} />);
    expect(
      screen.getByText(/does not limit what members can read/i),
    ).toBeInTheDocument();
  });

  it('renders the server’s field message when the cap is refused server-side', async () => {
    const user = userEvent.setup();
    stubFetch((path, init) => {
      if (path.endsWith('/spaces/space-1/audience') && init?.method === 'PUT') {
        return jsonResponse(
          {
            error: {
              message: 'Use at most 20 characters.',
              code: 'bad_request',
              fields: { audience: 'Use at most 20 characters.' },
            },
          },
          400,
        );
      }
      return jsonResponse({ spaces: [] });
    });

    // The client cap is what the *server* reported; a stale one is why the
    // server's message has to render rather than being assumed unreachable.
    renderWithProviders(<AudienceCard space={space({ audienceInstructionMaxChars: 300 })} />);
    await user.type(screen.getByLabelText('Who are these answers for?'), 'a longer note than allowed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Beside the field, not only at the top of the form (PRD §16).
    expect(await screen.findByText('Use at most 20 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('Who are these answers for?')).toHaveValue('a longer note than allowed');
  });
});
