/**
 * Whitelist validation for the notebook document (PRD §13, §17).
 *
 * The notebook is stored as Tiptap/ProseMirror JSON and later rendered in a
 * print view and serialised to Markdown, so the server accepts exactly the
 * node and mark set the editor is configured with — nothing else. An unknown
 * node is a rendering surprise at best; an unchecked `href` is a stored
 * `javascript:` link at worst. Depth is bounded like `extractPlainText`.
 *
 * The validator answers the *first* offending JSON path so the 400 can name
 * it; it never mutates the document.
 */

export const MAX_DEPTH = 100;

export type DocValidation = { ok: true } | { ok: false; path: string; reason: string };

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

type JsonNode = {
  type?: unknown;
  attrs?: unknown;
  marks?: unknown;
  content?: unknown;
  text?: unknown;
};

const NODE_KEYS = new Set(['type', 'attrs', 'marks', 'content', 'text']);
const MARK_KEYS = new Set(['type', 'attrs']);

const REQUIRE_CHILD = new Set(['bulletList', 'orderedList', 'listItem', 'blockquote']);

const BLOCKS = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote']);
const INLINE = new Set(['text', 'hardBreak', 'citation']);

/** What each container may hold. `listItem` follows Tiptap's `paragraph block*`. */
const CHILDREN: Record<string, Set<string>> = {
  doc: BLOCKS,
  blockquote: BLOCKS,
  paragraph: INLINE,
  heading: INLINE,
  bulletList: new Set(['listItem']),
  orderedList: new Set(['listItem']),
  listItem: BLOCKS,
};

function fail(path: string, reason: string): DocValidation {
  return { ok: false, path, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Attribute keys Tiptap emits for a node; a key outside the list is rejected unless null. */
function checkAttrs(
  attrs: unknown,
  path: string,
  allowed: Record<string, (value: unknown) => boolean>,
  required: string[] = [],
): DocValidation {
  if (attrs === undefined) {
    return required.length ? fail(`${path}.attrs`, `missing ${required.join(', ')}`) : { ok: true };
  }
  if (!isRecord(attrs)) return fail(`${path}.attrs`, 'attrs must be an object');
  for (const key of required) {
    if (attrs[key] === undefined) return fail(`${path}.attrs.${key}`, 'required');
  }
  for (const [key, value] of Object.entries(attrs)) {
    const check = allowed[key];
    if (!check) {
      if (value === null || value === undefined) continue;
      return fail(`${path}.attrs.${key}`, 'unknown attribute');
    }
    if (!check(value)) return fail(`${path}.attrs.${key}`, 'invalid value');
  }
  return { ok: true };
}

const isString = (v: unknown) => typeof v === 'string';
const isNullableString = (v: unknown) => v === null || typeof v === 'string';
const isNullableInt = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v));
const isNullableBoolean = (v: unknown) => v === null || typeof v === 'boolean';

export function isSafeHref(href: unknown): boolean {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048) return false;
  try {
    const url = new URL(href);
    return LINK_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function checkMarks(marks: unknown, path: string): DocValidation {
  if (marks === undefined) return { ok: true };
  if (!Array.isArray(marks)) return fail(`${path}.marks`, 'marks must be an array');
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i] as JsonNode;
    const markPath = `${path}.marks[${i}]`;
    if (!isRecord(mark)) return fail(markPath, 'mark must be an object');
    for (const key of Object.keys(mark)) {
      if (!MARK_KEYS.has(key)) return fail(`${markPath}.${key}`, 'unknown key');
    }
    switch (mark.type) {
      case 'bold':
      case 'italic': {
        const attrs = checkAttrs(mark.attrs, markPath, {});
        if (!attrs.ok) return attrs;
        break;
      }
      case 'link': {
        const attrs = checkAttrs(
          mark.attrs,
          markPath,
          { href: isSafeHref, target: isNullableString, rel: isNullableString, class: isNullableString },
          ['href'],
        );
        if (!attrs.ok) return attrs;
        break;
      }
      default:
        return fail(`${markPath}.type`, `unknown mark ${String(mark.type)}`);
    }
  }
  return { ok: true };
}

