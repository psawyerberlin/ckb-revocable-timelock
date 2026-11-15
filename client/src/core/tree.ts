import { type Rng, defaultRng } from './bytes.ts';
import { combine, split } from './shamir.ts';
import { shareCommitment } from './hash.ts';

export interface Leaf { node: number }
export interface ThresholdTree { kind: 'threshold'; t: number; n: number; leaves: Leaf[] }
export interface XorTree { kind: 'xor'; branches: ThresholdTree[] }
export type AccessTree = ThresholdTree | XorTree;

export interface LeafPosition { position: number; node: number; branch: number; indexInBranch: number }

export class TreeError extends Error {}

/** Supported shapes (SPEC §7.3): `threshold`, and `xor` of >= 2 `threshold` branches. Anything else is rejected. */
export function validateTree(tree: AccessTree, nodeCount?: number): void {
  const checkThreshold = (b: ThresholdTree, where: string) => {
    if (!b || b.kind !== 'threshold') throw new TreeError(`${where}: expected a threshold`);
    if (!Number.isInteger(b.t) || !Number.isInteger(b.n) || b.t < 1 || b.t > b.n || b.n > 255) throw new TreeError(`${where}: need 1 <= t <= n <= 255`);
    if (!Array.isArray(b.leaves) || b.leaves.length !== b.n) throw new TreeError(`${where}: leaves.length must equal n`);
    for (const l of b.leaves) {
      if (!l || !Number.isInteger(l.node) || l.node < 0) throw new TreeError(`${where}: invalid leaf`);
      if (nodeCount !== undefined && l.node >= nodeCount) throw new TreeError(`${where}: leaf node ${l.node} out of range`);
    }
    if (new Set(b.leaves.map((l) => l.node)).size !== b.leaves.length) throw new TreeError(`${where}: a node appears twice in one threshold`);
  };
  if (!tree || typeof tree !== 'object') throw new TreeError('tree must be an object');
  if (tree.kind === 'threshold') return checkThreshold(tree, 'tree');
  if (tree.kind === 'xor') {
    if (!Array.isArray(tree.branches) || tree.branches.length < 2) throw new TreeError('xor needs at least two branches');
    tree.branches.forEach((b, i) => checkThreshold(b, `branch ${i}`));
    return;
  }
  throw new TreeError(`unsupported tree kind ${(tree as { kind?: unknown }).kind}`);
}

const branchesOf = (tree: AccessTree): ThresholdTree[] => (tree.kind === 'xor' ? tree.branches : [tree]);

/** Depth-first positions of all leaves; `position` is the `tree_position` used in envelope AAD. */
export function leafPositions(tree: AccessTree): LeafPosition[] {
  validateTree(tree);
  const out: LeafPosition[] = [];
  branchesOf(tree).forEach((b, branch) => b.leaves.forEach((l, indexInBranch) => out.push({ position: out.length, node: l.node, branch, indexInBranch })));
  return out;
}

/** Splits K: XOR across branches (last branch = K ⊕ others), Shamir inside each branch. Indexed by leaf position. */
export function splitKey(K: Uint8Array, tree: AccessTree, rng: Rng = defaultRng): { leafSecrets: Uint8Array[]; commitments: Uint8Array[] } {
  validateTree(tree);
  const bs = branchesOf(tree);
  const secrets: Uint8Array[] = [];
  let acc = K.slice();
  bs.forEach((_, i) => {
    if (i < bs.length - 1) {
      const r = rng(K.length);
      secrets.push(r);
      for (let k = 0; k < acc.length; k++) acc[k] = acc[k]! ^ r[k]!;
    } else secrets.push(acc);
  });
  const leafSecrets: Uint8Array[] = [];
  bs.forEach((b, i) => leafSecrets.push(...split(secrets[i]!, b.t, b.n, rng)));
  return { leafSecrets, commitments: leafSecrets.map((s) => shareCommitment(s)) };
}

/** Recombines K from the leaf secrets that are available (keyed by leaf position). Throws with the shortfall otherwise. */
export function combineKey(tree: AccessTree, leafSecrets: Map<number, Uint8Array>): Uint8Array {
  const pos = leafPositions(tree);
  const bs = branchesOf(tree);
  let K: Uint8Array | undefined;
  bs.forEach((b, i) => {
    const have = pos.filter((p) => p.branch === i && leafSecrets.has(p.position)).map((p) => leafSecrets.get(p.position)!);
    if (have.length < b.t) throw new TreeError(`branch ${i}: ${have.length} of ${b.t} required shares available`);
    const s = combine(have.slice(0, b.t));
    if (!K) K = s;
    else for (let k = 0; k < K.length; k++) K[k] = K[k]! ^ s[k]!;
  });
  return K!;
}

export interface Headroom { threshold: number; mandatory: number | null; overall: number; mandatoryBranch: number | null }

/**
 * Headroom (SPEC §6.1), reported separately: threshold headroom = armed − t, mandatory headroom = armed_mandatory − j.
 * For a plain threshold tree there is no mandatory part. For `xor`, the mandatory branch is `opts.mandatoryBranch`
 * or, by default, the branch with the fewest leaves (last on ties); the remaining branches form the threshold part
 * (minimum over them). Values may be negative: the secret is then not recoverable.
 */
export function headroom(tree: AccessTree, armedPositions: Iterable<number>, opts: { mandatoryBranch?: number } = {}): Headroom {
  const pos = leafPositions(tree);
  const armed = new Set(armedPositions);
  const bs = branchesOf(tree);
  const room = bs.map((b, i) => pos.filter((p) => p.branch === i && armed.has(p.position)).length - b.t);
  if (tree.kind === 'threshold') return { threshold: room[0]!, mandatory: null, overall: room[0]!, mandatoryBranch: null };
  let m = opts.mandatoryBranch;
  if (m === undefined) {
    m = 0;
    bs.forEach((b, i) => { if (b.n <= bs[m!]!.n) m = i; });
  }
  if (!Number.isInteger(m) || m < 0 || m >= bs.length) throw new TreeError('mandatoryBranch out of range');
  const threshold = Math.min(...room.filter((_, i) => i !== m));
  const mandatory = room[m]!;
  return { threshold, mandatory, overall: Math.min(threshold, mandatory), mandatoryBranch: m };
}
