import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field, TextareaField } from '@/components/ui/field';

/** REQ-053 — field messages are associated with their input (PRD §18). */
describe('Field', () => {
  it('ties the label to the input with a real <label>', () => {
    render(<Field label="Email" name="email" />);

    // getByLabelText only resolves through a genuine label/for association.
    expect(screen.getByLabelText('Email')).toBe(screen.getByRole('textbox'));
  });

  it('marks an errored input invalid and points at the message', () => {
    render(<Field label="Password" name="password" error="Must be at least 8 characters." />);

    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Must be at least 8 characters.');
  });

  it('describes a hint without claiming the input is invalid', () => {
    render(<Field label="Password" name="password" hint="At least 8 characters." />);

    const input = screen.getByLabelText('Password');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('At least 8 characters.');
  });

  it('announces hint before error, matching the order on screen', () => {
    render(
      <Field
        label="Password"
        name="password"
        hint="At least 8 characters."
        error="Must be at least 8 characters."
      />,
    );

    // Reversing the two would announce the error before the hint the eye reads first.
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'At least 8 characters. Must be at least 8 characters.',
    );
  });

  it('exposes no description when there is neither hint nor error', () => {
    render(<Field label="Email" name="email" />);

    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-describedby');
  });

  it('wires a children control and forwards the component props onto it', () => {
    render(
      <Field label="Source title" name="title" defaultValue="Interview notes">
        <input className="custom-control" />
      </Field>,
    );

    const input = screen.getByLabelText('Source title');
    // The child is the labelled control, and `name`/`defaultValue` reached it —
    // passing both children and props is the contract, not a silent drop.
    expect(input).toHaveClass('custom-control');
    expect(input).toHaveAttribute('name', 'title');
    expect(input).toHaveValue('Interview notes');
  });

  it('paints the error border on a children control, not only aria-invalid', () => {
    render(
      <Field label="Source title" error="Use at most 200 characters.">
        <input className="custom-control" />
      </Field>,
    );

    const input = screen.getByLabelText('Source title');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use at most 200 characters.');
    // An error that is announced but invisible on screen is half a field error.
    expect(input).toHaveClass('border-error');
    // The child keeps its own styling; only the error state is injected.
    expect(input).toHaveClass('custom-control');
  });

});

/** The same contract, on the multi-line control — one shared `FieldFrame`. */
describe('TextareaField', () => {
  it('ties the label to the textarea and keeps the hint/error contract', () => {
    render(
      <TextareaField
        label="Research objective"
        name="objective"
        rows={3}
        hint="Optional."
        error="Use at most 2000 characters."
      />,
    );

    const textarea = screen.getByLabelText('Research objective');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea).toHaveAccessibleDescription('Optional. Use at most 2000 characters.');
  });

  it('exposes no description or invalid state when given neither', () => {
    render(<TextareaField label="Research objective" name="objective" />);

    const textarea = screen.getByLabelText('Research objective');
    expect(textarea).not.toHaveAttribute('aria-describedby');
    expect(textarea).not.toHaveAttribute('aria-invalid');
  });

  it('forwards props and the error border onto a children control, exactly as Field does', () => {
    // Two siblings with one documented contract must not behave differently:
    // an earlier version dropped `...props` on this path and kept them on
    // Field's, which is the drift this test exists to catch.
    render(
      <TextareaField label="Research objective" name="objective" error="Too long.">
        <textarea className="custom-control" />
      </TextareaField>,
    );

    const textarea = screen.getByLabelText('Research objective');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('name', 'objective');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea).toHaveClass('border-error');
    expect(textarea).toHaveClass('custom-control');
  });
});
