// Transaction builders (CCC). Every builder returns an unsigned `ccc.Transaction` for any CCC signer.
export * from './common.ts';
export * from './create.ts';
export * from './owner.ts';

import type { ccc } from '@ckb-ccc/core';
import type { SwitchParams } from '../core/cost.ts';
import type { TxContext } from './common.ts';
import type { CreateRunner } from './create.ts';
import { type CancelOptions, type HeartbeatParams, buildArm, buildCancel, buildReclaim, buildRenew, buildRewrap, buildTopUp } from './owner.ts';

/** The owner builders bound to one `{signer, deployment}` context, with the call shapes of spec 03 phase 3. */
export function txBuilders(ctx: TxContext) {
  return {
    buildArm: (T: string, descriptorHash: string | Uint8Array, params?: Partial<SwitchParams>) =>
      buildArm(T, descriptorHash, params ? { ...ctx, params } : ctx),
    buildRenew: (T: string, newDeadline: bigint | number, params?: Partial<HeartbeatParams>) => buildRenew(T, newDeadline, params, ctx),
    buildRewrap: (T: string, dropR: string[], addRunners: CreateRunner[]) => buildRewrap(T, dropR, addRunners, ctx),
    buildCancel: (T: string, opts: CancelOptions = { reclaimNodeCells: true }) => buildCancel(T, opts, ctx),
    buildReclaim: (T: string, runners?: string[]): Promise<ccc.Transaction> => buildReclaim(T, runners ? { ...ctx, runners } : ctx),
    buildTopUp: (T: string, params?: Partial<HeartbeatParams>): Promise<ccc.Transaction> => buildTopUp(T, params ? { ...ctx, params } : ctx),
  };
}
