#!/usr/bin/env node
// CRT devnet end-to-end scenario (aiworker/05-crt-devnet-e2e.md, Phase 2).
// Run after `bash scripts/devnet-e2e.sh`:   client/node_modules/.bin/tsx scripts/devnet-scenario.mjs  (after `cd client && npm ci`) [options]
//   --state DIR     state dir of devnet-e2e.sh (default .devnet/e2e)
//   --rpc URL       devnet RPC (default http://127.0.0.1:18114)
//   --runners N     number of runners (default 3)
//   --key HEX       owner private key (default: devnet genesis key from CSR checkout, .refs/csr)
//   --help
// Steps: 1 create 2-of-3, 2 commits + verify (wrong node_lock hash -> VerificationError rule 1), 3 arm + kit + wrap K,
// 4 renew, 5 advance time past deadline+GRACE and collectReleases, 6 cancel (deletions.log, no release),
// 7 rewrap dropping runner 3 (`dropped` on its next heartbeat). Prints measured cycles per branch and the
// wall-clock from Create to all commits. Exit code = number of failed steps.
// Time travel: blocks are mined through the node's IntegrationTest RPC `generate_block_with_template` with a chosen
// timestamp, one block every ACCEL seconds (86.4 s, so that 1000 blocks = the shortest heartbeat = one day of chain time).
// Step 0 checks that the node accepts such blocks.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const argv = process.argv.slice(2);
const opt = { state: resolve(ROOT, '.devnet/e2e'), rpc: 'http://127.0.0.1:18114', runners: 3, key: process.env.CRT_OWNER_KEY ?? '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else if (a === '--state') opt.state = resolve(argv[++i]);
  else if (a === '--rpc') opt.rpc = argv[++i];
  else if (a === '--runners') opt.runners = Number(argv[++i]);
  else if (a === '--key') opt.key = argv[++i];
  else { console.error(`unknown option ${a}`); process.exit(2); }
}

const DAY = 86400;
const GRACE = 86400; // seconds, SPEC.md GRACE (24 h), as in crt-core
const ACCEL = 86.4; // chain seconds per block while time-travelling: 1000 blocks (the minimum HEARTBEAT) = 1 day
const HB = 1000; // heartbeat blocks used by every switch of this scenario
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; // {name, ok, note}
const cycles = { hold: [], keygen: [], release: [] };
let createToCommits = null;

