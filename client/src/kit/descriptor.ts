// Recipient descriptor (SPEC §8.1), key wrapping to it (§7.2) and unwrapping from releases.
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { type Rng, bytesToHex, concat, defaultRng, equalBytes, hexToBytes, toBytes, utf8 } from '../core/bytes.ts';
import type { Json } from '../core/canon.ts';
import { wrap, unwrap } from '../core/envelope.ts';
import { descriptorHash as hashJson, identity, shareCommitment } from '../core/hash.ts';
import { type AccessTree, type Headroom, TreeError, combineKey, headroom, leafPositions, splitKey, validateTree } from '../core/tree.ts';
import type { NodeState } from '../core/cells.ts';

export const DESCRIPTOR_VERSION = 1;
/** Domain of the deterministic splitting PRF (client-side only, never on chain). */
export const SPLIT_DOMAIN = 'CRT/v1/split';

export interface OutPointJson { tx_hash: string; index: number }
export interface DescriptorNode {
  runner_lock_hash: string;
  service_pubkey: string;
  peer_id?: string;
  node_cell: OutPointJson;
  pubkey: string;
  label?: string;
}
export interface Descriptor {
  version: 1;
  network_id: number;
  type_id: string;
  identity: string;
  created_at: number;
  deployment: { node_lock_code_hash: string; crt_code_hash: string; crt_data_hash: string };
  alive_cell: OutPointJson;
  nodes: DescriptorNode[];
  access_tree: AccessTree;
  share_commitments: string[];
  coordinator_url?: string;
}

export class DescriptorError extends Error {
  constructor(readonly path: string, message: string) { super(`descriptor${path ? '.' + path : ''}: ${message}`); this.name = 'DescriptorError'; }
}

// ---- validation (mirrors client/schema/descriptor.schema.json, plus the semantic rules a schema cannot express) ----

const HEX32 = /^0x[0-9a-f]{64}$/;
const PUB33 = /^0x0[23][0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const U32 = 0xffffffff;

function onlyKeys(v: Record<string, unknown>, path: string, required: string[], optional: string[] = []): void {
  for (const k of required) if (!(k in v)) throw new DescriptorError(path, `missing ${k}`);
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) throw new DescriptorError(path, `unexpected property ${k}`);
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new DescriptorError(path, `expected an integer in ${min}..${max}`);
  return v;
}
function str(v: unknown, path: string, re?: RegExp, maxLength = 1024): string {
  if (typeof v !== 'string' || v.length > maxLength) throw new DescriptorError(path, 'expected a string');
  if (re && !re.test(v)) throw new DescriptorError(path, `does not match ${re.source}`);
  return v;
}
function outPoint(v: unknown, path: string): void {
  if (!isObj(v)) throw new DescriptorError(path, 'expected an out point');
  onlyKeys(v, path, ['tx_hash', 'index']);
  str(v.tx_hash, `${path}.tx_hash`, HEX32);
  int(v.index, `${path}.index`, 0, U32);
}
/** Whether a 33-byte hex string is a point on secp256k1 (checked when building and wrapping, not by the schema). */
export function isValidPubkey(hex: string): boolean {
  try { secp.Point.fromHex(hexToBytes(hex)); return true; } catch { return false; }
}

/**
 * Validates a descriptor against the schema of SPEC §8.1 (`client/schema/descriptor.schema.json`) and the semantic
 * rules: `identity` = I(network_id, type_id), a supported access tree whose leaves index `nodes`, one commitment per
 * leaf, distinct runners and Node Cells, compressed-pubkey syntax (curve membership is checked by `buildDescriptor`
 * and `wrapKey`, so that the shared test vector with placeholder keys validates). Hex is lowercase (the hash depends on it).
 * Returns the descriptor typed; throws `DescriptorError`.
 */
