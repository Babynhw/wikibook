import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

interface FieldFrameProps {
  label: string;
  /** Field-level message; wires aria-describedby and aria-invalid (PRD §18). */
  error?: string | undefined;
  hint?: ReactNode;
  /**
   * A render function, always. Cloning a caller's control is `cloneControl`'s
   * job — one clone path, so the error border and `...props` cannot be applied
   * on one route and dropped on the other.
   */
  children: (props: FieldRenderProps) => ReactNode;
}

/** What a FieldFrame injects into its control (id + accessibility wiring). */
type FieldRenderProps = {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
};

/** Label, hint, and error markup shared by every control below. */
function FieldFrame({ label, error, hint, children }: FieldFrameProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  // Listed in DOM order, so the announcement matches what the eye reads: the
  // hint above the inline error, exactly as they are rendered below.
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  const ariaProps = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
  } as const;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-on-surface">
        {label}
      </label>
      {children(ariaProps)}
      {hint ? (
        <p id={hintId} className="text-sm text-on-surface-variant">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-on-error-container">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const controlClasses = (error: string | undefined, className: string | undefined) =>
  cn(
    'rounded border bg-surface-container-lowest px-3 text-base text-on-surface',
    'placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30',
    error ? 'border-error focus:border-error' : 'border-outline-variant focus:border-primary',
    className,
  );

/**
 * Clones a caller-supplied control with the field's wiring.
 *
 * A `children` control brings its own look — that is why it was passed instead
 * of using the built-in one — so only the *error* state is injected, appended
 * last so it wins the border. An error that is announced by `aria-invalid` but
 * invisible on screen is half a field error (PRD §16/§18).
 */
function cloneControl(
  children: ReactNode,
  aria: FieldRenderProps,
  props: Record<string, unknown>,
  error: string | undefined,
  className: string | undefined,
  who: string,
): ReactNode {
  if (!isValidElement<{ className?: string }>(children)) {
    throw new Error(`${who} children must be a single element.`);
  }
  return cloneElement(children, {
    ...aria,
    ...props,
    className: cn(children.props.className, className, error ? 'border-error focus:border-error' : ''),
  });
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children?: ReactNode;
}

/**
 * Labelled text input. The label is always a real <label> tied to the input —
 * placeholder-only fields are not accessible.
 *
 * When `children` is a single element (an `<Input>`, a `<textarea>`, anything),
 * it is cloned with the id/aria wiring, the component's own `...props`
 * (value, onChange, name, …), and the error border — passing both children and
 * props is the point, not a silent drop. Any other child — a string, a
 * fragment, an array — is a programming error and is refused loudly rather than
 * rendered unlabelled.
 */
export function Field({ label, error, hint, className, children, ...props }: FieldProps) {
  return (
    <FieldFrame label={label} error={error} hint={hint}>
      {(aria) =>
        children ? (
          cloneControl(children, aria, props, error, className, 'Field')
        ) : (
          <input {...aria} {...props} className={controlClasses(error, cn('h-10', className))} />
        )
      }
    </FieldFrame>
  );
}

interface TextareaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children?: ReactNode;
}

/**
 * The same contract as `Field` for multi-line input (a research objective) —
 * including the `children` path, which forwards `...props` and the error border
 * exactly as `Field` does. Two siblings with one documented contract must not
 * behave differently.
 */
export function TextareaField({
  label,
  error,
  hint,
  className,
  children,
  ...props
}: TextareaFieldProps) {
  return (
    <FieldFrame label={label} error={error} hint={hint}>
      {(aria) =>
        children ? (
          cloneControl(children, aria, props, error, className, 'TextareaField')
        ) : (
          <textarea {...aria} {...props} className={controlClasses(error, cn('py-2', className))} />
        )
      }
    </FieldFrame>
  );
}
