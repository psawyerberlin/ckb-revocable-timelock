import { bytesToHex, hexToBytes } from '../core/bytes.ts';
import type { Deployment } from './deployment.ts';
import type { FetchLike, RpcClient } from './rpc.ts';

// ---- RegistryV3 (CSR contracts/schemas/csr.mol), decoded by hand -------------------------------------------------

export interface RegistryV3 {
  version: number;
  peerId: string;
  servicePubkey: string;
  payoutLockHash: string;
  network: number;
  stake: { txHash: string; index: number };
  expiryMs: bigint;
  attestationSig: string;
  endpoint: string;
  prekeys: string;
}

const FIELDS = 10;

/** Decodes a molecule `RegistryV3` table (10 fields); throws on any structural inconsistency. */
export function decodeRegistryV3(data: Uint8Array | string): RegistryV3 {
  const b = typeof data === 'string' ? hexToBytes(data) : data;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (b.length < 4 + 4 * FIELDS) throw new RangeError('registry: too short');
  if (dv.getUint32(0, true) !== b.length) throw new RangeError('registry: total size mismatch');
  const off: number[] = [];
  for (let i = 0; i < FIELDS; i++) off.push(dv.getUint32(4 + 4 * i, true));
  if (off[0] !== 4 + 4 * FIELDS) throw new RangeError('registry: unexpected field count');
  off.push(b.length);
  for (let i = 0; i < FIELDS; i++) if (off[i + 1]! < off[i]! || off[i + 1]! > b.length) throw new RangeError('registry: bad offsets');
  const f = (i: number) => b.subarray(off[i]!, off[i + 1]!);
  const fixed = (i: number, len: number) => {
    const x = f(i);
    if (x.length !== len) throw new RangeError(`registry: field ${i} must be ${len} bytes`);
    return x;
  };
  const bytes = (i: number) => {
    const x = f(i);
    if (x.length < 4) throw new RangeError(`registry: field ${i} too short`);
    const n = new DataView(x.buffer, x.byteOffset, x.length).getUint32(0, true);
    if (x.length !== 4 + n) throw new RangeError(`registry: field ${i} length mismatch`);
    return x.subarray(4);
  };
  const stake = fixed(5, 36);
  const version = fixed(0, 1)[0]!;
  if (version !== 3) throw new RangeError(`registry: unsupported version ${version}`);
  return {
    version,
    peerId: new TextDecoder().decode(bytes(1)),
    servicePubkey: bytesToHex(fixed(2, 33)),
    payoutLockHash: bytesToHex(fixed(3, 32)),
    network: fixed(4, 1)[0]!,
    stake: { txHash: bytesToHex(stake.subarray(0, 32)), index: new DataView(stake.buffer, stake.byteOffset, 36).getUint32(32, true) },
    expiryMs: new DataView(fixed(6, 8).buffer, f(6).byteOffset, 8).getBigUint64(0, true),
    attestationSig: bytesToHex(fixed(7, 65)),
    endpoint: new TextDecoder().decode(bytes(8)),
    prekeys: bytesToHex(bytes(9)),
  };
}

/** Runner lock hash `R` = last 32 bytes of the dual-lock args (64 bytes owner‖runner, or 32 bytes runner-owned). */
export function runnerLockHashFromArgs(args: string): string {
  const b = hexToBytes(args);
  if (b.length !== 64 && b.length !== 32) throw new RangeError('registry lock args must be 32 or 64 bytes');
  return bytesToHex(b.subarray(b.length - 32));
}

// ---- Runner ---------------------------------------------------------------------------------------------------------

export interface MonitorInfo {
  rank: number | null;
  availability: { d7: number | null; d30: number | null; d365: number | null };
  checkType: string;
  stakeStatus: string;
  attestationStatus: string;
  country?: string;
  asn?: string;
}

export interface CrtListEntry {
  runner_lock_hash: string;
  peer_id?: string;
  label?: string;
  since?: string;
  country?: string;
  asn?: string;
  min_heartbeat_tip_shannons?: string | number;
  max_heartbeat_blocks?: number;
}

export interface Runner {
  /** runner lock hash `R` */
  R: string;
  servicePubkey: string;
  peerId: string;
  payoutLockHash: string;
  stake: { txHash: string; index: number };
  expiryMs: bigint;
  endpoint: string;
  registryOutPoint: { tx_hash: string; index: string };
  monitor: MonitorInfo | null;
  /** announced the CRT service in `deployments/<network>-runners.json` */
  crtAnnounced: boolean;
  label?: string;
  /** announced CRT but no observed performance recorded yet */
  unproven: boolean;
  minHeartbeatTipShannons?: bigint;
  maxHeartbeatBlocks?: number;
  /** country/ASN cell when known, else undefined (unknown cells never collide) */
  diversityKey?: string;
}

export interface RunnerSources {
  rpc: RpcClient;
  deployment: Deployment;
  /** parsed `deployments/<network>-runners.json` */
  crtList?: CrtListEntry[];
  fetch?: FetchLike;
  /** skip monitor lookups (offline) */
  noMonitor?: boolean;
}

function diversity(m: MonitorInfo | null, e?: CrtListEntry): string | undefined {
  const country = e?.country ?? m?.country;
  const asn = e?.asn ?? m?.asn;
  if (!country && !asn) return undefined;
  return `${country ?? '?'}/${asn ?? '?'}`;
}

