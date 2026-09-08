import { useState } from 'react';
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Undo2,
} from 'lucide-react';
import { useEditorState, type Editor } from '@tiptap/react';
import { cn } from '@/lib/utils';
import { LinkDialog } from './link-dialog';

/**
 * One sticky row of real buttons (PRD §18): each has an accessible name, and
 * the toggles carry `aria-pressed` so their state is not colour alone. No
 * bubble menu — a menu that appears on selection is invisible to a keyboard
 * user until the selection exists.
 */
function ToolbarButton({
  label,
  pressed,
  onClick,
  disabled,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      // `onMouseDown` preventDefault keeps the editor's selection: a click that
      // moved focus to the button first would collapse it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded text-on-surface-variant',
        'hover:bg-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'disabled:opacity-40 disabled:hover:bg-transparent',
        pressed && 'bg-primary-container text-on-primary-container hover:bg-primary-container',
      )}
    >
      {children}
    </button>
  );
}

export function Toolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
    }),
  });
  const icon = 'size-4';

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-16 z-10 -mx-1 flex flex-wrap items-center gap-0.5 border-b border-outline-variant bg-surface/95 px-1 py-1.5 backdrop-blur"
    >
      <ToolbarButton label="Heading 1" pressed={active.h1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 className={icon} aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="Heading 2" pressed={active.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className={icon} aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="Heading 3" pressed={active.h3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 className={icon} aria-hidden="true" />
      </ToolbarButton>
      <span className="mx-1 h-5 w-px bg-outline-variant" aria-hidden="true" />
      <ToolbarButton label="Bold" pressed={active.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className={icon} aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="Italic" pressed={active.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className={icon} aria-hidden="true" />
      </ToolbarButton>
      <span className="mx-1 h-5 w-px bg-outline-variant" aria-hidden="true" />
      <ToolbarButton label="Bulleted list" pressed={active.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className={icon} aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="Numbered list" pressed={active.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className={icon} aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="Block quote" pressed={active.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote className={icon} aria-hidden="true" />
      </ToolbarButton>
      <span className="mx-1 h-5 w-px bg-outline-variant" aria-hidden="true" />
      <ToolbarButton label="Link" pressed={active.link} onClick={() => setLinkOpen(true)}>
        <LinkIcon className={icon} aria-hidden="true" />
      </ToolbarButton>
      <span className="mx-1 h-5 w-px bg-outline-variant" aria-hidden="true" />
      <ToolbarButton label="Undo" disabled={!active.canUndo} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 className={icon} aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="Redo" disabled={!active.canRedo} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 className={icon} aria-hidden="true" />
      </ToolbarButton>

      {linkOpen ? (
        <LinkDialog
          open
          initialHref={active.href}
          onClose={() => setLinkOpen(false)}
          onApply={(href) => {
            editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
            setLinkOpen(false);
          }}
          onRemove={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            setLinkOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
