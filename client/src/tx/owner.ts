// Owner transactions after Create (SPEC §6): Arm, Renew, Rewrap, Cancel, Reclaim.
import { ccc } from '@ckb-ccc/core';
import { bytesToHex } from '../core/bytes.ts';
import { encodeNodeCellData, newNodeCellData, NODE_CELL_DATA_LEN } from '../core/cells.ts';
import { SWITCH_PARAM_RANGES, type SwitchParams, validateSwitchParams } from '../core/cost.ts';
import {
  type LiveJobCell, type LiveNodeCell, type TxContext, TxBuildError, assertOwner, blockSecondsOf, capacityOf, chainNow, csrJobDeps,
  finish, heartbeatJob, hex32, inputOf, jobOutput, keygenJob, lc, liveAliveCell, liveJobCells, liveNodeCells, nodeLockDep,
  nodeLockScript, ownerLock, typeIdScript,
} from './common.ts';
import type { CreateRunner } from './create.ts';

export type HeartbeatParams = Pick<SwitchParams, 'heartbeatBlocks' | 'heartbeatTip' | 'maxFee'>;

/** SPEC §6.2 defaults (organiser fee 0: owner transactions after Create never pay one). */
export function defaultSwitchParams(): SwitchParams {
  const R = SWITCH_PARAM_RANGES;
  return { heartbeatBlocks: R.heartbeatBlocks.default, heartbeatTip: R.heartbeatTip.default, keygenTip: R.keygenTip.default, maxFee: R.maxFee.default, organiserFee: 0n };
}

/** Heartbeat parameters of the newest live heartbeat (`Every`) job of the switch, if any. */
export function currentHeartbeatParams(jobs: LiveJobCell[]): HeartbeatParams | null {
  const hb = jobs.filter((j) => j.job.trigger.kind === 'Every').sort((a, b) => (a.job.expiryBlock < b.job.expiryBlock ? 1 : -1))[0];
  if (!hb || hb.job.trigger.kind !== 'Every') return null;
  return { heartbeatBlocks: Number(hb.job.trigger.blocks), heartbeatTip: hb.job.tipShannons, maxFee: hb.job.maxFeeShannons };
}

async function switchNodes(T: string, ctx: TxContext): Promise<{ T: string; nodes: LiveNodeCell[]; ownerLockHash: string }> {
  const t = hex32(T, 'T');
  const nodes = await liveNodeCells(t, ctx);
  if (nodes.length === 0) throw new TxBuildError('switch has no live Node Cells');
  const ownerLockHash = (await ownerLock(ctx)).hash();
  assertOwner(nodes, ownerLockHash);
  return { T: t, nodes, ownerLockHash };
}

function commonDeadline(nodes: LiveNodeCell[]): bigint {
  const d = nodes[0]!.data.deadline;
  if (nodes.some((n) => n.data.deadline !== d)) throw new TxBuildError('Node Cells disagree on the deadline; renew first');
  return d;
}

/** Node Cell output = input with new data (same lock, same capacity). */
function addNodeUpdate(tx: ccc.Transaction, n: LiveNodeCell, patch: Partial<LiveNodeCell['data']>): void {
  tx.addInput(inputOf(n.cell));
  tx.addOutput({ capacity: n.cell.cellOutput.capacity, lock: n.cell.cellOutput.lock }, bytesToHex(encodeNodeCellData({ ...n.data, ...patch })));
}

export interface ArmOptions {
  /** parameters of heartbeat jobs that Arm creates for runners without one (default: current jobs, then SPEC defaults) */
  params?: Partial<SwitchParams>;
}

/**
 * Arm: every Node Cell (all in state 1) gets `descriptor_hash`; runners without a live heartbeat job for `T` get one
 * (covering now → deadline + GRACE). Verify the nodes (`verifyNodes`) before calling this.
 */
