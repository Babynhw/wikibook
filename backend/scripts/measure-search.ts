/**
 * PRD §19 "source search updates within 500 ms for a 50-source space".
 * Signs in as the perf account `seed-perf.ts` creates, finds its space, runs
 * twenty distinct `?q=` searches against the API and prints p50 / p95 / max of
 * the HTTP round-trip measured from this process (localhost, so within a few
 * milliseconds of the server-side figure).
 *
 *   pnpm --filter backend exec tsx scripts/measure-search.ts
 *
 * API_URL (default http://localhost:4000), PERF_EMAIL, PERF_PASSWORD,
 * PERF_SPACE_NAME as in seed-perf.ts. Read-only: it creates nothing.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const EMAIL = process.env.PERF_EMAIL ?? 'perf@wikibooklm.local';
const PASSWORD = process.env.PERF_PASSWORD ?? 'perf-seed-password';
const SPACE_NAME = process.env.PERF_SPACE_NAME ?? 'Perf — 50 sources';

const QUERIES = [
  'sleep', 'memory', 'consolidation', 'hippocampus', 'slow wave', 'REM', 'synaptic', 'plasticity',
  'circadian', 'insomnia', 'dream', 'cortex', 'learning', 'recall', 'nap', 'adolescent', 'aging',
  'melatonin', 'study', 'evidence',
];

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status}) — run seed-perf.ts first`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const headers = { cookie };

  const spaces = (await (await fetch(`${API}/spaces`, { headers })).json()) as { spaces: { id: string; name: string; sourceCount: number }[] };
  const space = spaces.spaces.find((s) => s.name === SPACE_NAME);
  if (!space) throw new Error(`space "${SPACE_NAME}" not found — run seed-perf.ts first`);
  console.log(`space ${space.id} · ${space.sourceCount} sources`);

  // one warm-up so the first connection / plan cache is not in the sample
  await fetch(`${API}/spaces/${space.id}/sources?q=warmup`, { headers });

  const samples: number[] = [];
  for (const q of QUERIES) {
    const started = performance.now();
    const res = await fetch(`${API}/spaces/${space.id}/sources?q=${encodeURIComponent(q)}`, { headers });
    const ms = performance.now() - started;
    if (!res.ok) throw new Error(`search ${q} → ${res.status}`);
    const { sources } = (await res.json()) as { sources: unknown[] };
    samples.push(ms);
    console.log(`${q.padEnd(14)} ${ms.toFixed(1).padStart(7)} ms  ${sources.length} hits`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(`\nn=${sorted.length}  p50=${percentile(sorted, 50).toFixed(1)} ms  p95=${percentile(sorted, 95).toFixed(1)} ms  max=${sorted.at(-1)!.toFixed(1)} ms  (target ≤ 500 ms)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
