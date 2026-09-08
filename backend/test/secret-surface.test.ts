import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PRD §17 "application secrets must never be exposed to the browser". The
 * frontend side (`frontend/src/lib/public-env.test.ts`) proves the bundle reads
 * no `VITE_*` key; this is the backend side: nothing in `.env.example` is a
 * `VITE_` key that Vite would inline, `process.env` is read in `config.ts` and
 * nowhere else, and the answer-provider keys are named only there — every other
 * module goes through the parsed `env` object, so a new reader cannot leak a
 * raw key into a log or a response by accident.
 */
const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const CONFIG = join(SRC, 'config.ts');
const PROVIDER_KEYS = ['ANSWER_API_KEY', 'ANTHROPIC_API_KEY'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'generated') walk(path, out);
    } else if (/\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

describe('secret surface (PRD §17)', () => {
  it('.env.example names no VITE_ variable (REQ-281)', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    expect(example.match(/^\s*VITE_\w+/gm) ?? []).toEqual([]);
  });

  it('config.ts is the only module that reads process.env', () => {
    const readers = walk(SRC).filter((file) => file !== CONFIG && /process\.env\./.test(readFileSync(file, 'utf8')));
    expect(readers).toEqual([]);
  });

  it('config.ts is the only module that names a provider key', () => {
    const pattern = new RegExp(PROVIDER_KEYS.join('|'));
    const readers = walk(SRC).filter((file) => file !== CONFIG && pattern.test(readFileSync(file, 'utf8')));
    expect(readers).toEqual([]);
  });
});
