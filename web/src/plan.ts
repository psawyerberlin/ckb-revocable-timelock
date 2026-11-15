import type { AccessTree } from '@crt/client';
import type { Draft } from './draft.ts';

/** Access tree of the draft: t-of-n over all runners, XOR a j-of-m branch over the mandatory ones (SPEC §7.3). */
export function accessTree(d: Pick<Draft, 'n' | 't' | 'mandatory' | 'mandatoryJ'>, order: string[]): AccessTree {
  const all = { kind: 'threshold' as const, t: d.t, n: order.length, leaves: order.map((_, i) => ({ node: i })) };
  const m = d.mandatory.filter((r) => order.includes(r));
  if (m.length === 0) return all;
  const mand = { kind: 'threshold' as const, t: Math.min(d.mandatoryJ, m.length), n: m.length, leaves: m.map((r) => ({ node: order.indexOf(r) })) };
  return { kind: 'xor', branches: [all, mand] };
}