async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, note: `${((Date.now() - t0) / 1000).toFixed(1)}s` }); }
  catch (e) { results.push({ name, ok: false, note: String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ') }); }
  const r = results.at(-1);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name} (${r.note})`);
}
const assert = (c, m) => { if (!c) throw new Error(`assertion failed: ${m}`); };

async function rpc(method, params = []) {
  const r = await fetch(opt.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const tipMs = async () => Number(BigInt((await rpc('get_tip_header')).timestamp));
// median time of the tip (what the contracts compare against)
async function medianSeconds() { return Number(BigInt((await rpc('get_blockchain_info')).median_time) / 1000n); }
/** mine n blocks with the node's own clock (enough to confirm the pending transactions: proposal + commit) */
async function mine(n = 3) { for (let i = 0; i < n; i++) await rpc('generate_block'); }
/** mine one block carrying the given timestamp (ms) */
async function mineAt(ms) {
  const t = await rpc('get_block_template', [null, null, null]);
  t.current_time = '0x' + BigInt(ms).toString(16);
  await rpc('generate_block_with_template', [t]);
}
/** mine n blocks, ACCEL seconds apart on the chain's clock */
async function mineAccel(n) { for (let i = 0; i < n; i++) await mineAt((await tipMs()) + Math.round(ACCEL * 1000)); }
/** let chain time pass: blocks ACCEL seconds apart until the median time reaches `unixSeconds` */
async function advanceTo(unixSeconds) {
  for (let i = 0; i < 20000 && (await medianSeconds()) < unixSeconds; i++) await mineAt((await tipMs()) + Math.round(ACCEL * 1000));
  assert((await medianSeconds()) >= unixSeconds, 'median time did not reach the target');
}
/** poll `fn`; between polls mine blocks so that runner transactions confirm */
async function waitFor(what, fn, { timeoutS = 600, accel = 0 } = {}) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const v = await fn(); if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    if (accel) await mineAccel(accel); else await mine(2);
    await sleep(2500);
  }
}

const dashPort = (i) => 8130 + i;
const runnerDir = (i) => resolve(opt.state, `runner${i}`);
function deletionsLines(i) {
  const f = resolve(runnerDir(i), 'data/service_data/deletions.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
}
const dash = async (i, path) => (await fetch(`http://127.0.0.1:${dashPort(i)}${path}`)).json();
/** result status byte of CRT1 results: "CRT1" ‖ status ‖ T  (0 hold, 1 keygen, 3 release, 6 dropped, ...) */
const statusOf = (resultHex) => (typeof resultHex === 'string' && resultHex.startsWith('0x43525431') ? parseInt(resultHex.slice(10, 12), 16) : null);
async function allRuns(i) {
  const out = [];
  for (const j of (await dash(i, '/api/jobs')).jobs ?? []) { const d = await dash(i, `/api/jobs/${j.id}`); out.push({ ...j, status: statusOf(d.result_hex) }); }
  return out;
}
async function sampleCycles() {
  for (let i = 1; i <= opt.runners; i++) {
    for (const r of await allRuns(i)) {
      const c = Number(r.cycles ?? 0);
      if (!c || r.status === null) continue;
      if (r.status === 1) cycles.keygen.push(c); else if (r.status === 3) cycles.release.push(c); else if (r.status === 0) cycles.hold.push(c);
    }
  }
}

// ---- client (TypeScript sources; run this script with the client's tsx) -------------------
const crt = await import(resolve(ROOT, 'client/src/index.ts'));
const cccMod = createRequire(resolve(ROOT, 'client/package.json'))('@ckb-ccc/core');
const ccc = cccMod.ccc ?? cccMod;
const deployment = crt.parseDeployment(JSON.parse(readFileSync(resolve(ROOT, 'deployments/devnet.json'), 'utf8')));
// devnet system scripts: CCC's built-in tables point at testnet cells, so the genesis dep groups are named here
// (genesis tx 1: output 0 = secp256k1 blake160 sighash dep group, output 1 = multisig dep group)
const genesis = await rpc('get_block_by_number', ['0x0']);
const depGroup = (index) => [{ cellDep: { outPoint: { txHash: genesis.transactions[1].hash, index }, depType: 'depGroup' } }];
const cccScripts = {
  [ccc.KnownScript.Secp256k1Blake160]: { codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8', hashType: 'type', cellDeps: depGroup(0) },
  [ccc.KnownScript.Secp256k1Multisig]: { codeHash: '0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8', hashType: 'type', cellDeps: depGroup(1) },
};
const cccClient = new ccc.ClientPublicTestnet({ url: opt.rpc, scripts: cccScripts });
// the owner pays with the devnet genesis (funding) key unless --key / CRT_OWNER_KEY is given (public devnet test key)
const ownerKey = opt.key || JSON.parse(readFileSync(resolve(ROOT, '.refs/csr/devtools/devnet-keys.json'), 'utf8')).genesis.privkey;
const signer = new ccc.SignerCkbPrivateKey(cccClient, ownerKey);
// every builder gets the same context; blockSeconds = ACCEL so that heartbeat job runs match the accelerated clock
const ctx = { signer, deployment, blockSeconds: ACCEL };
const swCtx = { rpc: new crt.RpcClient(opt.rpc), deployment };
// runner identity: `<runner dir>/csr` is the wrapper devnet-e2e.sh writes (pins --data-root and --config)
const runners = [1, 2, 3, 4].slice(0, opt.runners).map((i) => JSON.parse(execFileSync(resolve(runnerDir(i), 'csr'), ['identity', '--json'], { encoding: 'utf8' })));
const createRunners = runners.map((r) => ({ R: r.runner_lock_hash, servicePubkey: r.service_pubkey }));
const planNodes = (rs = runners) => rs.map((r, i) => ({ runner_lock_hash: r.runner_lock_hash, service_pubkey: r.service_pubkey, label: `runner ${i + 1}` }));
const tree2of3 = { kind: 'threshold', t: 2, n: 3, leaves: [{ node: 0 }, { node: 1 }, { node: 2 }] };
const hbParams = () => ({ ...crt.defaultSwitchParams(), heartbeatBlocks: HB });

async function send(tx) { const h = await signer.sendTransaction(tx); await mine(4); return h; }
/** Create with deadline = chain median + 1 day + 10 minutes (the client's minimum term is 1 day) */
async function createSwitch(k = 2) {
  // the client measures the term from the tip's timestamp, the contracts from the median: take the later one
  const deadline = Math.max(Math.ceil((await tipMs()) / 1000), await medianSeconds()) + DAY + 600;
  const built = await crt.buildCreate({ signer, deployment, deadline, runners: createRunners, params: hbParams(), validation: { t: k }, blockSeconds: ACCEL });
  await send(built.tx);
  return { ...built, deadline };
}
const committed = (T) => async () => (await crt.readSwitch(T, swCtx)).state === 'committed';
/** verify -> descriptor -> Arm; returns the descriptor */
async function armSwitch(sw, K) {
  const descriptor = await crt.buildVerifiedDescriptor({ K, access_tree: tree2of3, nodes: planNodes(), created_at: Math.floor(Date.now() / 1000) }, sw.T, swCtx);
  await send(await crt.buildArm(sw.T, crt.descriptorHash(descriptor), { ...ctx, params: { heartbeatBlocks: HB } }));
  await waitFor('armed', async () => (await crt.readSwitch(sw.T, swCtx)).state === 'armed');
  return descriptor;
}
const state = {};

// 0 ---------------------------------------------------------------------------------------------------------------
await step('0 time travel: the node accepts a block 1 day ahead of its clock', async () => {
  const before = await medianSeconds();
  await advanceTo(before + 3600);
  await mineAccel(25);
  assert((await medianSeconds()) >= before + 3600, 'median did not move');
});

// 1 ---------------------------------------------------------------------------------------------------------------
await step('1 create 2-of-3 switch (deadline = median + 1 day + 10 min)', async () => {
  state.createdAt = Date.now();
  state.A = await createSwitch(2);
  state.deadline = state.A.deadline;
  assert(state.A.T && state.A.I, 'create returned T and I');
});

// 2 ---------------------------------------------------------------------------------------------------------------
await step('2 wait for 3 commits; verify; wrong node_lock hash -> VerificationError rule 1', async () => {
  const T = state.A.T;
  await waitFor('3 commits', committed(T));
  createToCommits = (Date.now() - state.createdAt) / 1000;
  const plan = { type_id: T, nodes: planNodes() };
  const nodes = await crt.verifyNodes(T, plan, swCtx);
  assert(nodes.length === runners.length, 'verify returned all nodes');
  const bad = { ...deployment, node_lock: { ...deployment.node_lock, code_hash: '0x' + 'ab'.repeat(32) } };
  let err = null;
  try { await crt.verifyNodes(T, plan, { rpc: swCtx.rpc, deployment: bad }); } catch (e) { err = e; }
  assert(err instanceof crt.VerificationError, `VerificationError raised (got ${err?.name}: ${err?.message})`);
  assert(err.rule === 1, `rule 1 (got rule ${err.rule}: ${err.message})`);
});

// 3 ---------------------------------------------------------------------------------------------------------------
await step('3 arm; generate the kit; wrap a random K', async () => {
  state.K = crypto.getRandomValues(new Uint8Array(32));
  state.descriptor = await armSwitch(state.A, state.K);
  state.envelopes = await crt.wrapKeyAnchored(state.K, state.descriptor, swCtx);
  const kit = crt.generateKit({ descriptor: state.descriptor, envelopes: state.envelopes, kitVersion: crt.KIT_VERSION, deadline: state.deadline });
  assert(typeof kit === 'string' && kit.includes('<html'), 'kit generated');
});

// 4 ---------------------------------------------------------------------------------------------------------------
await step('4 renew once (+10 min): deadline moves, descriptor and I unchanged', async () => {
  const T = state.A.T;
  const before = await crt.readSwitch(T, swCtx);
  state.deadline += 600;
  await send(await crt.buildRenew(T, state.deadline, undefined, ctx));
  const after = await crt.readSwitch(T, swCtx);
  assert(after.state === 'armed', `armed after renew (state ${after.state})`);
  assert(after.deadline === BigInt(state.deadline), `deadline moved by 10 minutes (got ${after.deadline})`);
  assert(after.descriptorHash === before.descriptorHash, 'descriptor hash unchanged');
});

// 5 ---------------------------------------------------------------------------------------------------------------
await step('5 advance past deadline + GRACE; releases; collectReleases gives K', async () => {
  const T = state.A.T;
  await advanceTo(state.deadline + GRACE + 60);
  const rel = await waitFor('threshold releases', async () => {
    const r = await crt.collectReleases(T, opt.rpc, { nodeLockCodeHash: deployment.node_lock.code_hash });
    return r.size >= 2 ? r : null;
  }, { timeoutS: 900, accel: 100 });
  const got = await crt.recoverOnline(state.descriptor, state.envelopes, opt.rpc);
  assert(Buffer.from(got).equals(Buffer.from(state.K)), `recovered K equals the wrapped K (${rel.size} releases)`);
  await sampleCycles();
});

// 6 ---------------------------------------------------------------------------------------------------------------
await step('6 second switch: arm, cancel; deletions.log +1 per runner; no release afterwards', async () => {
  const B = await createSwitch(2);
  await waitFor('commits of B', committed(B.T));
  await armSwitch(B, crypto.getRandomValues(new Uint8Array(32)));
  const before = runners.map((_, i) => deletionsLines(i + 1));
  await send(await crt.buildCancel(B.T, { reclaimNodeCells: false }, ctx));
  // the next heartbeat of every runner sees the consumed Alive Cell and deletes its key
  await waitFor('deletions.log lines', async () => runners.every((_, i) => deletionsLines(i + 1) >= before[i] + 1), { timeoutS: 900, accel: 100 });
  await advanceTo(B.deadline + GRACE + 60);
  await mineAccel(1100);
  const rel = await crt.collectReleases(B.T, opt.rpc, { nodeLockCodeHash: deployment.node_lock.code_hash });
  assert(rel.size === 0, `no released key exists after cancel (got ${rel.size})`);
});

// 7 ---------------------------------------------------------------------------------------------------------------
await step('7 rewrap on a third switch: drop runner 3; runner 3 reports dropped', async () => {
  const C = await createSwitch(2);
  await waitFor('commits of C', committed(C.T));
  await armSwitch(C, crypto.getRandomValues(new Uint8Array(32)));
  await send(await crt.buildRewrap(C.T, [createRunners[2].R], [], ctx));
  await waitFor('runner 3 dropped', async () => (await allRuns(3)).some((r) => r.status === 6), { timeoutS: 900, accel: 100 });
});

// ---- report -------------------------------------------------------------------------------------------------------
const stat = (a) => (a.length ? `${Math.max(...a)} (max of ${a.length}, median ${[...a].sort((x, y) => x - y)[a.length >> 1]})` : 'n/a');
console.log('\nmeasured cycles per branch');
console.log('| branch  | cycles |\n|---------|--------|');
for (const k of ['hold', 'keygen', 'release']) console.log(`| ${k.padEnd(7)} | ${stat(cycles[k])} |`);
console.log(`\nwall-clock Create -> all commits: ${createToCommits === null ? 'n/a' : createToCommits.toFixed(1) + ' s'}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}: ${results.length - failed}/${results.length} steps`);
process.exit(Math.min(failed, 255));