async function monitorLookup(base: string, peerId: string, f: FetchLike): Promise<MonitorInfo | null> {
  try {
    const res = await f(`${base.replace(/\/+$/, '')}/v1/nodes/${encodeURIComponent(peerId)}`, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return {
      rank: typeof j.rank === 'number' ? j.rank : null,
      availability: { d7: j.availability?.d7 ?? null, d30: j.availability?.d30 ?? null, d365: j.availability?.d365 ?? null },
      checkType: String(j.check_type ?? 'none'),
      stakeStatus: String(j.stake?.status ?? 'none'),
      attestationStatus: String(j.attestation?.status ?? 'none'),
      ...(typeof j.country === 'string' ? { country: j.country } : {}),
      ...(typeof j.asn === 'string' || typeof j.asn === 'number' ? { asn: String(j.asn) } : {}),
    };
  } catch { return null; }
}

/** Reads the CSR registry cells of the network, decorates them with monitor data and the CRT runner list. */
export async function fetchRunners(src: RunnerSources): Promise<Runner[]> {
  const { rpc, deployment } = src;
  const cells = await rpc.getAllCells({ script: deployment.csr.registry_type_script, script_type: 'type', with_data: true });
  const fetchFn: FetchLike = src.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const list = new Map((src.crtList ?? []).map((e) => [e.runner_lock_hash.toLowerCase(), e]));
  const out: Runner[] = [];
  for (const c of cells) {
    let reg: RegistryV3;
    let R: string;
    try {
      if (!c.output_data) continue;
      reg = decodeRegistryV3(c.output_data);
      R = runnerLockHashFromArgs(c.output.lock.args);
    } catch { continue; }
    if (reg.network !== deployment.network_id) continue;
    const entry = list.get(R);
    const monitor = src.noMonitor || !reg.peerId ? null : await monitorLookup(deployment.monitor_url, reg.peerId, fetchFn);
    const r: Runner = {
      R, servicePubkey: reg.servicePubkey, peerId: reg.peerId, payoutLockHash: reg.payoutLockHash, stake: reg.stake,
      expiryMs: reg.expiryMs, endpoint: reg.endpoint, registryOutPoint: c.out_point, monitor,
      crtAnnounced: entry !== undefined, unproven: entry !== undefined,
    };
    if (entry?.label) r.label = entry.label;
    if (entry?.min_heartbeat_tip_shannons !== undefined) r.minHeartbeatTipShannons = BigInt(entry.min_heartbeat_tip_shannons);
    if (entry?.max_heartbeat_blocks !== undefined) r.maxHeartbeatBlocks = entry.max_heartbeat_blocks;
    const dk = diversity(monitor, entry);
    if (dk) r.diversityKey = dk;
    out.push(r);
  }
  return out;
}

// ---- selection ------------------------------------------------------------------------------------------------------

export interface SelectOptions {
  n: number;
  /** runner lock hashes that must be in the set (owner's own runners); exempt from the quality filters */
  mandatory?: string[];
  excludeSameDiversityKey?: boolean;
  /** default true: stake deposited and attestation valid (SPEC §9) */
  requireDepositedValid?: boolean;
  /** default false: only runners that announced CRT */
  requireCrt?: boolean;
  /** filter by switch parameters (runner-published limits) */
  heartbeatBlocks?: number;
  heartbeatTipShannons?: bigint;
}

export class SelectionError extends Error { constructor(m: string) { super(m); this.name = 'SelectionError'; } }

/** Pure selection: mandatory first, then candidates ranked p2p_verified first, then monitor rank, then R (deterministic). */
export function selectRunners(runners: Runner[], opts: SelectOptions): Runner[] {
  const { n } = opts;
  if (!Number.isInteger(n) || n < 1) throw new SelectionError('n must be a positive integer');
  const excl = opts.excludeSameDiversityKey ?? true;
  const byR = new Map(runners.map((r) => [r.R.toLowerCase(), r]));
  const chosen: Runner[] = [];
  const keys = new Set<string>();
  for (const m of (opts.mandatory ?? []).map((x) => x.toLowerCase())) {
    const r = byR.get(m);
    if (!r) throw new SelectionError(`mandatory runner ${m} is not in the candidate list`);
    if (chosen.includes(r)) continue;
    chosen.push(r);
    if (r.diversityKey) keys.add(r.diversityKey);
  }
  if (chosen.length > n) throw new SelectionError('more mandatory runners than n');
  const ok = (r: Runner) => {
    if ((opts.requireDepositedValid ?? true) && !(r.monitor?.stakeStatus === 'deposited' && r.monitor.attestationStatus === 'valid')) return false;
    if (opts.requireCrt && !r.crtAnnounced) return false;
    if (opts.heartbeatBlocks !== undefined && r.maxHeartbeatBlocks !== undefined && opts.heartbeatBlocks > r.maxHeartbeatBlocks) return false;
    if (opts.heartbeatTipShannons !== undefined && r.minHeartbeatTipShannons !== undefined && opts.heartbeatTipShannons < r.minHeartbeatTipShannons) return false;
    return true;
  };
  const score = (r: Runner) => (r.monitor?.checkType === 'p2p_verified' ? 0 : 1);
  const cands = runners.filter((r) => !chosen.includes(r) && ok(r)).sort((a, b) =>
    score(a) - score(b)
    || (a.monitor?.rank ?? Infinity) - (b.monitor?.rank ?? Infinity)
    || (a.R < b.R ? -1 : a.R > b.R ? 1 : 0));
  for (const r of cands) {
    if (chosen.length >= n) break;
    if (excl && r.diversityKey && keys.has(r.diversityKey)) continue;
    chosen.push(r);
    if (r.diversityKey) keys.add(r.diversityKey);
  }
  if (chosen.length < n) throw new SelectionError(`only ${chosen.length} suitable runners for n = ${n}`);
  return chosen;
}
