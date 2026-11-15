// Shared pieces of the transaction builders (SPEC §3, §6). Everything here works on CCC objects and reads the chain
// through the signer's `ccc.Client`, so a builder needs nothing but `{signer, deployment}`.
import { ccc } from '@ckb-ccc/core';
import { decodeJob, jobCell, jobCellDeps } from '../../vendor/csr-job.mjs';
import { bytesToHex } from '../core/bytes.ts';
import { GRACE_SECONDS, type NodeCellData, TYPE_ID_CODE_HASH, decodeNodeCellData } from '../core/cells.ts';
import { DEFAULT_BLOCK_SECONDS, SECONDS_PER_DAY, type SwitchParams } from '../core/cost.ts';
import { jobPayload } from '../core/payload.ts';
import { crtServiceId, type Deployment } from '../chain/deployment.ts';

export class TxBuildError extends Error { constructor(m: string) { super(m); this.name = 'TxBuildError'; } }

export interface TxContext {
  /** any CCC signer (JoyID, Neuron via CCC, private key, …); its client is used for every chain read */
  signer: ccc.Signer;
  deployment: Deployment;
  /** unix seconds used as "now"; default: timestamp of the tip header */
  now?: bigint | number;
  /** fee rate in shannons per 1000 bytes; default: the client's estimate */
  feeRate?: ccc.NumLike;
  /** seconds per block for block-count conversions; default deployment.block_seconds or 10.8 */
  blockSeconds?: number;
}

/** CSR job defaults that SPEC §3.3 fixes but that are not switch parameters. */
export const JOB_MAX_CYCLES = 100_000_000n;
/** `expiry_block` margin after the last expected run (≈ 7 days, SPEC §3.3). */
export const JOB_EXPIRY_MARGIN_SECONDS = 7 * SECONDS_PER_DAY;
export const ZERO32 = '0x' + '00'.repeat(32);

export const lc = (s: string) => s.toLowerCase();

export function blockSecondsOf(ctx: TxContext): number {
  return ctx.blockSeconds ?? ctx.deployment.block_seconds ?? DEFAULT_BLOCK_SECONDS;
}

export function secondsToBlocks(seconds: bigint | number, blockSeconds: number): bigint {
  const s = Number(seconds);
  return s <= 0 ? 0n : BigInt(Math.ceil(s / blockSeconds - 1e-9));
}

/**
 * Heartbeat runs needed to cover `termSeconds`: `ceil(term_blocks / HEARTBEAT)` (SPEC §3.3), with the same epsilon as
 * the cost estimator. The builders use term = deadline + GRACE − now, so that the release run is covered.
 */
export function heartbeatRuns(termSeconds: bigint | number, heartbeatBlocks: number, blockSeconds: number): number {
  const runs = Math.ceil(Number(termSeconds) / (blockSeconds * heartbeatBlocks) - 1e-9);
  return Math.max(1, runs);
}

export interface ChainNow { now: bigint; tip: bigint }

export async function chainNow(ctx: TxContext): Promise<ChainNow> {
  const header = await ctx.signer.client.getTipHeader();
  const now = ctx.now !== undefined ? BigInt(ctx.now) : header.timestamp / 1000n;
  return { now, tip: header.number };
}

export async function ownerLock(ctx: TxContext): Promise<ccc.Script> {
  return (await ctx.signer.getRecommendedAddressObj()).script;
}

export function hex32(v: string | Uint8Array, what: string): string {
  const h = typeof v === 'string' ? lc(v) : bytesToHex(v);
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new TxBuildError(`${what}: expected 32 bytes`);
  return h;
}

// ---- scripts and deps --------------------------------------------------------------------------------------------

export function typeIdScript(T: string): ccc.Script {
  return ccc.Script.from({ codeHash: TYPE_ID_CODE_HASH, hashType: 'type', args: T });
}

export function nodeLockScript(d: Deployment, T: string, R: string): ccc.Script {
  return ccc.Script.from({ codeHash: d.node_lock.code_hash, hashType: 'data2', args: T + R.slice(2) });
}

