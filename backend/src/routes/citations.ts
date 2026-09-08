import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { assertAccess } from '../middleware/assert-access.js';

const targetSchema = z.object({
  sourceId: z.string(),
  spaceId: z.string(),
  /** The exact target, when the passage still exists after any reprocess. */
  passageId: z.string().nullable(),
  /** The block range to highlight — null when there is no passage to resolve. */
  startBlockOrd: z.number().int().nullable(),
  endBlockOrd: z.number().int().nullable(),
  page: z.number().int().nullable(),
  paragraphRef: z.string().nullable(),
  sectionHeading: z.string().nullable(),
  /** True when the cited passage did not survive a reprocess (PRD §6/§10). */
  stale: z.boolean(),
});

/**
 * Resolves a citation to a location in the reader (PRD §8 citation navigation).
 *
 * There is no producer of citations until Phase 4 — this route exists now so
 * that locator interpretation lives in exactly one place: the client navigates
 * to the reader URL this answers instead of assembling one from a citation
 * payload (wiki-docs/plan/phase-3-library-reader/design.md "The reader's URL is
 * the citation contract"). Until then it is exercised against seeded rows.
 *
 * The resolution order is most-exact-first, and a stale citation is *reported*
 * rather than hidden: the reader shows the recorded page or paragraph, and says
 * the exact passage is gone.
 */
const citationsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/citations/:id/target',
    {
      onRequest: [app.requireUser],
      preHandler: [assertAccess('citation', 'id')],
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ target: targetSchema }) },
      },
    },
    async (request, reply) => {
      const citation = await app.prisma.citation.findUnique({
        where: { id: request.params.id },
        select: {
          sourceId: true,
          passageId: true,
          page: true,
          paragraphRef: true,
          sectionHeading: true,
          stale: true,
          source: { select: { spaceId: true } },
          passage: { select: { startBlockOrd: true, endBlockOrd: true, page: true, paragraphRef: true, sectionHeading: true } },
        },
      });
      if (!citation) throw notFound();

      // The passage's own locator wins where it exists: a reprocess rewrites it,
      // and the citation's copy is the older of the two.
      const passage = citation.passage;
      return reply.send({
        target: {
          sourceId: citation.sourceId,
          spaceId: citation.source.spaceId,
          passageId: citation.passageId,
          startBlockOrd: passage?.startBlockOrd ?? null,
          endBlockOrd: passage?.endBlockOrd ?? null,
          page: passage?.page ?? citation.page,
          paragraphRef: passage?.paragraphRef ?? citation.paragraphRef,
          sectionHeading: passage?.sectionHeading ?? citation.sectionHeading,
          stale: citation.stale,
        },
      });
    },
  );
};

export default citationsRoutes;
