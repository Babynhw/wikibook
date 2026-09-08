/**
 * Seeds the PRD §19 search-timing fixture: one space, "Perf — 50 sources",
 * holding fifty *ready* manual text sources with varied titles and bodies, so
 * `GET /spaces/:id/sources?q=` can be timed at the §5 ceiling
 * (wiki-docs/plan/phase-7-home-and-hardening/design.md "§19 Performance").
 *
 *   pnpm --filter backend exec tsx scripts/seed-perf.ts
 *
 * Environment (all optional; the rest comes from backend/.env):
 *   PERF_EMAIL      the dedicated perf account   (default perf@wikibooklm.local)
 *   PERF_PASSWORD   its password, for signing in (default perf-seed-password)
 *   PERF_SPACE_NAME the space name               (default "Perf — 50 sources")
 *
 * Needs Postgres and Ollama — embeddings are real, produced by the same
 * pipeline the worker runs (`runSourceIngestion`), so the seeded rows satisfy
 * every retrieval-eligibility invariant a user-added source does: `Passage`
 * and `SourceBlock` rows written in one transaction, `state: 'ready'`, a
 * `source.ready` activity. No worker is needed and none should be pointed at
 * these rows: they are created `processing` and processed here, never enqueued.
 *
 * Idempotent: the user, the space, and each of the fifty titles are looked up
 * before they are created, a source that is already `ready` is left alone, and
 * one that is `processing` or `failed` from an interrupted run is re-run.
 * Running it twice changes nothing. The account is dev-only — never seed it into
 * a shared database.
 */
import 'dotenv/config';
import argon2 from 'argon2';
import { env, loadLimits } from '../src/config.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { embed } from '../src/lib/embeddings.js';
import { getObject } from '../src/lib/storage.js';
import { runSourceIngestion } from '../src/ingest/pipeline.js';

const EMAIL = process.env.PERF_EMAIL ?? 'perf@wikibooklm.local';
const PASSWORD = process.env.PERF_PASSWORD ?? 'perf-seed-password';
const SPACE_NAME = process.env.PERF_SPACE_NAME ?? 'Perf — 50 sources';
const TARGET = 50;

// ---------------------------------------------------------------------------
// Fifty distinct sources. Ten subjects × five aspects give fifty titles whose
// words barely overlap, and each body is built from its subject's own
// vocabulary, so a search for a subject word ranks that subject's five sources
// and a search for an aspect word cuts across subjects — the two shapes §7's
// ranked search has to answer.
// ---------------------------------------------------------------------------

interface Subject {
  name: string;
  author: string;
  terms: string[];
}

const SUBJECTS: Subject[] = [
  { name: 'Tidal energy', author: 'M. Okafor', terms: ['barrage', 'turbine', 'estuary', 'spring tide', 'lagoon', 'sluice'] },
  { name: 'Urban beekeeping', author: 'H. Lindqvist', terms: ['hive', 'forage', 'swarm', 'rooftop', 'nectar flow', 'varroa'] },
  { name: 'Medieval glassmaking', author: 'C. Devereux', terms: ['furnace', 'potash', 'cullet', 'gather', 'pontil', 'crown glass'] },
  { name: 'Glacier monitoring', author: 'A. Brunner', terms: ['moraine', 'ablation', 'firn', 'crevasse', 'mass balance', 'terminus'] },
  { name: 'Sourdough fermentation', author: 'P. Marchetti', terms: ['levain', 'hydration', 'autolyse', 'crumb', 'lactobacillus', 'proof'] },
  { name: 'Lighthouse optics', author: 'E. Thorncastle', terms: ['Fresnel lens', 'lantern', 'characteristic', 'focal plane', 'occulting', 'keeper'] },
  { name: 'Peat restoration', author: 'S. Nic Dhòmhnaill', terms: ['sphagnum', 'bund', 'rewetting', 'drain blocking', 'carbon store', 'hagg'] },
  { name: 'Typeface design', author: 'R. Almeida', terms: ['x-height', 'serif', 'kerning', 'counter', 'hinting', 'ligature'] },
  { name: 'Freshwater mussels', author: 'J. Whitcombe', terms: ['glochidia', 'host fish', 'riverbed', 'filter feeding', 'byssal', 'recruitment'] },
  { name: 'Canal lock engineering', author: 'D. Ferreira', terms: ['pound', 'paddle gear', 'mitre gate', 'cill', 'balance beam', 'side pond'] },
];

const ASPECTS = ['field survey', 'historical overview', 'maintenance guide', 'policy briefing', 'case study'] as const;