export function nodeLockDep(d: Deployment): ccc.CellDepLike {
  return { outPoint: { txHash: d.node_lock.out_point.tx_hash, index: d.node_lock.out_point.index }, depType: 'code' };
}

export function csrJobDeps(d: Deployment): ccc.CellDepLike[] {
  return jobCellDeps(d.csr.deployment).map((c) => ({ outPoint: c.outPoint, depType: 'code' as const }));
}

/** Capacity (shannons) of `bytes` occupied bytes. */
export const capacityOf = (bytes: number): bigint => ccc.fixedPointFrom(bytes);

// ---- jobs --------------------------------------------------------------------------------------------------------

export interface CrtJob {
  trigger: { kind: 'OnDemand' } | { kind: 'Every'; blocks: bigint };
  tipShannons: bigint;
  maxFeeShannons: bigint;
  maxCycles: bigint;
  payload: string;
  expiryBlock: bigint;
  refundLockHash: string;
  remainingRuns: number;
}

export function keygenJob(T: string, p: Pick<SwitchParams, 'keygenTip' | 'maxFee'>, tip: bigint, blockSeconds: number, refundLockHash: string): CrtJob {
  return {
    trigger: { kind: 'OnDemand' }, tipShannons: p.keygenTip, maxFeeShannons: p.maxFee, maxCycles: JOB_MAX_CYCLES,
    payload: bytesToHex(jobPayload(T)), expiryBlock: tip + secondsToBlocks(JOB_EXPIRY_MARGIN_SECONDS, blockSeconds),
    refundLockHash, remainingRuns: 1,
  };
}

/** Heartbeat job covering now → deadline + GRACE; expiry = end of term + ≈ 7 days. */
export function heartbeatJob(
  T: string, p: Pick<SwitchParams, 'heartbeatBlocks' | 'heartbeatTip' | 'maxFee'>,
  at: ChainNow, deadline: bigint, blockSeconds: number, refundLockHash: string,
): CrtJob {
  const term = deadline + BigInt(GRACE_SECONDS) - at.now;
  if (term <= 0n) throw new TxBuildError('deadline + GRACE is already in the past');
  const runs = heartbeatRuns(term, p.heartbeatBlocks, blockSeconds);
  const termBlocks = BigInt(runs) * BigInt(p.heartbeatBlocks);
  return {
    trigger: { kind: 'Every', blocks: BigInt(p.heartbeatBlocks) }, tipShannons: p.heartbeatTip, maxFeeShannons: p.maxFee,
    maxCycles: JOB_MAX_CYCLES, payload: bytesToHex(jobPayload(T)),
    expiryBlock: at.tip + termBlocks + secondsToBlocks(JOB_EXPIRY_MARGIN_SECONDS, blockSeconds),
    refundLockHash, remainingRuns: runs,
  };
}

/** The job cell of runner `R` (`jobCell` of csr-job.mjs, service ID = crtServiceId(R)). */
export function jobOutput(d: Deployment, R: string, job: CrtJob): { cellOutput: { capacity: bigint; lock: ccc.ScriptLike; type: ccc.ScriptLike }; outputData: string } {
  const c = jobCell({ deployment: d.csr.deployment, serviceId: crtServiceId(d, R), job });
  return {
    cellOutput: { capacity: BigInt(c.cellOutput.capacity), lock: c.cellOutput.lock as ccc.ScriptLike, type: c.cellOutput.type as ccc.ScriptLike },
    outputData: c.outputData,
  };
}

// ---- chain reads -------------------------------------------------------------------------------------------------

export interface LiveNodeCell { cell: ccc.Cell; R: string; data: NodeCellData }
export interface LiveJobCell { cell: ccc.Cell; R: string; job: CrtJob }

