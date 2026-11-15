/** Cost estimator (SPEC §11.1) and switch parameter ranges (SPEC §6.2). Amounts: shannons in, CKB (number) out. */
export const SHANNONS_PER_CKB = 100_000_000n;
export const CKB = SHANNONS_PER_CKB;
export const SECONDS_PER_DAY = 86_400;

export const SWITCH_PARAM_RANGES = {
  /** `min` is the mainnet minimum; `minTestNetworks` applies to testnet (1) and devnet (2), which have few runners */
  n: { min: 3, minTestNetworks: 1, max: 16, default: 8, warnBelow: 5 },
  t: { default: 5 },
  heartbeatBlocks: { min: 1_000, max: 60_000, default: 8_000 },
  heartbeatTip: { min: CKB / 10n, default: CKB / 2n },
  keygenTip: { min: CKB / 2n, default: CKB },
  maxFee: { min: 0n, default: CKB / 500n },
  organiserFee: { min: 0n, default: 50n * CKB },
  termSeconds: { min: SECONDS_PER_DAY, warnAbove: 5 * 365 * SECONDS_PER_DAY },
  /** a 1-of-1 mandatory branch on a term longer than this needs a typed acknowledgement */
  oneOfOneMandatoryTermSeconds: 365 * SECONDS_PER_DAY,
} as const;

export interface SwitchParams {
  heartbeatBlocks: number;
  heartbeatTip: bigint;
  keygenTip: bigint;
  maxFee: bigint;
  organiserFee: bigint;
}

export class SwitchParamsError extends Error {
  constructor(public readonly errors: string[]) { super(`invalid switch parameters: ${errors.join('; ')}`); }
}

export interface SwitchParamsContext {
  /** `network_id` of the deployment (0 mainnet, 1 testnet, 2 devnet). Anything but 1 or 2 (including unset) gets the mainnet rules. */
  networkId?: number;
  n?: number;
  t?: number;
  termSeconds?: number;
  /** [j, m] of a mandatory branch, if any */
  mandatory?: { j: number; m: number };
  /** the owner typed the acknowledgement for a 1-of-1 mandatory branch on a long term */
  acknowledgedOneOfOne?: boolean;
}

/** Throws `SwitchParamsError` on any out-of-range value; returns the list of warnings otherwise. */
export function validateSwitchParams(p: SwitchParams, ctx: SwitchParamsContext = {}): string[] {
  const R = SWITCH_PARAM_RANGES;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Number.isInteger(p.heartbeatBlocks) || p.heartbeatBlocks < R.heartbeatBlocks.min || p.heartbeatBlocks > R.heartbeatBlocks.max)
    errors.push(`HEARTBEAT must be an integer between ${R.heartbeatBlocks.min} and ${R.heartbeatBlocks.max} blocks`);
  if (p.heartbeatTip < R.heartbeatTip.min) errors.push('HEARTBEAT_TIP must be at least 0.1 CKB');
  if (p.keygenTip < R.keygenTip.min) errors.push('KEYGEN_TIP must be at least 0.5 CKB');
  if (p.maxFee < R.maxFee.min) errors.push('max fee must be >= 0');
  if (p.organiserFee < R.organiserFee.min) errors.push('organiser fee must be >= 0');
  if (ctx.n !== undefined) {
    const minN = ctx.networkId === 1 || ctx.networkId === 2 ? R.n.minTestNetworks : R.n.min;
    if (!Number.isInteger(ctx.n) || ctx.n < minN || ctx.n > R.n.max) errors.push(`n must be between ${minN} and ${R.n.max}`);
    else if (ctx.n < R.n.warnBelow) warnings.push('n < 5: few runners means little redundancy or little protection');
    if (ctx.t !== undefined && (!Number.isInteger(ctx.t) || ctx.t < 1 || ctx.t > ctx.n)) errors.push('t must satisfy 1 <= t <= n');
  }
  if (ctx.termSeconds !== undefined) {
    if (ctx.termSeconds < R.termSeconds.min) errors.push('term must be at least 1 day');
    else if (ctx.termSeconds > R.termSeconds.warnAbove) warnings.push('term longer than 5 years: duration risk (SPEC §10)');
  }
  if (ctx.mandatory) {
    const { j, m } = ctx.mandatory;
    if (!Number.isInteger(j) || !Number.isInteger(m) || j < 1 || j > m) errors.push('mandatory set must satisfy 1 <= j <= m');
    else if (j === 1 && m === 1 && (ctx.termSeconds ?? 0) > R.oneOfOneMandatoryTermSeconds && !ctx.acknowledgedOneOfOne)
      errors.push('a 1-of-1 mandatory node on a term over 1 year needs a typed acknowledgement');
  }
  if (errors.length) throw new SwitchParamsError(errors);
  return warnings;
}

