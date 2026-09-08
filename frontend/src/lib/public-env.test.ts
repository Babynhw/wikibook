import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PRD §17 "application secrets must never be exposed to the browser". Vite
 * inlines every `import.meta.env.VITE_*` read into the bundle, so the set of
 * keys the source reads is the set of values that can ever reach a browser.
 * Today that set is empty: the API is same-origin (`/api`) and needs no key.
 */
const PUBLIC_KEYS = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe('public environment surface (PRD §17)', () => {
  it('reads no VITE_ variable the allow-list does not name (REQ-281)', () => {
    const src = join(import.meta.dirname, '..');
    const found = new Set<string>();
    for (const file of walk(src)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
        found.add(match[1]!);
      }
    }
    expect([...found].filter((key) => !PUBLIC_KEYS.has(key))).toEqual([]);
  });
});
