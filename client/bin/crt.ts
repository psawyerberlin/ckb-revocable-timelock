#!/usr/bin/env -S npx tsx
// `npx crt …` — command line front end of @crt/client. Every command needs only `--rpc URL` (no coordinator).
// Transactions are printed unsigned (for offline signing); `--key` signs and sends, on a devnet only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ccc } from '@ckb-ccc/core';
import { bytesToHex, hexToBytes } from '../src/core/bytes.ts';
import type { SwitchParams } from '../src/core/cost.ts';
import type { AccessTree } from '../src/core/tree.ts';
import { type Deployment, loadDeployment } from '../src/chain/deployment.ts';
import { RpcClient } from '../src/chain/rpc.ts';
import { type CrtListEntry, fetchRunners, selectRunners } from '../src/chain/runners.ts';
import { type SwitchContext, readSwitch } from '../src/chain/switch.ts';
import { type TxContext, buildCancel, buildCreate, buildRenew, buildArm, defaultSwitchParams } from '../src/tx/index.ts';
import {
  type Descriptor, type Envelope, buildVerifiedDescriptor, generateKit, recoverOffline, recoverOnline, validateDescriptor, wrapKey,
  descriptorHash, KIT_VERSION,
} from '../src/kit/index.ts';

const HELP = `crt — CKB Revocable Timelock

usage: crt <command> [options]

commands:
  runners                         list CSR runners that can serve as custodians
  plan                            choose n runners and an access tree; writes a plan file
  create                          unsigned Create transaction for a plan
  status T                        state of switch T
  arm T                           verify nodes, build descriptor + envelopes, unsigned Arm transaction
  renew T                         move the deadline (--deadline)
  cancel T                        cancel the switch (one transaction, no fee)
  kit                             write the self-contained recovery kit (HTML)
  recover                         recover K from the chain (--rpc) or pasted release values (--release)

common options:
  --network NAME     deployments/<NAME>.json (default testnet)
  --rpc URL[,URL]    CKB RPC endpoint(s); default: the deployment's rpc_urls
  --deployments DIR  directory with deployment files (default deployments)
  --owner ADDRESS    owner address; the transaction is printed unsigned
  --key HEX          sign and send with this private key (devnet only)
  --help

options per command:
  plan      --n 8 --t 5 [--mandatory R,R] [--out plan.json] [--no-monitor]
  create    --plan plan.json --deadline <unix|ISO date> [--out tx.json] [--heartbeat BLOCKS] [--heartbeat-tip SHANNONS]
            [--keygen-tip SHANNONS] [--max-fee SHANNONS] [--organiser-fee SHANNONS --organiser-address ADDR]
  arm       --plan plan.json [--secret HEX] [--descriptor-out descriptor.json] [--envelopes-out envelopes.json]
            [--secret-out FILE] [--out tx.json]    (K is generated unless --secret is given; keep it out of shell history)
  renew     --deadline <unix|ISO date> [--out tx.json]
  cancel    [--keep-node-cells] [--out tx.json]
  kit       --descriptor descriptor.json --envelopes envelopes.json [--out kit.html]
  recover   --descriptor descriptor.json --envelopes envelopes.json [--release HEX ...] [--out secret.hex]
`;

class UsageError extends Error {}

interface Args { cmd: string; pos: string[]; opt: Map<string, string[]>; flag: Set<string> }
const FLAGS = new Set(['help', 'no-monitor', 'keep-node-cells', 'json']);

function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const a: Args = { cmd, pos: [], opt: new Map(), flag: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!;
    if (!x.startsWith('--')) { a.pos.push(x); continue; }
    const name = x.slice(2);
    if (FLAGS.has(name)) { a.flag.add(name); continue; }
    const v = rest[++i];
    if (v === undefined) throw new UsageError(`--${name} needs a value`);
    a.opt.set(name, [...(a.opt.get(name) ?? []), v]);
  }
  return a;
}

