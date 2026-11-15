// Create (SPEC §6): Alive Cell, n Node Cells (state 0), n keygen jobs, optional organiser fee, change.
import { ccc } from '@ckb-ccc/core';
import { bytesToHex, hexToBytes } from '../core/bytes.ts';
import { aliveCellData, encodeNodeCellData, newNodeCellData, NODE_CELL_DATA_LEN } from '../core/cells.ts';
import { type SwitchParams, type SwitchParamsContext, validateSwitchParams } from '../core/cost.ts';
import { identity } from '../core/hash.ts';
import type { Deployment } from '../chain/deployment.ts';
import {
  type TxContext, TxBuildError, ZERO32, blockSecondsOf, capacityOf, chainNow, csrJobDeps, finish, hex32, jobOutput, keygenJob,
  lc, nodeLockScript, ownerLock, typeIdScript,
} from './common.ts';

export interface CreateRunner { R: string; servicePubkey: string }

export interface BuildCreateArgs {
  signer: ccc.Signer;
  deployment: Deployment;
  /** unix seconds */
  deadline: bigint | number;
  runners: CreateRunner[];
  params: SwitchParams;
  /** lock of the organiser fee output; required when `params.organiserFee > 0` */
  organiserLock?: ccc.ScriptLike;
  /** t, mandatory set and acknowledgement, passed to `validateSwitchParams` */
  validation?: Omit<SwitchParamsContext, 'n' | 'termSeconds'>;
  now?: bigint | number;
  feeRate?: ccc.NumLike;
  blockSeconds?: number;
}

export interface BuildCreateResult {
  tx: ccc.Transaction;
  /** type-id args of the Alive Cell */
  T: string;
  /** switch identity blake2b256("CRT/v1/cell" ‖ network_id ‖ T) */
  I: string;
  aliveCellIndex: number;
  /** output index of the Node Cell of `runners[i]` */
  nodeCellIndices: number[];
  /** output index of the keygen job of `runners[i]` */
  keygenJobIndices: number[];
  organiserFeeIndex: number | null;
  ownerLockHash: string;
  /** validated parameters; pass them to `buildArm`, which creates the heartbeat jobs */
  params: SwitchParams;
  warnings: string[];
}

/**
 * Builds the unsigned Create transaction. Heartbeat jobs are not part of it: CSR's `csr-job-type` allows only one job
 * output per service group in a transaction, and both jobs of a runner share the service ID; they come with Arm.
 */
export async function buildCreate(a: BuildCreateArgs): Promise<BuildCreateResult> {
  const d = a.deployment;
  const ctx: TxContext = { signer: a.signer, deployment: d, ...(a.now !== undefined && { now: a.now }), ...(a.feeRate !== undefined && { feeRate: a.feeRate }), ...(a.blockSeconds !== undefined && { blockSeconds: a.blockSeconds }) };
  const deadline = BigInt(a.deadline);
  const at = await chainNow(ctx);
  const n = a.runners.length;
  const warnings = validateSwitchParams(a.params, { ...a.validation, networkId: d.network_id, n, termSeconds: Number(deadline - at.now) });

  const Rs = a.runners.map((r, i) => hex32(r.R, `runners[${i}].R`));
  if (new Set(Rs).size !== Rs.length) throw new TxBuildError('a runner appears twice');
  a.runners.forEach((r, i) => {
    const pk = hexToBytes(r.servicePubkey);
    if (pk.length !== 33 || (pk[0] !== 2 && pk[0] !== 3)) throw new TxBuildError(`runners[${i}].servicePubkey: expected a compressed secp256k1 key`);
  });

  const owner = await ownerLock(ctx);
  const ownerLockHash = owner.hash();
  const bs = blockSecondsOf(ctx);
  const p = a.params;

  const layout = (T: string): { cellOutput: ccc.CellOutputLike; outputData: string }[] => {
    const outs: { cellOutput: ccc.CellOutputLike; outputData: string }[] = [];
    const aliveType = typeIdScript(T);
    const aliveData = bytesToHex(aliveCellData());
    const aliveCap = capacityOf(8 + owner.occupiedSize + aliveType.occupiedSize + 4);
    outs.push({ cellOutput: { capacity: aliveCap, lock: owner, type: aliveType }, outputData: aliveData });
    for (const R of Rs) {
      const lock = nodeLockScript(d, T, R);
      const cap = capacityOf(8 + lock.occupiedSize + NODE_CELL_DATA_LEN);
      outs.push({ cellOutput: { capacity: cap, lock }, outputData: bytesToHex(encodeNodeCellData(newNodeCellData(deadline, ownerLockHash))) });
    }
    for (const R of Rs) outs.push(jobOutput(d, R, keygenJob(T, p, at.tip, bs, ownerLockHash)));
    return outs;
  };

  const tx = ccc.Transaction.from({});
  for (const o of layout(ZERO32)) tx.addOutput(o.cellOutput, o.outputData);
  let organiserFeeIndex: number | null = null;
  if (p.organiserFee > 0n) {
    if (!a.organiserLock) throw new TxBuildError('organiser fee given without an organiser lock');
    const lock = ccc.Script.from(a.organiserLock);
    if (p.organiserFee < capacityOf(8 + lock.occupiedSize)) throw new TxBuildError('organiser fee is below the occupied capacity of its output');
    tx.addOutput({ capacity: p.organiserFee, lock }, '0x');
    organiserFeeIndex = tx.outputs.length - 1;
  }
  tx.addCellDeps(csrJobDeps(d));

  // T depends on the first input, which only exists once inputs are collected; the layout has the same size for every
  // T, so outputs are rewritten in place before the fee is completed.
  await tx.completeInputsByCapacity(a.signer);
  const first = tx.inputs[0];
  if (!first) throw new TxBuildError('no input could be collected from the signer');
  const T = lc(ccc.hashTypeId(first, 0));
  layout(T).forEach((o, i) => tx.setOutput(i, o.cellOutput, o.outputData));
  await finish(tx, ctx);
  if (lc(ccc.hashTypeId(tx.inputs[0]!, 0)) !== T) throw new TxBuildError('first input changed while completing the fee');

  return {
    tx, T, I: bytesToHex(identity(d.network_id, T)), aliveCellIndex: 0,
    nodeCellIndices: Rs.map((_, i) => 1 + i), keygenJobIndices: Rs.map((_, i) => 1 + n + i),
    organiserFeeIndex, ownerLockHash: lc(ownerLockHash), params: { ...p }, warnings,
  };
}