export const DEFAULT_BLOCK_SECONDS = 10.8;

// ---- capacity constants -----------------------------------------------------------------------------------
// Molecule `Job` (csr-job.mjs encodeJob) with the 37-byte CRT payload: 36 table header + trigger + 8+8+8 + (4+37) + 8 + 32 + 4.
const JOB_DATA_COMMON = 36 + 8 + 8 + 8 + (4 + 37) + 8 + 32 + 4;
export const HEARTBEAT_JOB_DATA_LEN = JOB_DATA_COMMON + 20; // Every(k): union id 4 + table(1 field) 8 + u64 8
export const KEYGEN_JOB_DATA_LEN = JOB_DATA_COMMON + 8; // OnDemand: union id 4 + empty table 4
/** job cell: 8 capacity + job lock (33+32) + job type (33+32) + data */
export const jobOccupiedShannons = (dataLen: number): bigint => BigInt(8 + 65 + 65 + dataLen) * CKB;
export const NODE_LOCK_BYTES = 97; // code_hash 32 + hash_type 1 + args 64
export const DEFAULT_OWNER_LOCK_BYTES = 53; // secp256k1-blake160: 32 + 1 + 20
export const nodeCellOccupiedShannons = (lockBytes = NODE_LOCK_BYTES): bigint => BigInt(8 + lockBytes + 139) * CKB;
export const aliveCellOccupiedShannons = (lockBytes = DEFAULT_OWNER_LOCK_BYTES): bigint => BigInt(8 + lockBytes + 4) * CKB;

export interface CostDeployment {
  /** default 10.8 (= 86 400 / 8 000: the reference where 8 000 blocks ≈ 1 day, SPEC §2/§11) */
  blockSeconds?: number;
  /** default 53 (secp256k1-blake160) */
  ownerLockBytes?: number;
  /** default 97 */
  nodeLockBytes?: number;
  /** default 1 CKB: network fees of the user transactions (all of them together) */
  networkFeesShannons?: bigint;
}

export interface CostInput {
  deployment: CostDeployment;
  n: number;
  termSeconds: number;
  heartbeatBlocks: number;
  heartbeatTipShannons: bigint | number;
  keygenTipShannons: bigint | number;
  maxFeeShannons: bigint | number;
  organiserFeeShannons: bigint | number;
  /** fiat per 1 CKB, if the application supplies a rate */
  fiatPerCkb?: number;
}

export interface CostLine { id: string; label: string; ckb: number; fiat?: number; group: 'spent' | 'parked' }

export interface CostEstimate {
  spentNow: number;
  spentOverTerm: number;
  parked: number;
  parkedTransient: number;
  monthly: number;
  detectionDelaySeconds: number;
  runs: number;
  lines: CostLine[];
  assumptions: string[];
}

const ckb = (s: bigint): number => Number(s) / Number(SHANNONS_PER_CKB);

