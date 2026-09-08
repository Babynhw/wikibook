import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Alert } from '@/components/ui/alert';

/**
 * REQ-053 — a failure interrupts (assertive), a confirmation waits its turn
 * (polite). The distinction is the whole reason `variant` exists.
 */
describe('Alert', () => {
  it('announces a failure assertively by default', () => {
    render(<Alert>Sign-in failed.</Alert>);

    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed.');
  });

  it('announces a confirmation politely', () => {
    render(<Alert variant="info">Your password has been changed.</Alert>);

    expect(screen.getByRole('status')).toHaveTextContent('Your password has been changed.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