export function validateDescriptor(d: unknown): Descriptor {
  if (!isObj(d)) throw new DescriptorError('', 'expected an object');
  onlyKeys(d, '', ['version', 'network_id', 'type_id', 'identity', 'created_at', 'deployment', 'alive_cell', 'nodes', 'access_tree', 'share_commitments'], ['coordinator_url']);
  if (d.version !== DESCRIPTOR_VERSION) throw new DescriptorError('version', 'must be 1');
  const networkId = int(d.network_id, 'network_id', 0, 255);
  const T = str(d.type_id, 'type_id', HEX32);
  const I = str(d.identity, 'identity', HEX32);
  int(d.created_at, 'created_at', 0, Number.MAX_SAFE_INTEGER);
  if (!isObj(d.deployment)) throw new DescriptorError('deployment', 'expected an object');
  onlyKeys(d.deployment, 'deployment', ['node_lock_code_hash', 'crt_code_hash', 'crt_data_hash']);
  for (const k of ['node_lock_code_hash', 'crt_code_hash', 'crt_data_hash']) str(d.deployment[k], `deployment.${k}`, HEX32);
  outPoint(d.alive_cell, 'alive_cell');
  if (!Array.isArray(d.nodes) || d.nodes.length < 1 || d.nodes.length > 255) throw new DescriptorError('nodes', 'expected 1..255 nodes');
  const rs = new Set<string>();
  const cells = new Set<string>();
  d.nodes.forEach((n: unknown, i: number) => {
    const p = `nodes[${i}]`;
    if (!isObj(n)) throw new DescriptorError(p, 'expected an object');
    onlyKeys(n, p, ['runner_lock_hash', 'service_pubkey', 'node_cell', 'pubkey'], ['peer_id', 'label']);
    const R = str(n.runner_lock_hash, `${p}.runner_lock_hash`, HEX32);
    str(n.service_pubkey, `${p}.service_pubkey`, PUB33);
    str(n.pubkey, `${p}.pubkey`, PUB33);
    if (n.peer_id !== undefined) str(n.peer_id, `${p}.peer_id`, undefined, 256);
    if (n.label !== undefined) str(n.label, `${p}.label`, undefined, 256);
    outPoint(n.node_cell, `${p}.node_cell`);
    const nc = n.node_cell as unknown as OutPointJson;
    if (rs.has(R)) throw new DescriptorError(`${p}.runner_lock_hash`, 'runner listed twice');
    rs.add(R);
    const key = `${nc.tx_hash}:${nc.index}`;
    if (cells.has(key)) throw new DescriptorError(`${p}.node_cell`, 'Node Cell listed twice');
    cells.add(key);
  });
  const tree = d.access_tree as AccessTree;
  if (!isObj(tree)) throw new DescriptorError('access_tree', 'expected an object');
  const checkShape = (b: Record<string, unknown>, p: string) => {
    onlyKeys(b, p, ['kind', 't', 'n', 'leaves']);
    if (Array.isArray(b.leaves)) b.leaves.forEach((l: unknown, i: number) => {
      if (!isObj(l)) throw new DescriptorError(`${p}.leaves[${i}]`, 'expected an object');
      onlyKeys(l, `${p}.leaves[${i}]`, ['node']);
    });
  };
  if (tree.kind === 'xor') {
    onlyKeys(tree as unknown as Record<string, unknown>, 'access_tree', ['kind', 'branches']);
    if (Array.isArray(tree.branches)) tree.branches.forEach((b, i) => { if (isObj(b)) checkShape(b as unknown as Record<string, unknown>, `access_tree.branches[${i}]`); });
  } else if (tree.kind === 'threshold') checkShape(tree as unknown as Record<string, unknown>, 'access_tree');
  try { validateTree(tree, d.nodes.length); } catch (e) { throw new DescriptorError('access_tree', (e as Error).message); }
  const leaves = leafPositions(tree).length;
  if (!Array.isArray(d.share_commitments) || d.share_commitments.length !== leaves) throw new DescriptorError('share_commitments', `expected one commitment per leaf (${leaves})`);
  d.share_commitments.forEach((c: unknown, i: number) => str(c, `share_commitments[${i}]`, HEX32));
  if (d.coordinator_url !== undefined) str(d.coordinator_url, 'coordinator_url', undefined, 2048);
  if (bytesToHex(identity(networkId, T)) !== I) throw new DescriptorError('identity', 'is not blake2b256("CRT/v1/cell" ‖ network_id ‖ type_id)');
  return d as unknown as Descriptor;
}

