/**
 * Notebook → Markdown (PRD §14).
 *
 * The one serialiser: the download and the clipboard copy both read
 * `GET /spaces/:id/notebook/export.md`. It walks a document that has already
 * passed `validateNotebookDoc`, so it can assume the shape and only has to
 * decide formatting. The output is deterministic — no date — so a test can
 * compare it byte for byte and a user can diff two exports.
 *
 * Escaping is structural only: characters that would change what Markdown
 * *means* are escaped; everything else is left as prose so the file reads
 * naturally in a plain editor.
 */

export interface CitationAttrs {
  citationId: string;
  sourceId: string;
  sourceTitle: string;
  page: number | null;
  paragraphRef: string | null;
  quotedText: string;
}

/** A live source row, or `null` when the source no longer exists. */
export interface ExportSource {
  id: string;
  title: string;
  author: string | null;
  url: string | null;
}

export interface ExportInput {
  spaceName: string;
  objective: string | null;
  doc: unknown;
  /** Live rows for the `sourceId`s the document cites; missing ids print as removed. */
  sources: ReadonlyMap<string, ExportSource>;
}

type Node = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: Node[];
  text?: string;
};

/** Collects the citations a document carries, in order of first appearance. */
export function collectCitations(doc: unknown): CitationAttrs[] {
  const seen = new Map<string, CitationAttrs>();
  const walk = (node: Node | undefined) => {
    if (!node) return;
    if (node.type === 'citation' && node.attrs) {
      const attrs = node.attrs as unknown as CitationAttrs;
      if (!seen.has(attrs.citationId)) seen.set(attrs.citationId, attrs);
    }
    node.content?.forEach(walk);
  };
  walk(doc as Node);
  return [...seen.values()];
}

function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

/** A line that starts like a heading, quote, list, or rule would be read as one. */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, '$1\\$2$3');
}

function inline(nodes: Node[] | undefined, numberOf: (citationId: string) => number): string {
  if (!nodes) return '';
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const raw = node.text ?? '';
        // CommonMark refuses `** bold **`: emphasis delimiters cannot sit next
        // to whitespace on the inside. The editor happily bolds a trailing
        // space, so the whitespace is moved outside the delimiters.
        const leading = raw.match(/^\s*/)?.[0] ?? '';
        const trailing = raw.match(/\s*$/)?.[0] ?? '';
        const core = raw.slice(leading.length, raw.length - trailing.length);
        if (core.length === 0) {
          out += raw;
          break;
        }
        let text = escapeInline(core);
        const marks = node.marks ?? [];
        const has = (type: string) => marks.some((m) => m.type === type);
        if (has('bold')) text = `**${text}**`;
        if (has('italic')) text = `*${text}*`;
        const link = marks.find((m) => m.type === 'link');
        if (link && typeof link.attrs?.href === 'string') text = `[${text}](${link.attrs.href})`;
        out += leading + text + trailing;
        break;
      }
      case 'hardBreak':
        out += '  \n';
        break;
      case 'citation':
        out += `[${numberOf(String(node.attrs?.citationId))}]`;
        break;
    }
  }
  return out;
}

function blocks(nodes: Node[] | undefined, numberOf: (id: string) => number): string[] {
  const out: string[] = [];
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'paragraph': {
        const text = inline(node.content, numberOf);
        out.push(text.split('\n').map(escapeLineStart).join('\n'));
        break;
      }
      case 'heading': {
        const level = Number(node.attrs?.level ?? 1);
        out.push(`${'#'.repeat(level)} ${inline(node.content, numberOf).replace(/\n/g, ' ')}`);
        break;
      }
      case 'blockquote': {
        const inner = blocks(node.content, numberOf).join('\n\n');
        out.push(
          inner
            .split('\n')
            .map((line) => (line.length ? `> ${line}` : '>'))
            .join('\n'),
        );
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        out.push(list(node, numberOf));
        break;
      }
    }
  }
  return out;
}

function list(node: Node, numberOf: (id: string) => number): string {
  const ordered = node.type === 'orderedList';
  const start = ordered ? Number(node.attrs?.start ?? 1) : 1;
  const lines: string[] = [];
  (node.content ?? []).forEach((item, index) => {
    const marker = ordered ? `${start + index}.` : '-';
    const indent = ' '.repeat(marker.length + 1);
    const inner = blocks(item.content, numberOf);
    const [first = '', ...rest] = inner;
    const firstLines = first.split('\n');
    lines.push(`${marker} ${firstLines[0] ?? ''}`);
    for (const line of firstLines.slice(1)) lines.push(line.length ? indent + line : '');
    for (const block of rest) {
      lines.push('');
      for (const line of block.split('\n')) lines.push(line.length ? indent + line : '');
    }
  });
  return lines.join('\n');
}

function locator(citation: CitationAttrs): string | null {
  if (citation.page !== null && citation.page !== undefined) return `p. ${citation.page}`;
  if (citation.paragraphRef) return `¶ ${citation.paragraphRef}`;
  return null;
}

export function serializeNotebook(input: ExportInput): string {
  const citations = collectCitations(input.doc);
  const numbers = new Map(citations.map((c, i) => [c.citationId, i + 1]));
  const numberOf = (id: string) => numbers.get(id) ?? 0;

  const parts: string[] = [`# ${escapeInline(input.spaceName).replace(/\n/g, ' ')}`];
  const objective = input.objective?.trim();
  if (objective) {
    parts.push(
      objective
        .split('\n')
        .map((line, i) => (i === 0 ? `> Objective: ${escapeInline(line)}` : `> ${escapeInline(line)}`))
        .join('\n'),
    );
  }

  const body = blocks((input.doc as Node).content, numberOf).filter((b) => b.length > 0);
  parts.push(...body);

  if (citations.length > 0) {
    const rows = citations.map((citation, i) => {
      const live = input.sources.get(citation.sourceId);
      const n = i + 1;
      if (!live) return `[${n}] ${escapeInline(citation.sourceTitle)} (source removed)`;
      const fields = [escapeInline(live.title)];
      if (live.author) fields.push(escapeInline(live.author));
      const where = locator(citation);
      if (where) fields.push(where);
      if (live.url) fields.push(`<${live.url}>`);
      return `[${n}] ${fields.join(' — ')}`;
    });
    parts.push('## Sources', rows.join('\n'));
  }

  return `${parts.join('\n\n')}\n`;
}

/** ASCII-safe filename stem from a space name; Vietnamese diacritics fold to their base letters. */
export function filenameSlug(name: string, fallback = 'notebook'): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}
