import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Rng } from '../src/core/bytes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const readJson = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(here, ...p), 'utf8'));
export const vector = (name: string) => readJson('..', '..', 'spec', 'vectors', name);

/** Deterministic xorshift-based rng for tests. */
export function seeded(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = s & 0xff; }
    return out;
  };
}
