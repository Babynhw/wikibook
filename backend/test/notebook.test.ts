import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupUsers, createSpace, registerUser, startTestApp, uniqueEmail } from './helpers.js';
import { EMPTY_DOC, validateNotebookDoc } from '../src/notebook/validate-doc.js';
import { collectCitations, filenameSlug, serializeNotebook } from '../src/notebook/markdown.js';

const text = (t: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const citation = (attrs: Partial<Record<string, unknown>> = {}) => ({
  type: 'citation',
  attrs: {
    citationId: 'cit-1',
    sourceId: 'src-1',
    sourceTitle: 'Smith 2023',
    page: 4,
    paragraphRef: null,
    quotedText: 'a quoted line',
    ...attrs,
  },
});

describe('notebook (Phase 6, PRD §13, §14)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
    const email = uniqueEmail('notebook');
    emails.push(email);
    ({ cookie, userId } = await registerUser(app, email));
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  const get = async (spaceId: string, c = cookie) =>
    app.inject({ method: 'GET', url: `/spaces/${spaceId}/notebook`, headers: { cookie: c } });
  const put = async (spaceId: string, payload: Record<string, unknown>, c = cookie) =>
    app.inject({ method: 'PUT', url: `/spaces/${spaceId}/notebook`, headers: { cookie: c }, payload });

  describe('read and lazy creation', () => {
    it('creates the row on first GET and returns the same one afterwards', async () => {
      const spaceId = await createSpace(app, cookie);
      const first = await get(spaceId);
      expect(first.statusCode).toBe(200);
      const a = first.json().notebook;
      expect(a.spaceId).toBe(spaceId);
      expect(a.contentRich).toEqual(EMPTY_DOC);

      const second = await get(spaceId);
      expect(second.json().notebook.id).toBe(a.id);
      expect(await app.prisma.notebook.count({ where: { spaceId } })).toBe(1);
    });

    it('two concurrent first opens converge on one row', async () => {
      const spaceId = await createSpace(app, cookie);
      const [a, b] = await Promise.all([get(spaceId), get(spaceId)]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(a.json().notebook.id).toBe(b.json().notebook.id);
      expect(await app.prisma.notebook.count({ where: { spaceId } })).toBe(1);
    });

    it('reads an archived space fine', async () => {
      const spaceId = await createSpace(app, cookie);
      await app.inject({ method: 'POST', url: `/spaces/${spaceId}/archive`, headers: { cookie } });
      expect((await get(spaceId)).statusCode).toBe(200);
    });
  });

  describe('save', () => {
    it('round-trips a document and bumps updatedAt', async () => {
      const spaceId = await createSpace(app, cookie);
      const { notebook } = (await get(spaceId)).json();
      const body = doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Findings')] },
        paragraph(text('Bold', [{ type: 'bold' }]), text(' and '), citation()),
      );
      const saved = await put(spaceId, { contentRich: body, baseUpdatedAt: notebook.updatedAt });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().notebook.contentRich).toEqual(body);
      expect(saved.json().notebook.updatedAt).not.toBe(notebook.updatedAt);

      const again = await get(spaceId);
      expect(again.json().notebook.contentRich).toEqual(body);
    });

    it('answers 409 space_archived and leaves the document alone', async () => {
      const spaceId = await createSpace(app, cookie);
      const { notebook } = (await get(spaceId)).json();
      await app.inject({ method: 'POST', url: `/spaces/${spaceId}/archive`, headers: { cookie } });
      const res = await put(spaceId, { contentRich: doc(paragraph(text('x'))), baseUpdatedAt: notebook.updatedAt });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('space_archived');
      expect((await get(spaceId)).json().notebook.contentRich).toEqual(EMPTY_DOC);
    });

    it('answers 409 notebook_conflict with the current document for a stale base', async () => {
      const spaceId = await createSpace(app, cookie);
      const { notebook } = (await get(spaceId)).json();
      const first = doc(paragraph(text('first tab')));
      const ok = await put(spaceId, { contentRich: first, baseUpdatedAt: notebook.updatedAt });
      expect(ok.statusCode).toBe(200);

      const stale = await put(spaceId, {
        contentRich: doc(paragraph(text('second tab'))),
        baseUpdatedAt: notebook.updatedAt,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('notebook_conflict');
      expect(stale.json().notebook.contentRich).toEqual(first);
      expect(stale.json().notebook.updatedAt).toBe(ok.json().notebook.updatedAt);

      // Keep mine: re-PUT with the server's updatedAt.
      const keep = await put(spaceId, {
        contentRich: doc(paragraph(text('second tab'))),
        baseUpdatedAt: ok.json().notebook.updatedAt,
      });
      expect(keep.statusCode).toBe(200);
    });

    it.each([
      ['unknown node', doc({ type: 'table' }), '$.content[0].type'],
      ['codeBlock', doc({ type: 'codeBlock', content: [text('x')] }), '$.content[0].type'],
      ['heading level 4', doc({ type: 'heading', attrs: { level: 4 }, content: [text('x')] }), '$.content[0].attrs.level'],
      [
        'javascript link',
        doc(paragraph(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
        '$.content[0].content[0].marks[0].attrs.href',
      ],
      ['unknown mark', doc(paragraph(text('x', [{ type: 'strike' }]))), '$.content[0].content[0].marks[0].type'],
      ['inline at block level', doc(text('loose')), '$.content[0].type'],
      ['missing citation attrs', doc(paragraph({ type: 'citation', attrs: { citationId: 'c' } })), '$.content[0].content[0].attrs.sourceId'],
      ['not a doc', { type: 'paragraph' }, '$.type'],
      ['empty bullet list', doc({ type: 'bulletList', content: [] }), '$.content[0].content'],
      ['list item without content', doc({ type: 'bulletList', content: [{ type: 'listItem' }] }), '$.content[0].content[0].content'],
      ['empty blockquote', doc({ type: 'blockquote', content: [] }), '$.content[0].content'],
    ])('rejects %s with 400 invalid_document naming the path', async (_name, body, path) => {
      const spaceId = await createSpace(app, cookie);
      const { notebook } = (await get(spaceId)).json();
      const res = await put(spaceId, { contentRich: body, baseUpdatedAt: notebook.updatedAt });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_document');
      expect(Object.keys(res.json().error.fields)).toEqual([path]);
      expect((await get(spaceId)).json().notebook.contentRich).toEqual(EMPTY_DOC);
    });

    it('rejects a document nested past the depth bound', () => {
      let node: unknown = paragraph(text('deep'));
      for (let i = 0; i < 101; i++) node = { type: 'blockquote', content: [node] };
      const result = validateNotebookDoc(doc(node));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('nested too deeply');
    });

    it('accepts everything the editor is configured to produce', () => {
      const full = doc(
        { type: 'heading', attrs: { level: 1 }, content: [text('H')] },
        paragraph(
          text('a', [{ type: 'bold' }, { type: 'italic' }]),
          { type: 'hardBreak' },
          text('b', [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener', class: null } }]),
          citation(),
        ),
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('i'))] }] },
        {
          type: 'orderedList',
          attrs: { start: 3, type: null },
          content: [{ type: 'listItem', content: [paragraph(text('i')), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('nested'))] }] }] }],
        },
        { type: 'blockquote', content: [paragraph(text('q'))] },
        { type: 'paragraph' },
      );
      expect(validateNotebookDoc(full)).toEqual({ ok: true });
    });

    it('answers 413 over the body limit and leaves the document unchanged', async () => {
      const spaceId = await createSpace(app, cookie);
      const { notebook } = (await get(spaceId)).json();
      const huge = doc(paragraph(text('x'.repeat(2 * 1024 * 1024 + 1))));
      const res = await put(spaceId, { contentRich: huge, baseUpdatedAt: notebook.updatedAt });
      expect(res.statusCode).toBe(413);
      expect((await get(spaceId)).json().notebook.contentRich).toEqual(EMPTY_DOC);
    });
  });

  describe('ownership', () => {
    it('answers 404 for a foreign space on every route', async () => {
      const spaceId = await createSpace(app, cookie);
      const other = uniqueEmail('notebook-other');
      emails.push(other);
      const stranger = (await registerUser(app, other)).cookie;
      expect((await get(spaceId, stranger)).statusCode).toBe(404);
      expect((await put(spaceId, { contentRich: EMPTY_DOC, baseUpdatedAt: new Date().toISOString() }, stranger)).statusCode).toBe(404);
      const md = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/notebook/export.md`, headers: { cookie: stranger } });
      expect(md.statusCode).toBe(404);
      expect(await app.prisma.notebook.count({ where: { spaceId } })).toBe(0);
    });
  });

  describe('markdown serialiser', () => {
    const sources = new Map([
      ['src-1', { id: 'src-1', title: 'Smith 2023 (renamed)', author: 'A. Smith', url: null }],
      ['src-web', { id: 'src-web', title: 'An article', author: null, url: 'https://example.com/a' }],
    ]);

    it('renders every node and mark in order', () => {
      const md = serializeNotebook({
        spaceName: 'Sleep & memory',
        objective: 'Why naps help.\nSecond line.',
        sources,
        doc: doc(
          { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
          paragraph(text('Plain '), text('bold', [{ type: 'bold' }]), text(' '), text('it', [{ type: 'italic' }]), text(' '), text('both', [{ type: 'bold' }, { type: 'italic' }])),
          paragraph(text('see ', []), text('the site', [{ type: 'link', attrs: { href: 'https://example.com' } }]), { type: 'hardBreak' }, text('after break')),
          { type: 'heading', attrs: { level: 3 }, content: [text('Sub')] },
          { type: 'bulletList', content: [
            { type: 'listItem', content: [paragraph(text('one'))] },
            { type: 'listItem', content: [paragraph(text('two')), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('nested'))] }] }] },
          ] },
          { type: 'orderedList', attrs: { start: 2 }, content: [
            { type: 'listItem', content: [paragraph(text('second')), paragraph(text('continued'))] },
            { type: 'listItem', content: [paragraph(text('third'))] },
          ] },
          { type: 'blockquote', content: [paragraph(text('quoted one')), paragraph(text('quoted two'))] },
        ),
      });
      expect(md).toBe(
        [
          '# Sleep & memory',
          '',
          '> Objective: Why naps help.',
          '> Second line.',
          '',
          '# Title',
          '',
          'Plain **bold** *it* ***both***',
          '',
          'see [the site](https://example.com)  ',
          'after break',
          '',
          '### Sub',
          '',
          '- one',
          '- two',
          '',
          '  - nested',
          '',
          '2. second',
          '',
          '   continued',
          '3. third',
          '',
          '> quoted one',
          '>',
          '> quoted two',
          '',
        ].join('\n'),
      );
    });

    it('moves whitespace outside emphasis delimiters — `** bold **` is not Markdown', () => {
      const md = serializeNotebook({
        spaceName: 'S',
        objective: null,
        sources,
        doc: doc(paragraph(text('Ngủ trưa ', [{ type: 'bold' }]), citation(), text(' và '), text(' nhấn ', [{ type: 'italic' }]), text('x'))),
      });
      expect(md).toBe('# S\n\n**Ngủ trưa** [1] và  *nhấn* x\n\n## Sources\n\n[1] Smith 2023 (renamed) — A. Smith — p. 4\n');
    });

    it('escapes only what would change structure', () => {
      const md = serializeNotebook({
        spaceName: 'S',
        objective: null,
        sources,
        doc: doc(paragraph(text('# not a heading, 2*3 and a_b [x] and `tick`')), paragraph(text('- not a list')), paragraph(text('1. not ordered'))),
      });
      expect(md).toBe(
        ['# S', '', '\\# not a heading, 2\\*3 and a\\_b \\[x\\] and \\`tick\\`', '', '\\- not a list', '', '\\1. not ordered', ''].join('\n'),
      );
    });

    it('numbers citations by first appearance, reuses a repeated one, and lists sources', () => {
      const md = serializeNotebook({
        spaceName: 'S',
        objective: null,
        sources,
        doc: doc(
          paragraph(text('A'), citation({ citationId: 'c1', sourceId: 'src-1', page: 4 })),
          paragraph(text('B'), citation({ citationId: 'c2', sourceId: 'src-web', page: null, paragraphRef: 'p12', sourceTitle: 'An article' })),
          paragraph(text('C'), citation({ citationId: 'c1', sourceId: 'src-1', page: 4 })),
          paragraph(text('D'), citation({ citationId: 'c3', sourceId: 'gone', sourceTitle: 'Deleted source', page: 1 })),
        ),
      });
      expect(md).toContain('A[1]\n\nB[2]\n\nC[1]\n\nD[3]');
      expect(md.endsWith(
        [
          '## Sources',
          '',
          '[1] Smith 2023 (renamed) — A. Smith — p. 4',
          '[2] An article — ¶ p12 — <https://example.com/a>',
          '[3] Deleted source (source removed)',
          '',
        ].join('\n'),
      )).toBe(true);
      expect(collectCitations(doc(paragraph(citation({ citationId: 'x' }), citation({ citationId: 'x' }))))).toHaveLength(1);
    });

    it('omits the objective and the source list when absent', () => {
      const md = serializeNotebook({ spaceName: 'S', objective: '  ', sources, doc: doc(paragraph(text('hi'))) });
      expect(md).toBe('# S\n\nhi\n');
    });

    it('slugs a Vietnamese space name', () => {
      expect(filenameSlug('Nghiên cứu Đường phố 2024!')).toBe('nghien-cuu-duong-pho-2024');
      expect(filenameSlug('???')).toBe('notebook');
    });
  });

  describe('export route', () => {
    it('serves UTF-8 Markdown, resolves live source titles, writes the activity, and does not touch the notebook', async () => {
      const spaceId = await createSpace(app, cookie, 'Giấc ngủ', { objective: 'Vì sao ngủ trưa giúp nhớ' });
      const source = await app.prisma.source.create({
        data: { spaceId, type: 'manual', title: 'Renamed later', author: 'Trần', content: 'x', state: 'ready' },
      });
      const { notebook } = (await get(spaceId)).json();
      const saved = await put(spaceId, {
        contentRich: doc(paragraph(text('Kết quả '), citation({ citationId: 'c1', sourceId: source.id, sourceTitle: 'Old title', page: 2 }))),
        baseUpdatedAt: notebook.updatedAt,
      });
      expect(saved.statusCode).toBe(200);

      const res = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/notebook/export.md`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.headers['content-disposition']).toBe('attachment; filename="giac-ngu-notebook.md"');
      expect(res.body).toBe(
        ['# Giấc ngủ', '', '> Objective: Vì sao ngủ trưa giúp nhớ', '', 'Kết quả [1]', '', '## Sources', '', '[1] Renamed later — Trần — p. 2', ''].join('\n'),
      );
      expect(res.rawPayload.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);

      const activity = await app.prisma.activity.findMany({ where: { spaceId, kind: 'notebook.exported' } });
      expect(activity).toHaveLength(1);
      expect(activity[0]!.userId).toBe(userId);
      expect(activity[0]!.refId).toBe(notebook.id);

      expect((await get(spaceId)).json().notebook.updatedAt).toBe(saved.json().notebook.updatedAt);
    });

    it('exports an empty notebook of an archived space', async () => {
      const spaceId = await createSpace(app, cookie, 'Empty');
      await app.inject({ method: 'POST', url: `/spaces/${spaceId}/archive`, headers: { cookie } });
      const res = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/notebook/export.md`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('# Empty\n');
    });
  });
});