const get = (a: Args, k: string): string | undefined => a.opt.get(k)?.at(-1);
const need = (a: Args, k: string): string => { const v = get(a, k); if (v === undefined) throw new UsageError(`--${k} is required`); return v; };
const readJson = (f: string): any => JSON.parse(readFileSync(f, 'utf8'));
const num = (a: Args, k: string, d: number): number => { const v = get(a, k); return v === undefined ? d : Number(v); };
const big = (a: Args, k: string, d: bigint): bigint => { const v = get(a, k); return v === undefined ? d : BigInt(v); };

function parseTime(s: string): bigint {
  if (/^\d+$/.test(s)) return BigInt(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new UsageError(`cannot parse time "${s}" (unix seconds or ISO date)`);
  return BigInt(Math.floor(ms / 1000));
}

function out(a: Args, k: string, text: string, label: string): void {
  const f = get(a, k);
  if (f) { writeFileSync(f, text.endsWith('\n') ? text : text + '\n'); console.error(`${label} written to ${f}`); } else console.log(text);
}

/** `--deployments`, else `deployments/` of the current directory, else of the repository root (running from `client/`). */
function deploymentsDir(a: Args): string {
  return get(a, 'deployments') ?? (existsSync('deployments') ? 'deployments' : existsSync('../deployments') ? '../deployments' : 'deployments');
}

interface Env { deployment: Deployment; network: string; rpcUrls: string[]; rpc: RpcClient; sctx: SwitchContext; a: Args }

async function env(a: Args): Promise<Env> {
  const network = get(a, 'network') ?? 'testnet';
  const deployment = await loadDeployment(network, deploymentsDir(a));
  const rpcUrls = get(a, 'rpc') ? get(a, 'rpc')!.split(',').map((s) => s.trim()).filter(Boolean) : deployment.rpc_urls;
  const rpc = new RpcClient(rpcUrls);
  return { deployment, network, rpcUrls, rpc, sctx: { rpc, deployment }, a };
}

function cccClient(e: Env): ccc.Client {
  const url = e.rpcUrls[0]!;
  return e.network === 'mainnet' ? new ccc.ClientPublicMainnet({ url }) : new ccc.ClientPublicTestnet({ url });
}

/** A signer for the builders: `--key` (devnet only) signs, `--owner` yields an unsigned transaction. */
async function signerOf(e: Env): Promise<{ signer: ccc.Signer; canSign: boolean }> {
  const client = cccClient(e);
  const key = get(e.a, 'key');
  if (key) {
    if (e.network === 'mainnet' || e.network === 'testnet') throw new UsageError('--key is for devnet only; sign the printed transaction offline on ' + e.network);
    return { signer: new ccc.SignerCkbPrivateKey(client, key), canSign: true };
  }
  const owner = get(e.a, 'owner');
  if (!owner) throw new UsageError('give --owner ADDRESS (unsigned transaction) or --key HEX (devnet)');
  const { script } = await ccc.Address.fromString(owner, client);
  return { signer: new ccc.SignerCkbScriptReadonly(client, script), canSign: false };
}

async function emitTx(e: Env, signer: ccc.Signer, canSign: boolean, tx: ccc.Transaction, extra: Record<string, unknown> = {}): Promise<void> {
  if (canSign) {
    const hash = await signer.sendTransaction(tx);
    console.log(JSON.stringify({ ...extra, sent: hash }, null, 2));
    return;
  }
  const text = JSON.stringify({ ...extra, transaction: JSON.parse(tx.stringify()) }, null, 2);
  out(e.a, 'out', text, 'unsigned transaction');
}

function switchParams(a: Args): SwitchParams {
  const d = defaultSwitchParams();
  return {
    heartbeatBlocks: num(a, 'heartbeat', d.heartbeatBlocks), heartbeatTip: big(a, 'heartbeat-tip', d.heartbeatTip),
    keygenTip: big(a, 'keygen-tip', d.keygenTip), maxFee: big(a, 'max-fee', d.maxFee), organiserFee: big(a, 'organiser-fee', d.organiserFee),
  };
}

function crtList(e: Env): CrtListEntry[] {
  const f = `${deploymentsDir(e.a)}/${e.network}-runners.json`;
  if (!existsSync(f)) return [];
  const j = readJson(f);
  return Array.isArray(j) ? j : (j.runners ?? []);
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

// ---- commands -----------------------------------------------------------------------------------------------

async function cmdRunners(a: Args): Promise<void> {
  const e = await env(a);
  const rs = await fetchRunners({ rpc: e.rpc, deployment: e.deployment, crtList: crtList(e), noMonitor: a.flag.has('no-monitor') });
  if (a.flag.has('json')) { console.log(json(rs)); return; }
  for (const r of rs) {
    console.log([r.R, r.label ?? '-', r.monitor?.stakeStatus ?? '?', r.monitor?.attestationStatus ?? '?', r.crtAnnounced ? 'crt' : '-', r.diversityKey ?? '-'].join('\t'));
  }
  console.error(`${rs.length} runners on ${e.network}`);
}

async function cmdPlan(a: Args): Promise<void> {
  const e = await env(a);
  const n = num(a, 'n', 8);
  const t = num(a, 't', Math.ceil((n * 5) / 8));
  const mandatory = get(a, 'mandatory')?.split(',').filter(Boolean);
  const rs = await fetchRunners({ rpc: e.rpc, deployment: e.deployment, crtList: crtList(e), noMonitor: a.flag.has('no-monitor') });
  const chosen = selectRunners(rs, { n, ...(mandatory && { mandatory }), requireDepositedValid: !a.flag.has('no-monitor') });
  const access_tree: AccessTree = { kind: 'threshold', t, n: chosen.length, leaves: chosen.map((_, i) => ({ node: i })) };
  const plan = {
    network: e.network,
    nodes: chosen.map((r) => ({ runner_lock_hash: r.R, service_pubkey: r.servicePubkey, ...(r.peerId && { peer_id: r.peerId }), ...(r.label && { label: r.label }) })),
    access_tree,
  };
  out(a, 'out', json(plan), 'plan');
}

async function cmdCreate(a: Args): Promise<void> {
  const e = await env(a);
  const { signer, canSign } = await signerOf(e);
  const plan = readJson(need(a, 'plan'));
  const organiser = get(a, 'organiser-address');
  const res = await buildCreate({
    signer, deployment: e.deployment, deadline: parseTime(need(a, 'deadline')),
    runners: plan.nodes.map((n: any) => ({ R: n.runner_lock_hash, servicePubkey: n.service_pubkey })),
    params: switchParams(a),
    ...(organiser && { organiserLock: (await ccc.Address.fromString(organiser, cccClient(e))).script }),
    validation: { t: plan.access_tree?.t },
  });
  for (const w of res.warnings) console.error(`warning: ${w}`);
  await emitTx(e, signer, canSign, res.tx, { T: res.T, I: res.I, warnings: res.warnings });
}

async function cmdStatus(a: Args): Promise<void> {
  const T = a.pos[0] ?? need(a, 'T');
  const e = await env(a);
  const descriptor = get(a, 'descriptor') ? validateDescriptor(readJson(get(a, 'descriptor')!)) : undefined;
  const s = await readSwitch(T, e.sctx, descriptor ? { descriptor: descriptor as any } : {});
  console.log(json({ state: s.state, deadline: s.deadline, descriptorHash: s.descriptorHash, armed: s.armed, nodes: s.nodeCells.map((n) => ({ R: n.R, state: n.data.state })), headroom: s.headroom }));
}

async function cmdArm(a: Args): Promise<void> {
  const T = a.pos[0] ?? need(a, 'T');
  const e = await env(a);
  const { signer, canSign } = await signerOf(e);
  const plan = readJson(need(a, 'plan'));
  const secretHex = get(a, 'secret');
  const K = secretHex ? hexToBytes(secretHex) : globalThis.crypto.getRandomValues(new Uint8Array(32));
  // hard-fail verification (SPEC §8.3) runs inside; there is no way to skip it
  const descriptor = await buildVerifiedDescriptor({ K, access_tree: plan.access_tree, nodes: plan.nodes }, T, e.sctx);
  const envelopes = await wrapKey(K, descriptor);
  const sf = get(a, 'secret-out');
  if (sf) { writeFileSync(sf, bytesToHex(K) + '\n', { mode: 0o600 }); console.error(`secret K written to ${sf} (keep it private)`); }
  else if (!secretHex) console.error('note: K was generated and not stored; pass --secret-out FILE to keep it');
  writeFileSync(get(a, 'descriptor-out') ?? 'descriptor.json', JSON.stringify(descriptor, null, 2) + '\n');
  writeFileSync(get(a, 'envelopes-out') ?? 'envelopes.json', JSON.stringify(envelopes, null, 2) + '\n');
  console.error('descriptor and envelopes written; envelopes only open once the nodes release');
  const tx = await buildArm(T, descriptorHash(descriptor), { signer, deployment: e.deployment });
  await emitTx(e, signer, canSign, tx, { T, descriptor_hash: descriptorHash(descriptor) });
}

async function cmdRenew(a: Args): Promise<void> {
  const T = a.pos[0] ?? need(a, 'T');
  const e = await env(a);
  const { signer, canSign } = await signerOf(e);
  const ctx: TxContext = { signer, deployment: e.deployment };
  const tx = await buildRenew(T, parseTime(need(a, 'deadline')), undefined, ctx);
  await emitTx(e, signer, canSign, tx, { T });
}

async function cmdCancel(a: Args): Promise<void> {
  const T = a.pos[0] ?? need(a, 'T');
  const e = await env(a);
  const { signer, canSign } = await signerOf(e);
  const tx = await buildCancel(T, { reclaimNodeCells: !a.flag.has('keep-node-cells') }, { signer, deployment: e.deployment });
  await emitTx(e, signer, canSign, tx, { T });
}

function loadKitInputs(a: Args): { descriptor: Descriptor; envelopes: Envelope[] } {
  return { descriptor: validateDescriptor(readJson(need(a, 'descriptor'))), envelopes: readJson(need(a, 'envelopes')) };
}

async function cmdKit(a: Args): Promise<void> {
  const { descriptor, envelopes } = loadKitInputs(a);
  out(a, 'out', generateKit({ descriptor, envelopes, kitVersion: KIT_VERSION }), 'recovery kit');
}

async function cmdRecover(a: Args): Promise<void> {
  const { descriptor, envelopes } = loadKitInputs(a);
  const pasted = a.opt.get('release') ?? [];
  const K = pasted.length
    ? await recoverOffline(descriptor, envelopes, pasted)
    : await recoverOnline(descriptor, envelopes, get(a, 'rpc')?.split(',') ?? (await env(a)).rpcUrls);
  out(a, 'out', bytesToHex(K), 'recovered secret');
}

const COMMANDS: Record<string, (a: Args) => Promise<void>> = {
  runners: cmdRunners, plan: cmdPlan, create: cmdCreate, status: cmdStatus, arm: cmdArm, renew: cmdRenew, cancel: cmdCancel, kit: cmdKit, recover: cmdRecover,
};

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (a.flag.has('help') || a.cmd === 'help' || a.cmd === '--help') { console.log(HELP); return; }
  const f = COMMANDS[a.cmd];
  if (!f) throw new UsageError(`unknown command "${a.cmd}"`);
  await f(a);
}

main().catch((err) => {
  console.error(`${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  process.exit(err instanceof UsageError ? 2 : 1);
});