async function collect(gen: AsyncGenerator<ccc.Cell>): Promise<ccc.Cell[]> {
  const out: ccc.Cell[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/** Live Node Cells of switch `T` (lock = crt-node-lock data2, args prefix T); malformed cells are skipped. */
export async function liveNodeCells(T: string, ctx: TxContext): Promise<LiveNodeCell[]> {
  const d = ctx.deployment;
  const cells = await collect(ctx.signer.client.findCells({
    script: { codeHash: d.node_lock.code_hash, hashType: 'data2', args: T }, scriptType: 'lock', scriptSearchMode: 'prefix', withData: true,
  }));
  const out: LiveNodeCell[] = [];
  for (const cell of cells) {
    const l = cell.cellOutput.lock;
    if (lc(l.codeHash) !== d.node_lock.code_hash || l.hashType !== 'data2' || l.args.length !== 2 + 128 || !lc(l.args).startsWith(lc(T))) continue;
    try { out.push({ cell, R: '0x' + lc(l.args).slice(66), data: decodeNodeCellData(cell.outputData) }); } catch { /* not a NodeCellData */ }
  }
  return out;
}

/** The live Alive Cell of `T` (type-id args T, data "CRT" 01), or undefined. */
export async function liveAliveCell(T: string, ctx: TxContext): Promise<ccc.Cell | undefined> {
  const cells = await collect(ctx.signer.client.findCells({
    script: typeIdScript(T), scriptType: 'type', scriptSearchMode: 'exact', withData: true,
  }));
  const alive = cells.filter((c) => c.cellOutput.type && c.cellOutput.type.eq(typeIdScript(T)) && lc(c.outputData) === '0x43525401');
  if (alive.length > 1) throw new TxBuildError('more than one Alive Cell for T');
  return alive[0];
}

/** Live CRT job cells of switch `T` for the runners `Rs` (job type args = crtServiceId(R), payload = jobPayload(T)). */
export async function liveJobCells(T: string, Rs: string[], ctx: TxContext): Promise<LiveJobCell[]> {
  const d = ctx.deployment;
  const payload = bytesToHex(jobPayload(T));
  const out: LiveJobCell[] = [];
  for (const R of [...new Set(Rs.map(lc))]) {
    const type = { codeHash: d.csr.job_type.code_hash, hashType: 'data2' as const, args: crtServiceId(d, R) };
    const cells = await collect(ctx.signer.client.findCells({ script: type, scriptType: 'type', scriptSearchMode: 'exact', withData: true }));
    for (const cell of cells) {
      if (lc(cell.cellOutput.lock.codeHash) !== d.csr.job_lock.code_hash) continue;
      let job: CrtJob;
      try { job = decodeJob(cell.outputData) as CrtJob; } catch { continue; }
      if (lc(job.payload) !== payload) continue;
      out.push({ cell, R, job });
    }
  }
  return out;
}

export function inputOf(cell: ccc.Cell, since: ccc.NumLike = 0n): ccc.CellInputLike {
  return { previousOutput: cell.outPoint, since, cellOutput: cell.cellOutput, outputData: cell.outputData };
}

/** Node Cells must all name the signer as owner, else the owner path (SPEC §4.1) cannot be taken. */
export function assertOwner(nodes: LiveNodeCell[], ownerLockHash: string): void {
  for (const n of nodes) {
    if (lc(n.data.ownerLockHash) !== lc(ownerLockHash)) throw new TxBuildError(`Node Cell of ${n.R} has another owner_lock_hash than the signer's lock`);
  }
}

/** Adds inputs and change from the signer and returns the transaction. Guarantees an input locked by the signer. */
export async function finish(tx: ccc.Transaction, ctx: TxContext): Promise<ccc.Transaction> {
  const lock = await ownerLock(ctx);
  if (!tx.inputs.some((i) => i.cellOutput?.lock.eq(lock))) await tx.completeInputsAddOne(ctx.signer);
  await tx.completeInputsByCapacity(ctx.signer);
  await tx.completeFeeBy(ctx.signer, ctx.feeRate);
  return tx;
}
