import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '@/components/ui/dialog';

/**
 * REQ-074, in full. The native <dialog> was passed over because `showModal()`
 * is not implemented consistently in jsdom, which only holds up while every
 * behavior it would have provided is asserted here.
 */
describe('Dialog', () => {
  const open = (onClose = vi.fn()) => {
    render(
      <Dialog open title="Space details" description="Two fields." onClose={onClose}>
        <input aria-label="first" />
        <input aria-label="second" />
        <button type="button">last</button>
      </Dialog>,
    );
    return onClose;
  };

  it('names itself and moves focus to the first control', () => {
    open();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Space details');
    expect(dialog).toHaveAccessibleDescription('Two fields.');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('first')).toHaveFocus();
  });

  it('wraps Tab from the last control back to the first', async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole('button', { name: 'last' }));
    await user.tab();

    // Without the trap, Tab would reach the page behind the dialog.
    expect(screen.getByLabelText('first')).toHaveFocus();
  });

  it('wraps Shift+Tab from the first control to the last', async () => {
    const user = userEvent.setup();
    open();

    expect(screen.getByLabelText('first')).toHaveFocus();
    await user.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = open();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop press but not on a press inside the panel', async () => {
    const user = userEvent.setup();
    const onClose = open();

    await user.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    // The backdrop is the panel's parent; only a press that lands on it closes.
    await user.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [isOpen, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <Dialog open={isOpen} title="Space details" onClose={() => setOpen(false)}>
            <input aria-label="first" />
          </Dialog>
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'open' });

    await user.click(trigger);
    expect(screen.getByLabelText('first')).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('leaves focus alone when the parent re-renders', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick(tick + 1)}>
            refetch
          </button>
          {/* A fresh `onClose` identity on every render, as every real caller does. */}
          <Dialog open title="Space details" onClose={() => setTick(tick + 1)}>
            <input aria-label="first" />
            <input aria-label="second" />
          </Dialog>
        </>
      );
    }

    render(<Harness />);

    const second = screen.getByLabelText('second');
    await user.click(second);
    expect(second).toHaveFocus();

    // A list refetch or mutation state change re-renders the parent mid-typing.
    // `fireEvent` rather than `user.click` because a real refetch does not touch
    // focus at all — focus must stay where the user put it rather than snapping
    // back to the first field.
    fireEvent.click(screen.getByRole('button', { name: 'refetch' }));

    expect(second).toHaveFocus();
    await user.keyboard('typed');
    expect(second).toHaveValue('typed');
  });
});