/** descriptor_hash = blake2b256("CRT/v1/descriptor" ‖ JCS(descriptor)) as 0x hex (SPEC §8.1). */
export function descriptorHash(descriptor: Descriptor): string {
  return bytesToHex(hashJson(descriptor as unknown as Json));
}

// ---- deterministic leaf secrets -------------------------------------------------------------------------------

/**
 * The share commitments are part of the descriptor, and the descriptor hash goes on chain at Arm, before anything is
 * encrypted. To let `wrapKey(K, descriptor)` produce the very shares the descriptor commits to, the splitting
 * randomness (XOR masks and Shamir coefficients) is a PRF of `K`: HMAC-SHA256(K, "CRT/v1/split" ‖ I ‖ u32 BE counter).
 */
export function splitRng(K: Uint8Array, I: Uint8Array): Rng {
  let counter = 0;
  let buf: Uint8Array = new Uint8Array(0);
  return (n) => {
    while (buf.length < n) {
      const c = new Uint8Array(4);
      new DataView(c.buffer).setUint32(0, counter++, false);
      buf = concat(buf, hmac(sha256, K, concat(utf8(SPLIT_DOMAIN), I, c)));
    }
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  };
}

/** Leaf secrets and commitments of `K` for switch identity `I` (deterministic, see `splitRng`). */
export function deriveLeafSecrets(K: Uint8Array, I: Uint8Array, tree: AccessTree): { leafSecrets: Uint8Array[]; commitments: Uint8Array[] } {
  if (K.length !== 32) throw new RangeError('K must be 32 bytes');
  if (I.length !== 32) throw new RangeError('I must be 32 bytes');
  return splitKey(K, tree, splitRng(K, I));
}

// ---- building ------------------------------------------------------------------------------------------------

export interface PlanNodeInput { runner_lock_hash: string; service_pubkey: string; peer_id?: string; label?: string }
export interface DescriptorPlan {
  /** the 32-byte secret the descriptor commits to */
  K: Uint8Array;
  access_tree: AccessTree;
  nodes: PlanNodeInput[];
  /** unix seconds; defaults to now */
  created_at?: number;
  coordinator_url?: string;
}
export interface ChainNodeCell {
  R: string;
  outPoint: { tx_hash: string; index: string | number };
  data: { state: NodeState; pubkey: string; deadline: bigint; ownerLockHash: string };
}
/** What the chain says about the switch: normally the output of `verifyNodes` and `readSwitch` (see `buildVerifiedDescriptor`). */
export interface ChainFacts {
  T: string;
  deployment: { network_id: number; node_lock: { code_hash: string }; crt_code_hash: string; crt_data_hash: string };
  aliveCell: { tx_hash: string; index: string | number };
  nodeCells: ChainNodeCell[];
}

const lc = (s: string) => s.toLowerCase();

/**
 * Builds the descriptor from the plan and the committed Node Cells (state 1). Pure: the caller must have run the
 * hard-fail verification of SPEC §8.3 first (`buildVerifiedDescriptor` does both). The result is validated.
 */
