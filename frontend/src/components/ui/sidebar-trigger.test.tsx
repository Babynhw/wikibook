import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

describe('SidebarTrigger', () => {
  // The header expand/collapse control. The mobile hook stubs desktop by
  // default, so this exercises the rail path: expanded shows a collapse
  // affordance; collapsing and re-expanding flip the label and announced state.
  it('collapses then re-expands, keeping label and aria-expanded truthful', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    await user.click(collapse);
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');

    await user.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  // Navigating between space routes unmounts one page's `AppShell` and mounts
  // another, and `AppShell` owns the provider — so the collapsed state would be
  // lost unless the provider restores it from the cookie it persists to.
  it('restores a persisted collapsed state from the cookie on a fresh mount', () => {
    document.cookie = 'sidebar_state=false; path=/; max-age=3600';

    renderWithProviders(
      <SidebarProvider defaultOpen={true}>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    document.cookie = 'sidebar_state=; path=/; max-age=0';
  });
});
