import { estimateCost, SECONDS_PER_DAY, type CostEstimate, type Deployment } from '@crt/client';
import { switchParams, type Draft } from './draft.ts';

/** The SPEC §11 table instantiated for the draft; always computed by `estimateCost`, never hard-coded. */
export function computeQuote(d: Draft, deployment: Pick<Deployment, 'block_seconds'> | null, nowSeconds = Math.floor(Date.now() / 1000)): CostEstimate | null {
  if (d.deadline === null) return null;
  const term = d.deadline - nowSeconds;
  if (term < SECONDS_PER_DAY) return null;
  const p = switchParams(d);
  return estimateCost({
    deployment: deployment?.block_seconds !== undefined ? { blockSeconds: deployment.block_seconds } : {},
    n: d.n, termSeconds: term, heartbeatBlocks: p.heartbeatBlocks, heartbeatTipShannons: p.heartbeatTip,
    keygenTipShannons: p.keygenTip, maxFeeShannons: p.maxFee, organiserFeeShannons: p.organiserFee,
  });
}

/** Spent now = organiser fee + network fees; locked = parked cells (SPEC §11). */
export const spentLabel = (q: CostEstimate): string => `${fmt(q.spentOverTerm)} CKB`;
export const lockedLabel = (q: CostEstimate): string => `${fmt(q.parked)} CKB`;
export const fmt = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 }).replace(/,/g, ' ');