export function buildDescriptor(plan: DescriptorPlan, chain: ChainFacts): Descriptor {
  const T = lc(chain.T);
  const I = identity(chain.deployment.network_id, T);
  validateTree(plan.access_tree, plan.nodes.length);
  const nodes: DescriptorNode[] = plan.nodes.map((n) => {
    const R = lc(n.runner_lock_hash);
    const cs = chain.nodeCells.filter((c) => lc(c.R) === R);
    if (cs.length !== 1) throw new DescriptorError('nodes', `runner ${R}: expected exactly one Node Cell, found ${cs.length}`);
    const c = cs[0]!;
    if (c.data.state !== 1) throw new DescriptorError('nodes', `runner ${R}: Node Cell is in state ${c.data.state}, expected 1`);
    if (!isValidPubkey(c.data.pubkey)) throw new DescriptorError('nodes', `runner ${R}: pubkey is not a valid secp256k1 point`);
    const out: DescriptorNode = {
      runner_lock_hash: R,
      service_pubkey: lc(n.service_pubkey),
      node_cell: { tx_hash: lc(c.outPoint.tx_hash), index: Number(c.outPoint.index) },
      pubkey: lc(c.data.pubkey),
    };
    if (n.peer_id !== undefined) out.peer_id = n.peer_id;
    if (n.label !== undefined) out.label = n.label;
    return out;
  });
  const first = chain.nodeCells[0];
  for (const c of chain.nodeCells) {
    if (first && (c.data.deadline !== first.data.deadline || lc(c.data.ownerLockHash) !== lc(first.data.ownerLockHash))) {
      throw new DescriptorError('nodes', 'Node Cells disagree on deadline or owner');
    }
  }
  const { commitments } = deriveLeafSecrets(plan.K, I, plan.access_tree);
  const d: Descriptor = {
    version: 1,
    network_id: chain.deployment.network_id,
    type_id: T,
    identity: bytesToHex(I),
    created_at: plan.created_at ?? Math.floor(Date.now() / 1000),
    deployment: {
      node_lock_code_hash: lc(chain.deployment.node_lock.code_hash),
      crt_code_hash: lc(chain.deployment.crt_code_hash),
      crt_data_hash: lc(chain.deployment.crt_data_hash),
    },
    alive_cell: { tx_hash: lc(chain.aliveCell.tx_hash), index: Number(chain.aliveCell.index) },
    nodes,
    access_tree: structuredClone(plan.access_tree),
    share_commitments: commitments.map(bytesToHex),
  };
  if (plan.coordinator_url !== undefined) d.coordinator_url = plan.coordinator_url;
  return validateDescriptor(d);
}

// ---- wrapping ------------------------------------------------------------------------------------------------

/** One envelope per leaf; `aad = I ‖ position (u16 BE)`. Stored by the application next to its ciphertext. */
export interface Envelope { position: number; node: number; runner_lock_hash: string; envelope: string }

export function envelopeAad(I: Uint8Array | string, position: number): Uint8Array {
  if (!Number.isInteger(position) || position < 0 || position > 0xffff) throw new RangeError('position must be a u16');
  return concat(toBytes(I), Uint8Array.of(position >> 8, position & 0xff));
}

/**
 * Wraps the leaf secrets of `K` to the nodes' pubkeys. Refuses when `K` does not reproduce the descriptor's share
 * commitments. `rng` supplies the ephemeral keys and nonces only.
 */
export async function wrapKey(K: Uint8Array, descriptor: Descriptor, rng: Rng = defaultRng): Promise<Envelope[]> {
  const d = validateDescriptor(descriptor);
  const I = hexToBytes(d.identity);
  const { leafSecrets, commitments } = deriveLeafSecrets(K, I, d.access_tree);
  commitments.forEach((c, i) => {
    if (bytesToHex(c) !== d.share_commitments[i]) throw new DescriptorError('share_commitments', 'K does not match the descriptor');
  });
  const out: Envelope[] = [];
  for (const p of leafPositions(d.access_tree)) {
    const node = d.nodes[p.node]!;
    const env = await wrap(hexToBytes(node.pubkey), leafSecrets[p.position]!, envelopeAad(I, p.position), rng);
    out.push({ position: p.position, node: p.node, runner_lock_hash: node.runner_lock_hash, envelope: bytesToHex(env) });
  }
  return out;
}

// ---- unwrapping ----------------------------------------------------------------------------------------------

export type LeafStatus = 'ok' | 'no-release' | 'bad-privkey' | 'missing-envelope' | 'unwrap-failed' | 'commitment-mismatch';
export interface LeafReport { position: number; node: number; runner_lock_hash: string; status: LeafStatus; reason: string }
export interface UnwrapReport { K: Uint8Array | null; leaves: LeafReport[]; headroom: Headroom; message: string }

export class RecoveryError extends Error {
  constructor(message: string, readonly report: UnwrapReport) { super(message); this.name = 'RecoveryError'; }
}

const REASONS: Record<LeafStatus, string> = {
  'ok': 'share verified against its commitment',
  'no-release': 'no release value for this runner',
  'bad-privkey': 'release value does not match the pubkey of the Node Cell',
  'missing-envelope': 'no envelope for this leaf',
  'unwrap-failed': 'envelope did not decrypt (tampered, or wrapped to another key or switch)',
  'commitment-mismatch': 'decrypted share does not match its commitment (wrong or garbage value)',
};

