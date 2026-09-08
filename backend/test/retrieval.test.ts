import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestApp, registerUser, createSpace, cleanupUsers, uniqueEmail } from './helpers.js';
import { seedSource } from './assistant-helpers.js';
import { retrieve } from '../src/lib/retrieval.js';
import { retrievableSources } from '../src/lib/retrieval-scope.js';

/**
 * Retrieval (PRD §9). Every eligibility assertion goes through
 * `retrievableSources()` rather than re-deriving `state`/`archivedAt`, because the
 * point of that function is that there is exactly one definition of retrievable.
 */
describe('hybrid retrieval', () => {
  let app: FastifyInstance;
  let cookie: string;
  let spaceId: string;
  let otherSpaceId: string;
  const emails: string[] = [];

  // Distinct vocabularies so each half of the hybrid query can be seen working.
  const CONSENT = 'Participants explained that withdrawing from the study felt socially costly.';
  const NAPS = 'Afternoon naps of ninety minutes improved recall of word pairs by eleven percent.';
  const PROPER_NOUN = 'The Helsinki Declaration paragraph 26 governs the right to withdraw.';

  beforeAll(async () => {
    app = await startTestApp();
    const email = uniqueEmail('retrieval');
    emails.push(email);
    const user = await registerUser(app, email);
    cookie = user.cookie;
    spaceId = await createSpace(app, cookie, 'Retrieval space');
    otherSpaceId = await createSpace(app, cookie, 'Another space');
  });

  afterAll(async () => {
    await cleanupUsers(app, emails);
    await app.close();
  });

  it('finds a paraphrase the lexical half cannot match', async () => {
    const { sourceId } = await seedSource(app, spaceId, {
      title: 'Consent Practices',
      passages: [{ text: CONSENT, page: 7 }],
    });

    // No shared content word with the passage: "quit", "pressure", "peers".
    const result = await retrieve(app, { type: 'space', spaceId }, 'Did people feel pressure to keep going?');

    expect(result.passages.map((passage) => passage.sourceId)).toContain(sourceId);
    // The vector half is what found it; the lexical half contributed nothing.
    expect(result.counts.vector).toBeGreaterThan(0);
  });

  it('finds a proper noun the vector half blurs', async () => {
    const { sourceId } = await seedSource(app, spaceId, {
      title: 'Helsinki notes',
      passages: [{ text: PROPER_NOUN, page: 2 }],
    });

    const result = await retrieve(app, { type: 'space', spaceId }, 'Helsinki Declaration paragraph 26');

    expect(result.counts.lexical).toBeGreaterThan(0);
    expect(result.passages.map((passage) => passage.sourceId)).toContain(sourceId);
  });

  it('ranks a passage found by both halves above one found by either', async () => {
    const space = await createSpace(app, cookie, 'Fusion space');
    const both = await seedSource(app, space, {
      title: 'Both halves',
      passages: [{ text: NAPS, page: 1 }],
    });
    await seedSource(app, space, {
      title: 'Lexical only',
      passages: [{ text: 'Naps are mentioned here and nothing else is.', page: 1 }],
    });

    const result = await retrieve(app, { type: 'space', spaceId: space }, 'naps improved recall of word pairs');

    expect(result.passages[0]?.sourceId).toBe(both.sourceId);
  });

  it('never leaves the current source under a source scope', async () => {
    const space = await createSpace(app, cookie, 'Scoped space');
    const scoped = await seedSource(app, space, {
      title: 'Scoped source',
      passages: [{ text: CONSENT, page: 7 }],
    });
    const other = await seedSource(app, space, {
      title: 'Other source',
      passages: [{ text: `${CONSENT} And an extra sentence.`, page: 3 }],
    });

    const result = await retrieve(
      app,
      { type: 'source', spaceId: space, sourceId: scoped.sourceId },
      'withdrawing from the study',
    );

    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.passages.every((passage) => passage.sourceId === scoped.sourceId)).toBe(true);
    expect(result.passages.map((passage) => passage.sourceId)).not.toContain(other.sourceId);
  });

  it.each(['processing', 'failed'] as const)('excludes a %s source', async (state) => {
    const space = await createSpace(app, cookie, `State ${state}`);
    const { sourceId } = await seedSource(app, space, {
      title: `A ${state} source`,
      passages: [{ text: NAPS, page: 1 }],
      state,
    });

    const result = await retrieve(app, { type: 'space', spaceId: space }, 'naps and recall');
    expect(result.passages).toHaveLength(0);

    // Asserted through the exported filter, not by re-deriving the predicate.
    const eligible = await app.prisma.source.findMany({
      where: retrievableSources(space),
      select: { id: true },
    });
    expect(eligible.map((row) => row.id)).not.toContain(sourceId);
  });

  it('excludes an archived source', async () => {
    const space = await createSpace(app, cookie, 'Archived space');
    const { sourceId } = await seedSource(app, space, {
      title: 'Withdrawn evidence',
      passages: [{ text: NAPS, page: 1 }],
      archived: true,
    });

    const result = await retrieve(app, { type: 'space', spaceId: space }, 'naps and recall');
    expect(result.passages).toHaveLength(0);

    const eligible = await app.prisma.source.findMany({
      where: retrievableSources(space),
      select: { id: true },
    });
    expect(eligible.map((row) => row.id)).not.toContain(sourceId);
  });

  it('never reaches another space of the same user', async () => {
    const { sourceId } = await seedSource(app, otherSpaceId, {
      title: 'Neighbouring space',
      passages: [{ text: NAPS, page: 1 }],
    });

    const result = await retrieve(app, { type: 'space', spaceId }, 'naps improved recall');
    expect(result.passages.map((passage) => passage.sourceId)).not.toContain(sourceId);
  });

  it('never retrieves a note that has not been converted into a source', async () => {
    const space = await createSpace(app, cookie, 'Notes space');
    // A note whose text answers the question perfectly. §9 forbids it as evidence,
    // and the mechanism is that retrieval reads passages — a note has none.
    await app.prisma.note.create({
      data: {
        spaceId: space,
        title: 'My own thinking',
        contentRich: { text: NAPS },
      },
    });
    await seedSource(app, space, {
      title: 'Unrelated source',
      passages: [{ text: 'Something entirely different about tides.', page: 1 }],
    });

    const result = await retrieve(app, { type: 'space', spaceId: space }, 'naps improved recall of word pairs');

    for (const passage of result.passages) {
      expect(passage.text).not.toContain('word pairs by eleven percent');
    }
  });

  it('answers a punctuation-only question rather than throwing', async () => {
    const result = await retrieve(app, { type: 'space', spaceId }, '&& | - "unclosed');
    expect(Array.isArray(result.passages)).toBe(true);
  });
});