export async function buildArm(T: string, descriptorHash: string | Uint8Array, ctx: TxContext & ArmOptions): Promise<ccc.Transaction> {
  const { T: t, nodes, ownerLockHash } = await switchNodes(T, ctx);
  const h = hex32(descriptorHash, 'descriptorHash');
  if (h === '0x' + '00'.repeat(32)) throw new TxBuildError('descriptor hash must not be zero');
  for (const n of nodes) if (n.data.state !== 1) throw new TxBuildError(`Node Cell of ${n.R} is in state ${n.data.state}, Arm needs state 1`);
  const deadline = commonDeadline(nodes);
  const d = ctx.deployment;
  const at = await chainNow(ctx);
  const jobs = await liveJobCells(t, nodes.map((n) => n.R), ctx);

  const tx = ccc.Transaction.from({});
  for (const n of nodes) addNodeUpdate(tx, n, { descriptorHash: h });
  tx.addCellDeps(nodeLockDep(d));
  const missing = nodes.filter((n) => !jobs.some((j) => j.R === n.R && j.job.trigger.kind === 'Every'));
  if (missing.length) {
    const p: SwitchParams = { ...defaultSwitchParams(), ...currentHeartbeatParams(jobs), ...ctx.params, organiserFee: 0n };
    validateSwitchParams(p, { termSeconds: Number(deadline - at.now) });
    for (const n of missing) {
      const o = jobOutput(d, n.R, heartbeatJob(t, p, at, deadline, blockSecondsOf(ctx), ownerLockHash));
      tx.addOutput(o.cellOutput, o.outputData);
    }
    tx.addCellDeps(csrJobDeps(d));
  }
  return finish(tx, ctx);
}

/**
 * Renew: every Node Cell gets `newDeadline`; one new heartbeat job per runner covers now → newDeadline + GRACE. The
 * heartbeat parameters default to those of the switch's current heartbeat jobs (SPEC §6.2); the old jobs run out.
 */
export async function buildRenew(T: string, newDeadline: bigint | number, params: Partial<HeartbeatParams> | undefined, ctx: TxContext): Promise<ccc.Transaction> {
  const { T: t, nodes, ownerLockHash } = await switchNodes(T, ctx);
  if (nodes.some((n) => n.data.state === 2)) throw new TxBuildError('switch already released; nothing to renew');
  const deadline = BigInt(newDeadline);
  const d = ctx.deployment;
  const at = await chainNow(ctx);
  const current = currentHeartbeatParams(await liveJobCells(t, nodes.map((n) => n.R), ctx));
  const merged = { ...current, ...params };
  if (merged.heartbeatBlocks === undefined || merged.heartbeatTip === undefined || merged.maxFee === undefined)
    throw new TxBuildError('no live heartbeat job to take the parameters from; pass them explicitly');
  const p: SwitchParams = { ...defaultSwitchParams(), ...(merged as HeartbeatParams) };
  validateSwitchParams(p, { termSeconds: Number(deadline - at.now) });

  const tx = ccc.Transaction.from({});
  for (const n of nodes) addNodeUpdate(tx, n, { deadline });
  for (const n of nodes) {
    const o = jobOutput(d, n.R, heartbeatJob(t, p, at, deadline, blockSecondsOf(ctx), ownerLockHash));
    tx.addOutput(o.cellOutput, o.outputData);
  }
  tx.addCellDeps(nodeLockDep(d), ...csrJobDeps(d));
  return finish(tx, ctx);
}

export interface RewrapOptions {
  /** keygen tip and max fee of the new keygen jobs (default: current heartbeat max fee, SPEC defaults) */
  params?: Partial<SwitchParams>;
}

/**
 * Rewrap: destroys the Node Cells of `dropR` (owner path) and creates state-0 Node Cells and keygen jobs for
 * `addRunners` with the switch's deadline. A new Arm follows once the new nodes committed (it also adds their
 * heartbeat jobs).
 */
export async function buildRewrap(T: string, dropR: string[], addRunners: CreateRunner[], ctx: TxContext & RewrapOptions): Promise<ccc.Transaction> {
  const { T: t, nodes, ownerLockHash } = await switchNodes(T, ctx);
  const drop = new Set(dropR.map((r, i) => hex32(r, `dropR[${i}]`)));
  const add = addRunners.map((r, i) => hex32(r.R, `addRunners[${i}].R`));
  if (drop.size === 0 && add.length === 0) throw new TxBuildError('nothing to drop or add');
  for (const R of drop) if (!nodes.some((n) => n.R === R)) throw new TxBuildError(`no Node Cell for dropped runner ${R}`);
  const kept = nodes.filter((n) => !drop.has(n.R));
  if (new Set(add).size !== add.length) throw new TxBuildError('a new runner appears twice');
  for (const R of add) if (kept.some((n) => n.R === R)) throw new TxBuildError(`runner ${R} already has a Node Cell`);
  const deadline = commonDeadline(nodes);
  const d = ctx.deployment;
  const at = await chainNow(ctx);
  const jobs = await liveJobCells(t, nodes.map((n) => n.R), ctx);
  const p: SwitchParams = { ...defaultSwitchParams(), ...currentHeartbeatParams(jobs), ...ctx.params, organiserFee: 0n };
  validateSwitchParams(p, { networkId: d.network_id, n: kept.length + add.length, termSeconds: Number(deadline - at.now) });

  const tx = ccc.Transaction.from({});
  for (const n of nodes.filter((n) => drop.has(n.R))) tx.addInput(inputOf(n.cell));
  for (const R of add) {
    const lock = nodeLockScript(d, t, R);
    tx.addOutput({ capacity: capacityOf(8 + lock.occupiedSize + NODE_CELL_DATA_LEN), lock }, bytesToHex(encodeNodeCellData(newNodeCellData(deadline, ownerLockHash))));
  }
  for (const R of add) {
    const o = jobOutput(d, R, keygenJob(t, p, at.tip, blockSecondsOf(ctx), ownerLockHash));
    tx.addOutput(o.cellOutput, o.outputData);
  }
  if (drop.size) tx.addCellDeps(nodeLockDep(d));
  if (add.length) tx.addCellDeps(csrJobDeps(d));
  return finish(tx, ctx);
}

