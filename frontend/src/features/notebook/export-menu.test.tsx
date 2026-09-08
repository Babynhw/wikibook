import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';
import { ExportMenu } from './export-menu';

const markdown = (status = 200) =>
  new Response('# Space\n\nhello\n', { status, headers: { 'content-type': 'text/markdown; charset=utf-8' } });

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Xuất' }));
  return screen.findByRole('menuitem', { name: /Sao chép vào bộ nhớ tạm/ });
}

describe('ExportMenu (Phase 6, PRD §14, §16)', () => {
  it('offers the three outputs; download and print point where they should', async () => {
    stubFetch(() => markdown());
    renderWithProviders(<ExportMenu spaceId="space-1" />);
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /Tải xuống/ })).toHaveAttribute(
      'href',
      '/api/spaces/space-1/notebook/export.md',
    );
    expect(screen.getByRole('menuitem', { name: /In/ })).toHaveAttribute('href', '/spaces/space-1/notebook/print');
  });

  it('copies the server Markdown to the clipboard and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    stubFetch((path) => (path.endsWith('/notebook/export.md') ? markdown() : jsonResponse({}, 404)));
    renderWithProviders(<ExportMenu spaceId="space-1" />);
    fireEvent.click(await openMenu());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Space\n\nhello\n'));
    expect(await screen.findByText('Đã sao chép')).toBeInTheDocument();
  });

  it('a failed copy shows the envelope message with Retry, and Retry copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: { code: 'internal_error', message: 'Something went wrong on our side.' } }, 500)
        : markdown();
    });
    renderWithProviders(<ExportMenu spaceId="space-1" />);
    fireEvent.click(await openMenu());
    expect(await screen.findByText('Something went wrong on our side.')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Thử lại' })).not.toBeInTheDocument());
  });

  it('a clipboard the browser refuses is a failure state too, not a silent nothing', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
    });
    stubFetch(() => markdown());
    renderWithProviders(<ExportMenu spaceId="space-1" />);
    fireEvent.click(await openMenu());
    expect(await screen.findByText(/could not be copied/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });
});