function envelopeFor(envelopes: ReadonlyArray<Envelope | string>, position: number): string | undefined {
  const e = envelopes.find((x) => typeof x !== 'string' && x.position === position);
  if (e && typeof e !== 'string') return e.envelope;
  const s = envelopes[position];
  return typeof s === 'string' ? s : undefined;
}

function privOf(v: Uint8Array | string): Uint8Array | null {
  try {
    const b = toBytes(v);
    return b.length === 32 && secp.utils.isValidPrivateKey(b) ? b : null;
  } catch { return null; }
}

function describeHeadroom(h: Headroom, tree: AccessTree, okPositions: number[]): string {
  const bs = tree.kind === 'xor' ? tree.branches : [tree];
  const pos = leafPositions(tree);
  const parts = bs.map((b, i) => `branch ${i}: ${pos.filter((p) => p.branch === i && okPositions.includes(p.position)).length} of ${b.t} required (${b.t}-of-${b.n})`);
  const head = h.mandatory === null ? `threshold headroom ${h.threshold}` : `threshold headroom ${h.threshold}, mandatory headroom ${h.mandatory}`;
  return `${head}; ${parts.join('; ')}`;
}

/** Like `unwrapAll`, but never throws on missing or bad releases: returns `K` (or null) with a per-leaf report. */
export async function unwrapAllReport(descriptor: Descriptor, envelopes: ReadonlyArray<Envelope | string>, releases: Map<string, Uint8Array | string>): Promise<UnwrapReport> {
  const d = validateDescriptor(descriptor);
  const I = hexToBytes(d.identity);
  const rel = new Map<string, Uint8Array | string>();
  for (const [R, v] of releases) rel.set(lc(R), v);
  const leaves: LeafReport[] = [];
  const good = new Map<number, Uint8Array>();
  for (const p of leafPositions(d.access_tree)) {
    const node = d.nodes[p.node]!;
    const R = node.runner_lock_hash;
    const report = (status: LeafStatus, reason = REASONS[status]) => leaves.push({ position: p.position, node: p.node, runner_lock_hash: R, status, reason });
    const raw = rel.get(R);
    if (raw === undefined) { report('no-release'); continue; }
    const priv = privOf(raw);
    if (!priv || bytesToHex(secp.getPublicKey(priv, true)) !== node.pubkey) { report('bad-privkey'); continue; }
    const env = envelopeFor(envelopes, p.position);
    if (env === undefined) { report('missing-envelope'); continue; }
    let share: Uint8Array;
    try { share = await unwrap(priv, toBytes(env), envelopeAad(I, p.position)); } catch { report('unwrap-failed'); continue; }
    if (!equalBytes(shareCommitment(share), hexToBytes(d.share_commitments[p.position]!))) { report('commitment-mismatch'); continue; }
    good.set(p.position, share);
    report('ok');
  }
  const okPositions = [...good.keys()];
  const h = headroom(d.access_tree, okPositions);
  if (h.overall < 0) {
    return { K: null, leaves, headroom: h, message: `not enough valid releases to recover the key: ${describeHeadroom(h, d.access_tree, okPositions)}` };
  }
  try {
    const K = combineKey(d.access_tree, good);
    return { K, leaves, headroom: h, message: `key recovered: ${describeHeadroom(h, d.access_tree, okPositions)}` };
  } catch (e) {
    if (e instanceof TreeError) return { K: null, leaves, headroom: h, message: e.message };
    throw e;
  }
}

/**
 * Recovers `K` from the envelopes and the released node private keys (`R` → privkey). For each leaf: verifies
 * `pubkey(d) == node.pubkey`, unwraps, checks the share commitment; then combines. Throws `RecoveryError` (with the
 * per-leaf report and the headroom) when the valid shares are not enough.
 */
export async function unwrapAll(descriptor: Descriptor, envelopes: ReadonlyArray<Envelope | string>, releases: Map<string, Uint8Array | string>): Promise<Uint8Array> {
  const r = await unwrapAllReport(descriptor, envelopes, releases);
  if (!r.K) {
    const bad = r.leaves.filter((l) => l.status !== 'ok' && l.status !== 'no-release').map((l) => `leaf ${l.position} (${l.runner_lock_hash}): ${l.reason}`);
    throw new RecoveryError([r.message, ...bad].join('\n'), r);
  }
  return r.K;
}
