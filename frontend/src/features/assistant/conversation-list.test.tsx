import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import type { ConversationListItem } from '@/lib/api';
import { ConversationList, formatConversationDate } from './conversation-list';

const now = new Date('2026-08-27T15:00:00');
// Pinned: the process locale is not ours to assume on CI.
const locale = 'en-US';

const row = (overrides: Partial<ConversationListItem>): ConversationListItem => ({
  id: 'c1',
  spaceId: 's1',
  title: 'Kế hoạch báo cáo thực tập',
  scopeType: 'space',
  scopeSourceId: null,
  preview: 'ý là tóm tắt thành đoạn như lúc nãy á',
  messageCount: 4,
  createdAt: '2026-07-06T09:00:00',
  updatedAt: '2026-07-06T09:00:00',
  ...overrides,
});

describe('ConversationList', () => {
  /** REQ-169 / REQ-170 — every conversation with a turn is listed and is a link to its thread. */
  it('lists each conversation as a link with title, preview and date', () => {
    renderWithProviders(
      <ConversationList
        spaceId="s1"
        now={now}
        locale={locale}
        conversations={[
          row({ id: 'c1' }),
          row({
            id: 'c2',
            title: 'Quy trình xây dựng mô phỏng',
            preview: 'giải thích',
            scopeType: 'source',
            scopeSourceId: 'src1',
            updatedAt: '2026-04-23T09:00:00',
          }),
        ]}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Chats' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/spaces/s1/assistant/c1');
    expect(links[1]).toHaveAttribute('href', '/spaces/s1/assistant/c2');

    expect(within(links[0]!).getByText('Kế hoạch báo cáo thực tập')).toBeInTheDocument();
    expect(within(links[0]!).getByText('ý là tóm tắt thành đoạn như lúc nãy á')).toBeInTheDocument();
    expect(within(links[0]!).getByText(formatConversationDate('2026-07-06T09:00:00', now, locale))).toBeInTheDocument();

    // REQ-171 — a source-scoped thread says so in the list.
    expect(within(links[1]!).getByText('Source')).toBeInTheDocument();
    expect(within(links[0]!).queryByText('Source')).not.toBeInTheDocument();
  });

  it('hides conversations that have no messages yet', () => {
    renderWithProviders(
      <ConversationList
        spaceId="s1"
        now={now}
        conversations={[
          row({ id: 'empty', title: 'New conversation', preview: null, messageCount: 0 }),
          row({ id: 'c1' }),
        ]}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(screen.queryByText('New conversation')).not.toBeInTheDocument();
  });

  it('shows the empty state when nothing has been asked, and a loading state before that', () => {
    const { unmount } = renderWithProviders(<ConversationList spaceId="s1" conversations={undefined} isPending />);
    expect(screen.getByTestId('conversation-list-loading')).toBeInTheDocument();
    unmount();

    renderWithProviders(<ConversationList spaceId="s1" conversations={[]} />);
    expect(screen.getByRole('heading', { name: 'Ask your sources' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('does not point at a composer in an archived space with no chats', () => {
    renderWithProviders(<ConversationList spaceId="s1" conversations={[]} archived />);
    expect(screen.getByRole('heading', { name: 'No conversations yet' })).toBeInTheDocument();
    expect(screen.queryByText(/Ask a question above/)).not.toBeInTheDocument();
    expect(screen.getByText(/Restore it to ask a question/)).toBeInTheDocument();
  });

  it('shows a plain error when the list failed', () => {
    renderWithProviders(<ConversationList spaceId="s1" conversations={undefined} error={new Error('boom')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('We could not load your conversations.');
  });
});

describe('formatConversationDate', () => {
  it('shows the time today, month and day this year, and the year otherwise', () => {
    expect(formatConversationDate('2026-08-27T09:05:00', now, locale)).toBe('9:05 AM');
    expect(formatConversationDate('2026-07-06T09:00:00', now, locale)).toBe('Jul 6');
    expect(formatConversationDate('2025-04-17T09:00:00', now, locale)).toBe('Apr 17, 2025');
    expect(formatConversationDate('not a date', now, locale)).toBe('');
  });
});