/** Deterministic pseudo-randomness so a re-run produces the same fifty bodies. */
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function buildBody(subject: Subject, aspect: string, index: number): string {
  const next = rng(index + 1);
  const pick = () => subject.terms[Math.floor(next() * subject.terms.length)]!;
  const number = (max: number) => Math.floor(next() * max) + 1;
  const year = 1880 + Math.floor(next() * 140);
  const paragraphs = [
    `${subject.name}: ${aspect}. This document summarises what is known about the ${pick()} and the ${pick()}, drawing on records kept since ${year}.`,
    `In the ${aspect}, the ${pick()} was measured ${number(40)} times across ${number(12)} sites. Observers noted that the ${pick()} varied with the season and that the ${pick()} required attention roughly every ${number(9)} weeks.`,
    `Three recommendations follow. First, treat the ${pick()} as the limiting factor. Second, record the ${pick()} at each visit. Third, compare the ${pick()} against the ${year + 20} baseline before drawing conclusions.`,
    `Costs were dominated by the ${pick()}, at about ${number(90) * 100} per year, while the ${pick()} contributed less than a tenth of the total. The authors thank the ${number(30)} volunteers who helped with the ${pick()}.`,
  ];
  return paragraphs.join('\n\n');
}

const PLAN = Array.from({ length: TARGET }, (_, index) => {
  const subject = SUBJECTS[index % SUBJECTS.length]!;
  const aspect = ASPECTS[Math.floor(index / SUBJECTS.length)]!;
  return {
    title: `${subject.name} — ${aspect} ${String(index + 1).padStart(2, '0')}`,
    author: subject.author,
    content: buildBody(subject, aspect, index),
  };
});

// ---------------------------------------------------------------------------

const prisma = createPrismaClient(env.DATABASE_URL);

const logger = {
  info: () => {},
  warn: (context: Record<string, unknown>, message: string) => console.warn(message, context),
  error: (context: Record<string, unknown>, message: string) => console.error(message, context),
};

const deps = {
  prisma,
  storage: { getObject },
  embed,
  publish: async () => {},
  logger,
};

let failed = false;
try {
  // The user: sign in if it exists, create it otherwise (argon2id, as /auth/register does).
  let user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (user) {
    console.log(`user ${EMAIL} exists`);
  } else {
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    user = await prisma.user.create({
      data: { name: 'Perf Seed', email: EMAIL, passwordHash },
      select: { id: true },
    });
    console.log(`created user ${EMAIL}`);
  }

  // The space: reuse by owner + name.
  let space = await prisma.space.findFirst({
    where: { ownerId: user.id, name: SPACE_NAME, archivedAt: null },
    select: { id: true },
  });
  if (space) {
    console.log(`space "${SPACE_NAME}" exists (${space.id})`);
  } else {
    space = await prisma.space.create({
      data: {
        ownerId: user.id,
        name: SPACE_NAME,
        objective: 'PRD §19 search-timing fixture: fifty ready manual sources.',
      },
      select: { id: true },
    });
    await prisma.activity.create({
      data: { userId: user.id, spaceId: space.id, kind: 'space.created', refId: space.id },
    });
    console.log(`created space "${SPACE_NAME}" (${space.id})`);
  }

  // The §5 limit is read live, as the create route reads it — a lower cap is honoured, not overridden.
  const limits = await loadLimits(prisma, true);
  const target = Math.min(TARGET, limits.sources_per_space);
  if (target < TARGET) {
    console.warn(`sources_per_space is ${limits.sources_per_space}; seeding ${target} rather than ${TARGET}`);
  }

  let created = 0;
  let processed = 0;
  let untouched = 0;
  for (const item of PLAN.slice(0, target)) {
    let source = await prisma.source.findFirst({
      where: { spaceId: space.id, type: 'manual', title: item.title },
      select: { id: true, state: true },
    });

    if (!source) {
      source = await prisma.$transaction(async (tx) => {
        const row = await tx.source.create({
          data: {
            spaceId: space!.id,
            type: 'manual',
            title: item.title,
            author: item.author,
            content: item.content,
            state: 'processing',
          },
          select: { id: true, state: true },
        });
        await tx.activity.create({
          data: { userId: user!.id, spaceId: space!.id, kind: 'source.added', refId: row.id },
        });
        return row;
      });
      created++;
    } else if (source.state === 'ready') {
      untouched++;
      continue;
    } else if (source.state === 'failed') {
      // Same reset the retry route performs before re-running the pipeline.
      await prisma.source.update({
        where: { id: source.id },
        data: { state: 'processing', errorMessage: null },
      });
    }

    // Extract → chunk → embed → one transactional write, exactly as the worker does.
    await runSourceIngestion(deps, source.id);
    const after = await prisma.source.findUnique({
      where: { id: source.id },
      select: { state: true, errorMessage: true },
    });
    if (after?.state !== 'ready') {
      throw new Error(`"${item.title}" ended ${after?.state ?? 'missing'}: ${after?.errorMessage ?? 'no message'}`);
    }
    processed++;
  }

  const ready = await prisma.source.count({
    where: { spaceId: space.id, state: 'ready', archivedAt: null },
  });
  console.log(
    `done: ${created} created, ${processed} processed, ${untouched} already ready — ${ready} ready sources in "${SPACE_NAME}"`,
  );
  console.log(`sign in as ${EMAIL} (PERF_PASSWORD, see the header comment); space id ${space.id}`);
} catch (error) {
  console.error('seed-perf failed', error);
  failed = true;
} finally {
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
