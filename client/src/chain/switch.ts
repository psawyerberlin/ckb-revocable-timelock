import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes, equalBytes } from '../core/bytes.ts';
import { ALIVE_CELL_DATA, type NodeCellData, decodeNodeCellData } from '../core/cells.ts';
import { descriptorHash as computeDescriptorHash } from '../core/hash.ts';
import { type AccessTree, type Headroom, headroom as computeHeadroom, leafPositions } from '../core/tree.ts';
import type { Deployment } from './deployment.ts';
import { decodeRegistryV3, runnerLockHashFromArgs } from './runners.ts';
import type { IndexerCell, RpcClient } from './rpc.ts';

export interface SwitchContext { rpc: RpcClient; deployment: Deployment }

export interface NodeCellInfo {
  outPoint: { tx_hash: string; index: string };
  /** runner lock hash `R` (last 32 bytes of the lock args) */
  R: string;
  capacity: bigint;
  lock: { code_hash: string; hash_type: string; args: string };
  data: NodeCellData;
}

export type SwitchState = 'absent' | 'cancelled' | 'pending' | 'committed' | 'armed' | 'released' | 'inconsistent';

export interface SwitchStatus {
  alive: { outPoint: { tx_hash: string; index: string }; capacity: bigint } | null;
  nodeCells: NodeCellInfo[];
  /** common deadline (unix seconds) when all node cells agree, else null */
  deadline: bigint | null;
  /** common descriptor hash (zero before Arm) when all node cells agree, else null */
  descriptorHash: string | null;
  /** armed = Node Cell in state 1. Heartbeat freshness (SPEC §6.1) is applied through `opts.heartbeatFresh`. */
  armed: number;
  /** present when a descriptor/tree was supplied */
  headroom: Headroom | null;
  state: SwitchState;
}

const ZERO32 = '0x' + '00'.repeat(32);

export class VerificationError extends Error {
  constructor(readonly rule: 1 | 2 | 3 | 4 | 5, message: string, readonly node?: string) {
    super(`verification rule ${rule} failed${node ? ` (node ${node})` : ''}: ${message}`);
    this.name = 'VerificationError';
  }
}

const lc = (s: string) => s.toLowerCase();
const cellKey = (o: { tx_hash: string; index: string | number }) => `${lc(o.tx_hash)}:${Number(o.index)}`;

async function nodeCellsOf(T: string, ctx: SwitchContext): Promise<IndexerCell[]> {
  return ctx.rpc.getAllCells({
    script: { code_hash: ctx.deployment.node_lock.code_hash, hash_type: 'data2', args: lc(T) },
    script_type: 'lock', script_search_mode: 'prefix', with_data: true,
  });
}

async function aliveCellsOf(T: string, ctx: SwitchContext): Promise<IndexerCell[]> {
  return ctx.rpc.getAllCells({
    script: { code_hash: ctx.deployment.type_id_code_hash, hash_type: 'type', args: lc(T) },
    script_type: 'type', script_search_mode: 'exact', with_data: true,
  });
}

function isAlive(c: IndexerCell, T: string, d: Deployment): boolean {
  const t = c.output.type;
  if (!t || lc(t.code_hash) !== d.type_id_code_hash || t.hash_type !== 'type' || lc(t.args) !== lc(T)) return false;
  if (!c.output_data) return false;
  try { return equalBytes(hexToBytes(c.output_data), ALIVE_CELL_DATA); } catch { return false; }
}

function parseNode(c: IndexerCell): NodeCellInfo | null {
  try {
    const args = hexToBytes(c.output.lock.args);
    if (args.length !== 64 || !c.output_data) return null;
    return {
      outPoint: c.out_point, R: bytesToHex(args.subarray(32)), capacity: BigInt(c.output.capacity),
      lock: c.output.lock, data: decodeNodeCellData(c.output_data),
    };
  } catch { return null; }
}

export interface DescriptorLike {
  type_id?: string;
  nodes: PlanNode[];
  access_tree?: AccessTree;
  [k: string]: unknown;
}

export interface ReadSwitchOptions {
  /** descriptor (for the access tree and the node-to-leaf mapping) used to compute headroom */
  descriptor?: DescriptorLike;
  /** runners whose last heartbeat is younger than 3 × HEARTBEAT; when given, only those count as armed */
  heartbeatFresh?: (R: string) => boolean;
  mandatoryBranch?: number;
}

