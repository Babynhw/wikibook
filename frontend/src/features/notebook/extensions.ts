import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Citation } from './citation-node';

/**
 * Exactly PRD §13's editor: headings (three levels), paragraphs, bold, italic,
 * bulleted and numbered lists, block quotes, links, undo/redo — plus the
 * citation node. Everything StarterKit adds beyond that is turned off, so
 * pasted HTML using a strike-through or a code block is flattened to text by
 * the schema and the server's whitelist (`validate-doc.ts`) never sees it.
 * Adding a node here without adding it there makes every save a 400.
 */
export const LINK_PROTOCOLS = ['http', 'https', 'mailto'];

export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return LINK_PROTOCOLS.includes(url.protocol.replace(/:$/, ''));
  } catch {
    return false;
  }
}

export function notebookExtensions(placeholder: string | (() => string) = 'Start drafting…') {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      strike: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      // Links come from the dedicated extension below so their protocols are checked.
      link: false,
      // Underline, trailing-node and the other v3 extras are not §13 features.
      underline: false,
    }),
    Link.configure({
      // Editing: a click places the caret; opening is a deliberate action from
      // the toolbar. The print view renders its own anchors.
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      protocols: LINK_PROTOCOLS,
      isAllowedUri: (url) => isSafeHref(url),
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    }),
    Placeholder.configure({ placeholder }),
    Citation,
  ];
}
