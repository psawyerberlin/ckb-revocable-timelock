// Chain operations of the create flow. Thin wrappers over @crt/client; no protocol logic lives here.
import { ccc } from '@ckb-ccc/core';
import {
  RpcClient, VerificationError, buildArm, buildCreate, buildVerifiedDescriptor, bytesToHex, descriptorHash, fetchRunners, generateKit,
  hexToBytes, readSwitch, wrapKey, type AccessTree, type Deployment, type Descriptor, type Runner, type SwitchStatus,
} from '@crt/client';
import { ORGANISER_ADDRESS, getDeployment, getRunnerList } from './deployments.ts';
import { accessTree } from './plan.ts';
import { switchParams, type CreatedInfo, type Draft } from './draft.ts';
import { session } from './session.ts';

export const ctxOf = (deployment: Deployment) => ({ rpc: new RpcClient(deployment.rpc_urls), deployment });

export interface RunnerRow { runner: Runner; switchesServed: number | null }

/** Directory rows: registry + monitor + CRT list, with the number of switches each runner serves (Node Cells with its R). */
export async function loadRunnerRows(): Promise<RunnerRow[]> {
  const deployment = getDeployment(session.network);
  const rpc = new RpcClient(deployment.rpc_urls);
  const runners = await fetchRunners({ rpc, deployment, crtList: getRunnerList(session.network) });
  const served = new Map<string, number>();
  let known = true;
  try {
    const cells = await rpc.getAllCells({ script: { code_hash: deployment.node_lock.code_hash, hash_type: 'data2', args: '0x' }, script_type: 'lock', script_search_mode: 'prefix' });
    for (const c of cells) {
      const a = c.output.lock.args.toLowerCase();
      if (a.length !== 2 + 2 * 64) continue;
      const R = '0x' + a.slice(-64);
      served.set(R, (served.get(R) ?? 0) + 1);
    }
  } catch { known = false; }
  return runners.map((runner) => ({ runner, switchesServed: known ? served.get(runner.R.toLowerCase()) ?? 0 : null }));
}

export function requireWallet() {
  const w = session.wallet;
  if (!w) throw new Error('Connect a wallet first.');
  return w.signer;
}

/** Builds, signs and sends Create. Returns what the later screens need. */
export async function createSwitch(d: Draft, runners: Runner[]): Promise<CreatedInfo> {
  const signer = requireWallet();
  const deployment = getDeployment(session.network);
  if (d.deadline === null) throw new Error('No deadline chosen.');
  const params = switchParams(d);
  if (params.organiserFee > 0n && !ORGANISER_ADDRESS) {
    throw new Error('This build has no organiser address, so the organiser fee must be 0. Set it to 0 on the Quote screen.');
  }
  const organiserLock = params.organiserFee > 0n ? (await ccc.Address.fromString(ORGANISER_ADDRESS, signer.client)).script : undefined;
  const mand = d.mandatory.filter((r) => d.selected.includes(r));
  const res = await buildCreate({
    signer, deployment, deadline: d.deadline, params,
    runners: runners.map((r) => ({ R: r.R, servicePubkey: r.servicePubkey })),
    ...(organiserLock && { organiserLock }),
    validation: {
      t: d.t,
      ...(mand.length > 0 && { mandatory: { j: Math.min(d.mandatoryJ, mand.length), m: mand.length } }),
      acknowledgedOneOfOne: d.ack.trim() === 'I understand',
    },
  });
  const txHash = await signer.sendTransaction(res.tx);
  return {
    T: res.T, I: res.I, txHash, deadline: d.deadline, ownerLockHash: res.ownerLockHash,
    nodes: runners.map((r) => ({ R: r.R, servicePubkey: r.servicePubkey, peerId: r.peerId, label: r.label ?? '' })),
    params: { n: d.n, t: d.t, heartbeatBlocks: params.heartbeatBlocks, heartbeatTip: params.heartbeatTip.toString(), keygenTip: params.keygenTip.toString(), maxFee: params.maxFee.toString(), organiserFee: params.organiserFee.toString() },
  };
}

export async function readCreated(c: CreatedInfo): Promise<SwitchStatus> {
  return readSwitch(c.T, ctxOf(getDeployment(session.network)));
}

export interface VerifiedArm { descriptor: Descriptor; K: Uint8Array; hash: string }

export class Mismatch extends Error {
  constructor(readonly rule: number, detail: string) { super(`MISMATCH — SPEC §8.3 rule ${rule}: ${detail}`); this.name = 'Mismatch'; }
}

/** Hard-fail verification (SPEC §8.3, no override), then the descriptor. Throws `Mismatch` and never returns a descriptor on failure. */
export async function verifyAndDescribe(d: Draft, c: CreatedInfo, K: Uint8Array): Promise<VerifiedArm> {
  const deployment = getDeployment(session.network);
  const order = c.nodes.map((n) => n.R);
  try {
    const descriptor = await buildVerifiedDescriptor({
      K,
      access_tree: accessTree({ n: d.n, t: d.t, mandatory: d.mandatory, mandatoryJ: d.mandatoryJ }, order),
      nodes: c.nodes.map((n) => ({ runner_lock_hash: n.R, service_pubkey: n.servicePubkey, ...(n.peerId && { peer_id: n.peerId }), ...(n.label && { label: n.label }) })),
    }, c.T, ctxOf(deployment));
    return { descriptor, K, hash: descriptorHash(descriptor) };
  } catch (e) {
    if (e instanceof VerificationError) throw new Mismatch(e.rule, e.message);
    throw e;
  }
}

export async function sendArm(d: Draft, c: CreatedInfo, v: VerifiedArm): Promise<string> {
  const signer = requireWallet();
  const deployment = getDeployment(session.network);
  const tx = await buildArm(c.T, v.hash, { signer, deployment, params: switchParams(d) });
  return signer.sendTransaction(tx);
}

/** Builds the kit HTML for a verified descriptor. */
export async function makeKit(c: CreatedInfo, v: VerifiedArm): Promise<string> {
  const envelopes = await wrapKey(v.K, v.descriptor);
  return generateKit({ descriptor: v.descriptor, envelopes, kitVersion: '1', deadline: c.deadline });
}

export const kitFileName = (T: string): string => `crt-kit-${T.replace(/^0x/, '').slice(0, 8)}.html`;

export function randomSecret(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

export const parseSecretHex = (s: string): Uint8Array | null => {
  const h = s.trim().replace(/^0x/i, '');
  return /^[0-9a-fA-F]{64}$/.test(h) ? hexToBytes('0x' + h) : null;
};
export { bytesToHex };

export function download(name: string, content: string, type = 'text/html'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
