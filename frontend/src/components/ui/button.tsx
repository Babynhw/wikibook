import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/** Exported so a <Link> can look like a button without nesting one inside it. */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded font-medium transition-colors disabled:pointer-events-none disabled:opacity-60',
  {
    variants: {
      variant: {
        // DESIGN.md: primary = WikiBookLM Blue on white; secondary = white + 1px slate border.
        primary: 'bg-primary text-on-primary hover:bg-primary-container',
        secondary:
          'border border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-low',
        ghost: 'text-on-surface-variant hover:bg-surface-container-low',
        danger: 'bg-error text-on-error hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-base',
        // A square icon-only button. Added for `SidebarTrigger`, which asks for
        // this exact name; `cva` would otherwise fall through to `md` silently
        // and render a 40px text-sized button around a 16px icon.
        'icon-sm': 'size-8 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    render?: React.ReactElement;
  };

/**
 * `type` defaults to `button`, not HTML's `submit`: an onClick-only button
 * dropped into one of the auth forms would otherwise submit it. Submit buttons
 * say so explicitly.
 *
 * `forwardRef`, because Base UI's menu trigger hands its `render` element a ref
 * and anchors the popup — and returns focus on close — through it. A plain
 * function component dropped that ref with a console warning (PRD §18).
 */
function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', render, children, ...props },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size }), className);

  if (render) {
    // React 18 types: `render` is a `ReactElement<any>`, so `render.props` is
    // untyped and `cloneElement` accepts the merge directly — no cast needed,
    // and the props *are* forwarded (per the review of a version that silently
    // dropped `onClick`, `disabled`, and every other prop on the `render` path).
    //
    // `disabled` is the exception: the rendered element is typically an <a>
    // (a <Link> styled as a button), where `disabled` is not a real attribute —
    // React warns and the link stays clickable. Express it the way a non-button
    // element has to: announced, unfocusable, and inert.
    const { disabled, ...rest } = props;
    // `cloneElement` *replaces* a ref, so the one the caller put on `render`
    // (Base UI's own anchor ref, for one) has to be kept alongside ours.
    const existingRef = (render as React.ReactElement & { ref?: React.Ref<HTMLButtonElement> }).ref;
    return React.cloneElement(render, {
      ref: mergeRefs(ref, existingRef),
      ...rest,
      ...(disabled
        ? {
            'aria-disabled': true,
            tabIndex: -1,
            onClick: (event: React.MouseEvent) => event.preventDefault(),
          }
        : {}),
      className: cn(classes, render.props.className),
      children: render.props.children ?? children,
    });
  }

  return (
    <button ref={ref} type={type} className={classes} {...props}>
      {children}
    </button>
  );
});