export function estimateCost(i: CostInput): CostEstimate {
  const d = i.deployment;
  const blockSeconds = d.blockSeconds ?? DEFAULT_BLOCK_SECONDS;
  const ownerLock = d.ownerLockBytes ?? DEFAULT_OWNER_LOCK_BYTES;
  const nodeLock = d.nodeLockBytes ?? NODE_LOCK_BYTES;
  const netFees = d.networkFeesShannons ?? CKB;
  const hbTip = BigInt(i.heartbeatTipShannons), kgTip = BigInt(i.keygenTipShannons);
  const maxFee = BigInt(i.maxFeeShannons), orgFee = BigInt(i.organiserFeeShannons);
  if (!Number.isInteger(i.n) || i.n < 1) throw new RangeError('n must be a positive integer');
  if (!(i.termSeconds > 0) || !(blockSeconds > 0) || !Number.isInteger(i.heartbeatBlocks) || i.heartbeatBlocks < 1) throw new RangeError('invalid term or heartbeat');
  const n = BigInt(i.n);
  // runs = ceil(term_blocks / HEARTBEAT); the epsilon absorbs floating point noise on exact multiples
  const runs = Math.ceil(i.termSeconds / (blockSeconds * i.heartbeatBlocks) - 1e-9);
  const R = BigInt(runs);

  const keygenTips = n * kgTip;
  const heartbeatTips = n * R * (hbTip + maxFee);
  const spentOverTerm = keygenTips + heartbeatTips;
  const spentNow = orgFee + netFees;
  const alive = aliveCellOccupiedShannons(ownerLock);
  const nodeCells = n * nodeCellOccupiedShannons(nodeLock);
  const hbJobs = n * jobOccupiedShannons(HEARTBEAT_JOB_DATA_LEN);
  const kgJobs = n * jobOccupiedShannons(KEYGEN_JOB_DATA_LEN);
  const parked = alive + nodeCells + hbJobs;
  const months = i.termSeconds / (30 * SECONDS_PER_DAY);

  const rate = i.fiatPerCkb;
  const line = (id: string, label: string, v: bigint, group: CostLine['group']): CostLine =>
    ({ id, label, ckb: ckb(v), ...(rate !== undefined ? { fiat: ckb(v) * rate } : {}), group });
  const lines: CostLine[] = [
    line('keygen_tips', `Keygen tips (${i.n} × ${ckb(kgTip)} CKB)`, keygenTips, 'spent'),
    line('heartbeat_tips', `Heartbeat tips (${i.n} runners × ${runs} runs × (${ckb(hbTip)} tip + ${ckb(maxFee)} max fee))`, heartbeatTips, 'spent'),
    line('organiser_fee', 'Organiser fee', orgFee, 'spent'),
    line('network_fees', 'Network fees', netFees, 'spent'),
    line('alive_cell', 'Alive Cell (refundable)', alive, 'parked'),
    line('node_cells', `Node Cells (${i.n} × ${ckb(nodeCellOccupiedShannons(nodeLock))} CKB, refundable)`, nodeCells, 'parked'),
    line('heartbeat_job_cells', `Heartbeat job cells, occupied capacity (refundable)`, hbJobs, 'parked'),
    line('keygen_job_cells', 'Keygen job cells, occupied capacity (back within hours)', kgJobs, 'parked'),
  ];
  return {
    spentNow: ckb(spentNow),
    spentOverTerm: ckb(spentOverTerm + spentNow),
    parked: ckb(parked),
    parkedTransient: ckb(kgJobs),
    monthly: ckb(spentOverTerm) / months,
    detectionDelaySeconds: 3 * i.heartbeatBlocks * blockSeconds,
    runs,
    lines,
    assumptions: [
      `block time ${blockSeconds} s`,
      `owner lock ${ownerLock} bytes, crt-node-lock ${nodeLock} bytes`,
      `network fees ${ckb(netFees)} CKB in total`,
      'tips and max fees are prepaid into the job cells; unspent parts return to the owner',
      ...(rate !== undefined ? [`fiat rate ${rate} per CKB supplied by the application`] : []),
    ],
  };
}
