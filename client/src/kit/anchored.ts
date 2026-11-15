// Chain-anchored variants: hard-fail verification (SPEC §8.3) before building a descriptor or wrapping a key.
import { type Rng, defaultRng } from '../core/bytes.ts';
import { type SwitchContext, VerificationError, readSwitch, verifyNodes } from '../chain/switch.ts';
import { type Descriptor, type DescriptorPlan, type Envelope, buildDescriptor, descriptorHash, validateDescriptor, wrapKey } from './descriptor.ts';

/** Verifies every planned node on chain (state 1, registry, Alive Cell, …), then builds the descriptor for Arm. */
export async function buildVerifiedDescriptor(plan: DescriptorPlan, T: string, ctx: SwitchContext): Promise<Descriptor> {
  const nodeCells = await verifyNodes(T, { type_id: T, nodes: plan.nodes }, ctx);
  const s = await readSwitch(T, ctx);
  if (!s.alive) throw new VerificationError(5, 'no live Alive Cell');
  return buildDescriptor(plan, { T, deployment: ctx.deployment, aliveCell: s.alive.outPoint, nodeCells });
}

/**
 * `wrapKey` that refuses an unanchored descriptor: every rule of SPEC §8.3 must hold against the descriptor, and the
 * Node Cells must already carry its hash (the switch is armed with exactly this descriptor).
 */
export async function wrapKeyAnchored(K: Uint8Array, descriptor: Descriptor, ctx: SwitchContext, rng: Rng = defaultRng): Promise<Envelope[]> {
  const d = validateDescriptor(descriptor);
  const cells = await verifyNodes(d.type_id, d, ctx);
  const h = descriptorHash(d);
  for (const c of cells) {
    if (c.data.descriptorHash.toLowerCase() !== h) throw new VerificationError(4, 'switch is not armed with this descriptor', c.R);
  }
  return wrapKey(K, d, rng);
}
