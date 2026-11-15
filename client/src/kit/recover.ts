// Recovery from the chain (state-2 Node Cells) or from pasted release values (SPEC §8.2). Used by the kit as well:
// only core modules and the fetch-based RPC client, no CCC.
import * as secp from '@noble/secp256k1';
import { bytesToHex, equalBytes, hexToBytes } from '../core/bytes.ts';
import { ALIVE_CELL_DATA, NODE_CELL_DATA_LEN, TYPE_ID_CODE_HASH, decodeNodeCellData } from '../core/cells.ts';
import { type FetchLike, RpcClient } from '../chain/rpc.ts';
import { type Descriptor, type Envelope, descriptorHash, unwrapAll, validateDescriptor } from './descriptor.ts';

export interface CollectOptions {
  /** code hash of `crt-node-lock` (the descriptor's `deployment.node_lock_code_hash`) */
  nodeLockCodeHash: string;
  fetch?: FetchLike;
}

const lc = (s: string) => s.toLowerCase();
const HEX32 = /^0x[0-9a-f]{64}$/;

function pubOfPriv(priv: Uint8Array): string | null {
  try { return secp.utils.isValidPrivateKey(priv) ? bytesToHex(secp.getPublicKey(priv, true)) : null; } catch { return null; }
}

function client(rpcUrls: string | string[], fetch?: FetchLike): RpcClient {
  return new RpcClient(rpcUrls, fetch ? { fetch } : {});
}

/**
 * Reads the live Node Cells of switch `T` (lock `crt-node-lock`, `hash_type data2`, args prefix `T`) and returns the
 * released private keys of those in state 2 whose `pubkey(privkey)` equals the recorded pubkey, keyed by `R`.
 */
export async function collectReleases(T: string, rpcUrls: string | string[], opts: CollectOptions): Promise<Map<string, string>> {
  if (!HEX32.test(lc(T))) throw new Error('T must be 32-byte hex');
  const codeHash = lc(opts.nodeLockCodeHash);
  const cells = await client(rpcUrls, opts.fetch).getAllCells({
    script: { code_hash: codeHash, hash_type: 'data2', args: lc(T) },
    script_type: 'lock', script_search_mode: 'prefix', with_data: true,
  });
  const out = new Map<string, string>();
  for (const c of cells) {
    const l = c.output.lock;
    if (lc(l.code_hash) !== codeHash || l.hash_type !== 'data2') continue;
    const args = lc(l.args);
    if (args.length !== 2 + 128 || !args.startsWith(lc(T))) continue;
    try {
      const data = decodeNodeCellData(c.output_data ?? '');
      if (data.state !== 2) continue;
      if (pubOfPriv(hexToBytes(data.privkey)) !== lc(data.pubkey)) continue;
      out.set('0x' + args.slice(66), lc(data.privkey));
    } catch { /* not a Node Cell */ }
  }
  return out;
}

export interface KitSwitchStatus {
  alive: boolean;
  nodes: { R: string; state: number; deadline: bigint; descriptorHash: string }[];
  /** common deadline when all Node Cells agree */
  deadline: bigint | null;
  /** true when every Node Cell carries this descriptor's hash */
  descriptorHashMatches: boolean;
  released: number;
}

