import { SECONDS_PER_DAY } from '@crt/client';

export const YEAR_SECONDS = 365 * SECONDS_PER_DAY;

export interface DurationRisk {
  band: 'short' | 'medium' | 'long' | 'too-short';
  /** plain-language risk statement (SPEC §10) */
  text: string;
  recommendation: string;
  /** SPEC §10: mandatory disclaimer for terms > 5 years */
  quantum: boolean;
}

export const QUANTUM_DISCLAIMER =
  'Quantum warning: CRT relies on secp256k1 and on symmetric encryption. It makes no post-quantum claim. Over a term of more than five years, assume that a sufficiently capable quantum computer could break the keys that protect your secret.';

/** Plain-language duration risk per SPEC §10 (< 1 yr, 1–3 yr, > 3 yr; quantum disclaimer > 5 yr). */
export function durationRisk(termSeconds: number): DurationRisk {
  const quantum = termSeconds > 5 * YEAR_SECONDS;
  if (termSeconds < SECONDS_PER_DAY) {
    return { band: 'too-short', quantum, text: 'The deadline must be at least one day away.', recommendation: 'Pick a later date.' };
  }
  if (termSeconds < YEAR_SECONDS) {
    return {
      band: 'short', quantum,
      text: 'Under a year: low risk. Runners rarely disappear within a year.',
      recommendation: 'A threshold alone is enough, for example 5 of 8.',
    };
  }
  if (termSeconds <= 3 * YEAR_SECONDS) {
    return {
      band: 'medium', quantum,
      text: 'One to three years: some of the runners you pick will probably leave (descriptor rot), and each one that leaves uses up part of your safety margin.',
      recommendation: 'Use a wider set, for example 6 of 12, and watch the headroom.',
    };
  }
  return {
    band: 'long', quantum,
    text: 'Over three years: expect many runners to change or leave. Without maintenance the secret is likely to become unrecoverable.',
    recommendation: 'Use a wide set plus a 2-of-3 mandatory group on runners you control yourself, rewrap at every renewal, and never use a 1-of-1 mandatory node.',
  };
}

/** Suggested (n, t) for a term, matching the recommendation text. */
export function suggestedStructure(termSeconds: number): { n: number; t: number } {
  if (termSeconds < YEAR_SECONDS) return { n: 8, t: 5 };
  return { n: 12, t: 6 };
}