function checkNode(node: unknown, path: string, depth: number, parent: string): DocValidation {
  if (depth > MAX_DEPTH) return fail(path, 'nested too deeply');
  if (!isRecord(node)) return fail(path, 'node must be an object');
  for (const key of Object.keys(node)) {
    if (!NODE_KEYS.has(key)) return fail(`${path}.${key}`, 'unknown key');
  }
  const type = node.type;
  if (typeof type !== 'string') return fail(`${path}.type`, 'missing type');
  const allowedHere = CHILDREN[parent];
  if (!allowedHere || !allowedHere.has(type)) {
    return fail(`${path}.type`, `${type} is not allowed inside ${parent}`);
  }

  let attrs: DocValidation = { ok: true };
  switch (type) {
    case 'heading':
      attrs = checkAttrs(
        node.attrs,
        path,
        { level: (v) => v === 1 || v === 2 || v === 3 },
        ['level'],
      );
      break;
    case 'orderedList':
      attrs = checkAttrs(node.attrs, path, {
        start: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
        type: isNullableString,
      });
      break;
    case 'citation':
      attrs = checkAttrs(
        node.attrs,
        path,
        {
          citationId: isString,
          sourceId: isString,
          sourceTitle: isString,
          page: isNullableInt,
          paragraphRef: isNullableString,
          quotedText: isString,
          stale: isNullableBoolean,
        },
        ['citationId', 'sourceId', 'sourceTitle', 'quotedText'],
      );
      break;
    default:
      attrs = checkAttrs(node.attrs, path, {});
  }
  if (!attrs.ok) return attrs;

  if (type === 'text') {
    if (typeof node.text !== 'string' || node.text.length === 0) {
      return fail(`${path}.text`, 'text must be a non-empty string');
    }
    if (node.content !== undefined) return fail(`${path}.content`, 'text has no content');
    return checkMarks(node.marks, path);
  }
  if (node.text !== undefined) return fail(`${path}.text`, `${type} carries no text`);
  if (node.marks !== undefined) return fail(`${path}.marks`, `${type} carries no marks`);

  if (node.content === undefined) {
    // An empty paragraph is how Tiptap says "blank"; a list or quote with no
    // children is not something it says at all.
    if (REQUIRE_CHILD.has(type)) return fail(`${path}.content`, `${type} must not be empty`);
    return CHILDREN[type] || type === 'hardBreak' || type === 'citation'
      ? { ok: true }
      : fail(path, 'unexpected leaf');
  }
  if (!CHILDREN[type]) return fail(`${path}.content`, `${type} has no content`);
  if (!Array.isArray(node.content)) return fail(`${path}.content`, 'content must be an array');
  // ProseMirror's schema says `listItem+` / `block+`: an empty list or quote
  // is a document the editor could not have produced and cannot render.
  if (REQUIRE_CHILD.has(type) && node.content.length === 0) {
    return fail(`${path}.content`, `${type} must not be empty`);
  }
  for (let i = 0; i < node.content.length; i++) {
    const result = checkNode(node.content[i], `${path}.content[${i}]`, depth + 1, type);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** Validates a whole notebook document. The root must be a `doc`. */
export function validateNotebookDoc(doc: unknown): DocValidation {
  if (!isRecord(doc)) return fail('$', 'document must be an object');
  for (const key of Object.keys(doc)) {
    if (!NODE_KEYS.has(key)) return fail(`$.${key}`, 'unknown key');
  }
  if (doc.type !== 'doc') return fail('$.type', 'root must be a doc');
  if (doc.attrs !== undefined || doc.marks !== undefined || doc.text !== undefined) {
    return fail('$', 'doc carries only content');
  }
  if (doc.content === undefined) return { ok: true };
  if (!Array.isArray(doc.content)) return fail('$.content', 'content must be an array');
  for (let i = 0; i < doc.content.length; i++) {
    const result = checkNode(doc.content[i], `$.content[${i}]`, 1, 'doc');
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** What Tiptap produces for an empty editor, so the first save is not a spurious change. */
export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] } as const;
