/**
 * Walks a ProseMirror / Tiptap JSON document and returns its text content.
 *
 * The walker shared by the note card snippet and the note viewer editor. Join
 * rules differ by caller:
 *
 * - snippets want prose with spaces (`{ inline: ' ', block: '' }`)
 * - the editor wants paragraph breaks it can round-trip (`\n\n` between
 *   paragraph / heading / blockquote blocks)
 *
 * The walk is depth-bounded at 100, mirroring the backend twin: `contentRich`
 * is loose JSON, so an adversarial or corrupted document must truncate rather
 * than blow the stack. When the bound is hit, `truncated` says so — the returned
 * text is then a *lossy* view of the document, and any caller that writes text
 * back (the note editor) must refuse rather than persist the loss.
 *
 * The backend keeps its *own* copy in `backend/src/routes/notes.ts`
 * (`extractPlainText`), because that copy decides what text is indexed for
 * retrieval — it earns its separate life.
 */
export function extractDocText(
  contentRich: unknown,
  options: { inline?: string; block?: string } = {},
): { question?: string; text: string; truncated: boolean } {
  const inline = options.inline ?? '';
  const block = options.block ?? '\n\n';
  if (!contentRich || typeof contentRich !== 'object') return { text: '', truncated: false };
  const doc = contentRich as { question?: string; content?: Array<unknown>; text?: string };
  const buffer: string[] = [];
  let truncated = false;

  function traverse(node: unknown, depth = 0) {
    // Stop, not throw: the frontend has no HTTP error to attach this to, and
    // the backend's `note_too_deep` already refused the mirror document there.
    // The flag is what stops the loss from being written back silently.
    if (depth > 100) {
      truncated = true;
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: string; content?: Array<unknown>; type?: string };
    if (typeof n.text === 'string') {
      buffer.push(n.text);
      if (inline) buffer.push(inline);
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) traverse(child, depth + 1);
      if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'blockquote') {
        buffer.push(block);
      }
    }
  }

  if (Array.isArray(doc.content)) {
    for (const child of doc.content) traverse(child);
  } else if (typeof doc.text === 'string') {
    buffer.push(doc.text);
  }

  return { question: doc.question, text: buffer.join('').trim(), truncated };
}