/** Light read of the switch for the kit: Alive Cell presence and the Node Cells of the descriptor's `T`. */
export async function readSwitchOnline(descriptor: Descriptor, rpcUrls: string | string[], opts: { fetch?: FetchLike } = {}): Promise<KitSwitchStatus> {
  const d = validateDescriptor(descriptor);
  const rpc = client(rpcUrls, opts.fetch);
  const [aliveCells, nodeCells] = await Promise.all([
    rpc.getAllCells({ script: { code_hash: TYPE_ID_CODE_HASH, hash_type: 'type', args: d.type_id }, script_type: 'type', script_search_mode: 'exact', with_data: true }),
    rpc.getAllCells({ script: { code_hash: d.deployment.node_lock_code_hash, hash_type: 'data2', args: d.type_id }, script_type: 'lock', script_search_mode: 'prefix', with_data: true }),
  ]);
  const alive = aliveCells.some((c) => {
    try { return !!c.output_data && equalBytes(hexToBytes(c.output_data), ALIVE_CELL_DATA); } catch { return false; }
  });
  const nodes: KitSwitchStatus['nodes'] = [];
  for (const c of nodeCells) {
    const args = lc(c.output.lock.args);
    if (c.output.lock.hash_type !== 'data2' || args.length !== 130) continue;
    try {
      const data = decodeNodeCellData(c.output_data ?? '');
      nodes.push({ R: '0x' + args.slice(66), state: data.state, deadline: data.deadline, descriptorHash: lc(data.descriptorHash) });
    } catch { /* skip */ }
  }
  const h = descriptorHash(d);
  const first = nodes[0];
  return {
    alive,
    nodes,
    deadline: first && nodes.every((n) => n.deadline === first.deadline) ? first.deadline : null,
    descriptorHashMatches: nodes.length > 0 && nodes.every((n) => n.descriptorHash === h),
    released: nodes.filter((n) => n.state === 2).length,
  };
}

/**
 * Turns pasted release values into `R → privkey`. Accepted forms, one per entry: a 32-byte private key (matched to
 * the node whose pubkey it produces), `R:privkey` / `R privkey`, or the 139-byte data of a state-2 Node Cell.
 * Values that match no node are returned in `unmatched`.
 */
export function parseReleases(descriptor: Descriptor, pasted: string[]): { releases: Map<string, string>; unmatched: string[] } {
  const byPub = new Map(descriptor.nodes.map((n) => [n.pubkey, n.runner_lock_hash]));
  const releases = new Map<string, string>();
  const unmatched: string[] = [];
  for (const entry of pasted.flatMap((p) => p.split(/[\n,;]+/))) {
    const s = entry.trim().toLowerCase();
    if (!s) continue;
    const pair = /^(0x[0-9a-f]{64})\s*[:=\s]\s*(0x)?([0-9a-f]{64})$/.exec(s);
    if (pair) { releases.set(pair[1]!, '0x' + pair[3]!); continue; }
    const hex = s.startsWith('0x') ? s : '0x' + s;
    let priv: string | null = null;
    try {
      const b = hexToBytes(hex);
      if (b.length === 32) priv = hex;
      else if (b.length === NODE_CELL_DATA_LEN) { const d = decodeNodeCellData(b); if (d.state === 2) priv = lc(d.privkey); }
    } catch { /* not hex */ }
    const pub = priv ? pubOfPriv(hexToBytes(priv)) : null;
    const R = pub ? byPub.get(pub) : undefined;
    if (R && priv) releases.set(R, priv);
    else unmatched.push(entry.trim());
  }
  return { releases, unmatched };
}

/** Offline recovery from release values pasted by hand (see `parseReleases`). */
export async function recoverOffline(descriptor: Descriptor, envelopes: ReadonlyArray<Envelope | string>, pasted: string[]): Promise<Uint8Array> {
  const { releases } = parseReleases(validateDescriptor(descriptor), pasted);
  return unwrapAll(descriptor, envelopes, releases);
}

/** Online recovery: `collectReleases` on the descriptor's switch, then `unwrapAll`. */
export async function recoverOnline(descriptor: Descriptor, envelopes: ReadonlyArray<Envelope | string>, rpcUrls: string | string[], opts: { fetch?: FetchLike } = {}): Promise<Uint8Array> {
  const d = validateDescriptor(descriptor);
  const releases = await collectReleases(d.type_id, rpcUrls, { nodeLockCodeHash: d.deployment.node_lock_code_hash, ...opts });
  return unwrapAll(d, envelopes, releases);
}