/** Reads the state of switch `T` from the chain (indexer only). */
export async function readSwitch(T: string, ctx: SwitchContext, opts: ReadSwitchOptions = {}): Promise<SwitchStatus> {
  const [aliveCells, rawNodes] = await Promise.all([aliveCellsOf(T, ctx), nodeCellsOf(T, ctx)]);
  const a = aliveCells.find((c) => isAlive(c, T, ctx.deployment));
  const alive = a ? { outPoint: a.out_point, capacity: BigInt(a.output.capacity) } : null;
  const nodeCells = rawNodes.map(parseNode).filter((x): x is NodeCellInfo => x !== null);
  const same = <K>(f: (n: NodeCellInfo) => K): K | null => {
    const first = nodeCells[0];
    return first && nodeCells.every((n) => f(n) === f(first)) ? f(first) : null;
  };
  const deadline = same((n) => n.data.deadline);
  const descriptorHash = same((n) => lc(n.data.descriptorHash));
  const owners = same((n) => lc(n.data.ownerLockHash));
  const isArmed = (n: NodeCellInfo) => n.data.state === 1 && (opts.heartbeatFresh?.(n.R) ?? true);
  const armedCells = nodeCells.filter(isArmed);

  let state: SwitchState;
  if (nodeCells.length === 0) state = alive ? 'pending' : 'absent';
  else if (nodeCells.some((n) => n.data.state === 2)) state = 'released';
  else if (!alive) state = 'cancelled';
  else if (deadline === null || descriptorHash === null || owners === null) state = 'inconsistent';
  else if (nodeCells.some((n) => n.data.state === 0)) state = 'pending';
  else state = descriptorHash === ZERO32 ? 'committed' : 'armed';

  let headroom: Headroom | null = null;
  const desc = opts.descriptor;
  if (desc?.access_tree) {
    const armedR = new Set(armedCells.map((n) => lc(n.R)));
    const armedPositions = leafPositions(desc.access_tree)
      .filter((p) => { const node = desc.nodes[p.node]; return node !== undefined && armedR.has(lc(node.runner_lock_hash)); })
      .map((p) => p.position);
    headroom = computeHeadroom(desc.access_tree, armedPositions, opts.mandatoryBranch === undefined ? {} : { mandatoryBranch: opts.mandatoryBranch });
  }
  return { alive, nodeCells, deadline, descriptorHash, armed: armedCells.length, headroom, state };
}

// ---- hard-fail verification (SPEC §8.3) -------------------------------------------------------------------------

export interface PlanNode { runner_lock_hash: string; service_pubkey: string; pubkey?: string; node_cell?: { tx_hash: string; index: number } }
export interface Plan { type_id?: string; nodes: PlanNode[] }

function validCompressedPubkey(hex: string): boolean {
  try {
    const b = hexToBytes(hex);
    if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) return false;
    secp.Point.fromHex(b);
    return true;
  } catch { return false; }
}

/**
 * Verifies every node of a plan or descriptor against the chain. Throws `VerificationError` carrying the number of the
 * first failing rule of SPEC §8.3. There is deliberately no parameter that relaxes any rule.
 */