export interface CancelOptions { reclaimNodeCells: boolean }

/**
 * Cancel: the Alive Cell is consumed and nothing with the type-id script of `T` is created (SPEC §3.1). Node Cells are
 * reclaimed in the same transaction by default. The only other output is the signer's change: no fee of any kind.
 */
export async function buildCancel(T: string, opts: CancelOptions | undefined, ctx: TxContext): Promise<ccc.Transaction> {
  opts ??= { reclaimNodeCells: true };
  const t = hex32(T, 'T');
  const alive = await liveAliveCell(t, ctx);
  if (!alive) throw new TxBuildError('no live Alive Cell: the switch is already cancelled or never existed');
  const tx = ccc.Transaction.from({});
  tx.addInput(inputOf(alive));
  if (opts.reclaimNodeCells) {
    const nodes = await liveNodeCells(t, ctx);
    assertOwner(nodes, (await ownerLock(ctx)).hash());
    for (const n of nodes) tx.addInput(inputOf(n.cell));
    if (nodes.length) tx.addCellDeps(nodeLockDep(ctx.deployment));
  }
  await finish(tx, ctx);
  const typeId = typeIdScript(t);
  if (tx.outputs.some((o) => o.type?.eq(typeId))) throw new TxBuildError('internal: cancel would recreate the type-id cell');
  return tx;
}

export interface ReclaimOptions {
  /** runner lock hashes whose jobs to look for when their Node Cells are already gone (e.g. from the descriptor) */
  runners?: string[];
}

/**
 * Reclaim: all Node Cells of `T` (any state) and one expired job cell (`since` = absolute block `expiry_block`,
 * refund path of the CSR job lock: no registry dep). The job lock accepts a single job input per transaction, so
 * call again for the next expired job. Throws when there is nothing to reclaim.
 */
export async function buildReclaim(T: string, ctx: TxContext & ReclaimOptions): Promise<ccc.Transaction> {
  const t = hex32(T, 'T');
  const d = ctx.deployment;
  const ownerLockHash = lc((await ownerLock(ctx)).hash());
  const nodes = await liveNodeCells(t, ctx);
  assertOwner(nodes, ownerLockHash);
  const at = await chainNow(ctx);
  const Rs = [...nodes.map((n) => n.R), ...(ctx.runners ?? []).map((r, i) => hex32(r, `runners[${i}]`))];
  const expired = (await liveJobCells(t, Rs, ctx))
    .filter((j) => lc(j.job.refundLockHash) === ownerLockHash && j.job.expiryBlock <= at.tip)
    .sort((a, b) => (a.job.expiryBlock < b.job.expiryBlock ? -1 : 1));
  const job = expired[0];
  if (nodes.length === 0 && !job) throw new TxBuildError('nothing to reclaim');

  const tx = ccc.Transaction.from({});
  for (const n of nodes) tx.addInput(inputOf(n.cell));
  if (nodes.length) tx.addCellDeps(nodeLockDep(d));
  if (job) {
    if (job.job.expiryBlock >= 1n << 56n) throw new TxBuildError('expiry block out of since range');
    tx.addInput(inputOf(job.cell, job.job.expiryBlock)); // flags 0x00: absolute block number
    tx.addCellDeps(csrJobDeps(d));
  }
  return finish(tx, ctx);
}
