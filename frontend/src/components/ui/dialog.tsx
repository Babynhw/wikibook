import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Modal dialog: focus moves in on open and back to the trigger on close, Tab
 * cycles inside, Escape and a backdrop click dismiss (PRD §18).
 *
 * Hand-written rather than the native <dialog>: `showModal()` is not implemented
 * consistently in jsdom, and every one of these behaviors is asserted in
 * `dialog.test.tsx` — that suite is what justifies not using the platform.
 */
export function Dialog({ open, title, description, onClose, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = `${titleId}-description`;

  // Read through a ref, so the listener always calls the current `onClose`
  // without making the focus effect below depend on its identity.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * Focus moves in once per opening and back out on close. Keyed on `open`
   * alone: callers pass an inline `onClose`, so depending on it would re-run
   * this on every parent render and yank focus back to the first field while
   * the user is typing in a later one.
   */
  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => previouslyFocused?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      // Wrap at both ends so Tab never reaches the page behind the dialog.
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40 p-4"
      // mousedown, not click: releasing a drag that started inside the panel
      // would otherwise close the dialog the user is typing in.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="w-full max-w-lg rounded-lg border border-outline-variant bg-surface-container-lowest p-6"
      >
        <h2 id={titleId} className="text-lg font-semibold text-on-surface">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="mt-1 text-sm text-on-surface-variant">
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