export async function verifyNodes(T: string, descriptorOrPlan: DescriptorLike | Plan, ctx: SwitchContext): Promise<NodeCellInfo[]> {
  const d = ctx.deployment;
  const src = descriptorOrPlan as DescriptorLike & Plan;
  const isDescriptor = src.access_tree !== undefined;
  if (!Array.isArray(src.nodes) || src.nodes.length === 0) throw new VerificationError(1, 'no nodes to verify');
  if (src.type_id !== undefined && lc(src.type_id) !== lc(T)) throw new VerificationError(1, 'type_id differs from T');

  const [rawNodes, aliveCells, registry] = await Promise.all([
    nodeCellsOf(T, ctx), aliveCellsOf(T, ctx),
    ctx.rpc.getAllCells({ script: d.csr.registry_type_script, script_type: 'type', with_data: true }),
  ]);

  // Rule 1: live Node Cell, node-lock code hash, hash_type data2, args = T ‖ R.
  const found: NodeCellInfo[] = [];
  const seen = new Set<string>();
  for (const n of src.nodes) {
    const R = lc(n.runner_lock_hash);
    if (seen.has(R)) throw new VerificationError(1, 'runner listed twice', R);
    seen.add(R);
    const cands = rawNodes.filter((c) => {
      const l = c.output.lock;
      return lc(l.code_hash) === d.node_lock.code_hash && l.hash_type === 'data2' && lc(l.args) === lc(T) + R.slice(2);
    });
    // `node_cell` records the cell at descriptor time. Arm replaces every Node Cell, so after Arm the recorded out
    // point is dead; the unique live cell with this exact lock (args T ‖ R) is the Node Cell then, and rule 3 still
    // checks its pubkey against the recorded one.
    const recorded = n.node_cell ? cands.filter((c) => cellKey(c.out_point) === cellKey(n.node_cell!)) : [];
    const pick = recorded.length === 1 ? recorded : cands;
    if (pick.length !== 1) throw new VerificationError(1, pick.length === 0 ? 'no live Node Cell with the expected lock and args' : 'more than one candidate Node Cell', R);
    const info = parseNode(pick[0]!);
    if (!info) throw new VerificationError(1, 'Node Cell data is not a valid NodeCellData', R);
    found.push(info);
  }

  // Rule 2: R is a live registry runner on this network with the recorded service_pubkey.
  const regByR = new Map<string, ReturnType<typeof decodeRegistryV3>>();
  for (const c of registry) {
    try { if (c.output_data) regByR.set(lc(runnerLockHashFromArgs(c.output.lock.args)), decodeRegistryV3(c.output_data)); } catch { /* not a RegistryV3 cell */ }
  }
  src.nodes.forEach((n, i) => {
    const R = lc(n.runner_lock_hash);
    const reg = regByR.get(R);
    if (!reg) throw new VerificationError(2, 'no live registry cell for this runner', R);
    if (reg.network !== d.network_id) throw new VerificationError(2, `registry network ${reg.network} != ${d.network_id}`, R);
    if (lc(reg.servicePubkey) !== lc(n.service_pubkey)) throw new VerificationError(2, 'service_pubkey differs from the registry', R);
    void i;
  });

  // Rule 3: state 1 with a valid compressed pubkey (and the recorded one, when there is one).
  src.nodes.forEach((n, i) => {
    const info = found[i]!;
    if (info.data.state !== 1) throw new VerificationError(3, `Node Cell is in state ${info.data.state}, expected 1`, info.R);
    if (!validCompressedPubkey(info.data.pubkey)) throw new VerificationError(3, 'pubkey is not a valid compressed secp256k1 point', info.R);
    if (n.pubkey !== undefined && lc(n.pubkey) !== lc(info.data.pubkey)) throw new VerificationError(3, 'pubkey differs from the recorded one', info.R);
  });

  // Rule 4: deadline, owner and descriptor hash identical across all cells.
  const first = found[0]!.data;
  for (const f of found) {
    if (f.data.deadline !== first.deadline) throw new VerificationError(4, 'deadline differs between Node Cells', f.R);
    if (lc(f.data.ownerLockHash) !== lc(first.ownerLockHash)) throw new VerificationError(4, 'owner_lock_hash differs between Node Cells', f.R);
    if (lc(f.data.descriptorHash) !== lc(first.descriptorHash)) throw new VerificationError(4, 'descriptor_hash differs between Node Cells', f.R);
  }
  if (lc(first.descriptorHash) !== ZERO32) {
    if (!isDescriptor) throw new VerificationError(4, 'Node Cells are already armed but no descriptor was given to compare');
    const h = bytesToHex(computeDescriptorHash(src as never));
    if (lc(first.descriptorHash) !== h) throw new VerificationError(4, 'descriptor_hash on chain differs from the descriptor');
  }

  // Rule 5: Alive Cell live, type-id args T, data "CRT" 01.
  const alive = aliveCells.filter((c) => isAlive(c, T, d));
  if (alive.length !== 1) throw new VerificationError(5, alive.length === 0 ? 'no live Alive Cell with type-id args T and data 43525401' : 'more than one Alive Cell');
  const ac = (src as DescriptorLike).alive_cell as { tx_hash: string; index: number } | undefined;
  if (ac && cellKey(alive[0]!.out_point) !== cellKey(ac)) throw new VerificationError(5, 'Alive Cell out point differs from the descriptor');

  return found;
}
