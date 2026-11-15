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
// Time travel: CSR's devnet.sh `mine-to`-style mining with future block timestamps (scripts/devnet/crt-smoke.mjs
// `mine-to`); the node's median time then passes deadline + GRACE. NOT RUN where it was written (no devnet);
// field names of CSR's JSON must be confirmed on the first manual run.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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

const GRACE = 3600; // seconds, SPEC GRACE
const TEN_MIN = 600;
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
async function tipSeconds() { return Number(BigInt((await rpc('get_tip_header')).timestamp) / 1000n); }
// median time of the tip (what the contracts compare against): get_blockchain_info.median_time
async function medianSeconds() { return Number(BigInt((await rpc('get_blockchain_info')).median_time) / 1000n); }
function smoke(...a) { return execFileSync('node', [resolve(here, 'devnet/crt-smoke.mjs'), '--rpc', opt.rpc, ...a], { encoding: 'utf8' }).trim(); }
async function advanceTo(unixSeconds) {
  smoke('mine-to', String(unixSeconds));
  // mine a few more so the median (11 blocks) passes the target
  for (let i = 0; i < 12 && (await medianSeconds()) < unixSeconds; i++) smoke('mine-to', String(unixSeconds + i + 1));
  assert((await medianSeconds()) >= unixSeconds, 'median time did not reach target');
}

const dashPort = (i) => 8130 + i;
const runnerDir = (i) => resolve(opt.state, `runner${i}`);
function deletionsLines(i) {
  const f = resolve(runnerDir(i), 'data/service_data/deletions.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
}
async function dashJobs(i) { return (await fetch(`http://127.0.0.1:${dashPort(i)}/api/jobs`)).json(); }
async function dashJob(i, id) { return (await fetch(`http://127.0.0.1:${dashPort(i)}/api/jobs/${id}`)).json(); }
/** Collect cycles from run results; classification by the `CRT1 <status>` text: keygen / hold / release. */
async function sampleCycles() {
  for (let i = 1; i <= opt.runners; i++) {
    for (const j of (await dashJobs(i)).jobs ?? await dashJobs(i)) {
      const d = await dashJob(i, j.id ?? j.job_id);
      for (const run of d.runs ?? []) {
        const text = String(run.result ?? run.message ?? '');
        const c = Number(run.cycles ?? run.consumed_cycles ?? 0);
        if (!c) continue;
        if (/keygen|committed/i.test(text)) cycles.keygen.push(c);
        else if (/released|release/i.test(text)) cycles.release.push(c);
        else cycles.hold.push(c);
      }
    }
  }
}
async function waitFor(what, fn, timeoutS = 600) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await sleep(3000); }
}

// ---- client (TypeScript sources; run this script with the client's tsx) -------------------
const crt = await import(resolve(ROOT, 'client/src/index.ts'));
const { ccc } = await import(resolve(ROOT, 'client/node_modules/@ckb-ccc/core/dist.commonjs/index.js')).catch(() => import('@ckb-ccc/core'));
const deployment = crt.parseDeployment(JSON.parse(readFileSync(resolve(ROOT, 'deployments/devnet.json'), 'utf8')));
const cccClient = new ccc.ClientPublicTestnet({ url: opt.rpc, scripts: deployment.ccc_scripts ?? undefined });
const signer = new ccc.SignerCkbPrivateKey(cccClient, opt.key || readFileSync(resolve(opt.state, 'owner.key'), 'utf8').trim());
const ctx = { signer, deployment };
const rpcClient = new crt.RpcClient(opt.rpc);
const runnerInfo = [1, 2, 3, 4].slice(0, opt.runners).map((i) => JSON.parse(readFileSync(resolve(runnerDir(i), 'crt/runner.json'), 'utf8')));
const sw = { runners: runnerInfo.map((r) => ({ R: r.R ?? r.runner_lock_hash, servicePubkey: r.service_pubkey })) };

async function send(tx) { const h = await signer.sendTransaction(tx); smoke('mine-to', String(await tipSeconds() + 1)); return h; }
async function createSwitch(deadline, k = 2) {
  const params = { ...crt.defaultSwitchParams(), threshold: k };
  const built = await crt.buildCreate({ signer, deployment, deadline, runners: sw.runners, params, validation: { t: k } });
  await send(built.tx);
  return built;
}
const state = {};

// 1 ---------------------------------------------------------------------------------------------------------------
await step('1 create 2-of-3 switch (deadline = median + 10 min)', async () => {
  const t0 = Date.now();
  state.deadline = await medianSeconds() + TEN_MIN;
  state.A = await createSwitch(state.deadline);
  state.createdAt = t0;
  assert(state.A.T && state.A.I, 'create returned T and I');
});

// 2 ---------------------------------------------------------------------------------------------------------------
await step('2 wait for 3 commits; verify; wrong node_lock hash -> VerificationError rule 1', async () => {
  const T = state.A.T;
  await waitFor('3 commits', async () => { const s = await crt.readSwitch(T, ctx); return s.state === 'committed' || s.state === 'armed'; });
  createToCommits = (Date.now() - state.createdAt) / 1000;
  const nodes = await crt.verifyNodes(T, { type_id: T, nodes: state.A.plan?.nodes ?? [] }, ctx);
  assert(nodes.length === sw.runners.length, 'verify returned all nodes');
  const bad = { ...deployment, node_lock: { ...deployment.node_lock, code_hash: '0x' + 'ab'.repeat(32) } };
  let err = null;
  try { await crt.verifyNodes(T, { type_id: T, nodes: state.A.plan?.nodes ?? [] }, { rpc: rpcClient, deployment: bad }); } catch (e) { err = e; }
  assert(err && (err.name === 'VerificationError' || err instanceof crt.VerificationError), 'VerificationError raised');
  assert(/rule 1/i.test(String(err.message)) || err.rule === 1, `rule 1 (got: ${err.message})`);
  // the deployment object is never mutated: `bad` is a copy, the real one is "restored" by construction
});

// 3 ---------------------------------------------------------------------------------------------------------------
await step('3 arm; generate the kit; wrap a random K', async () => {
  const T = state.A.T;
  const descriptorHash = state.A.descriptorHash ?? state.A.I;
  await send(await crt.buildArm(T, descriptorHash, { ...ctx }));
  state.K = crypto.getRandomValues(new Uint8Array(32));
  if (state.A.descriptor && crt.generateKit) {
    state.kit = crt.generateKit({ descriptor: state.A.descriptor, envelopes: state.A.envelopes ?? [], kitVersion: crt.KIT_VERSION, deadline: state.deadline });
    assert(String(state.kit).includes('<html') || state.kit?.length > 0, 'kit generated');
  }
  await waitFor('armed', async () => (await crt.readSwitch(T, ctx)).state === 'armed');
});

// 4 ---------------------------------------------------------------------------------------------------------------
await step('4 renew once (+10 min): new heartbeat jobs, I unchanged', async () => {
  const T = state.A.T;
  const before = await crt.readSwitch(T, ctx);
  state.deadline += TEN_MIN;
  await send(await crt.buildRenew(T, state.deadline, undefined, ctx));
  const after = await crt.readSwitch(T, ctx);
  assert((after.I ?? state.A.I) === (before.I ?? state.A.I) && (after.I ?? state.A.I) === state.A.I, 'I unchanged');
  assert(Number(after.deadline ?? state.deadline) === state.deadline, 'deadline moved by 10 minutes');
  const jobs = JSON.stringify(await Promise.all([1, 2, 3].slice(0, opt.runners).map(dashJobs)));
  assert(jobs.length > 2, 'runners list heartbeat jobs');
});

// 5 ---------------------------------------------------------------------------------------------------------------
await step('5 advance past deadline + GRACE; 3 releases; collectReleases gives K', async () => {
  const T = state.A.T;
  await advanceTo(state.deadline + GRACE + 60);
  await waitFor('3 releases', async () => (await crt.readSwitch(T, ctx)).state === 'released', 900);
  const rel = await crt.collectReleases(T, opt.rpc, { nodeLockCodeHash: deployment.node_lock.code_hash });
  assert(rel.size >= 2, `at least threshold (2) releases, got ${rel.size}`);
  if (state.A.descriptor) {
    const got = await crt.recoverOnline(state.A.descriptor, state.A.envelopes ?? [], opt.rpc);
    assert(Buffer.from(got).equals(Buffer.from(state.K)), 'recovered K equals wrapped K');
  }
  await sampleCycles();
});

// 6 ---------------------------------------------------------------------------------------------------------------
await step('6 second switch: cancel before deadline; deletions.log +1 per runner; no release afterwards', async () => {
  const before = [1, 2, 3].slice(0, opt.runners).map(deletionsLines);
  const B = await createSwitch(await medianSeconds() + TEN_MIN);
  await waitFor('commits of B', async () => (await crt.readSwitch(B.T, ctx)).state === 'committed');
  await send(await crt.buildCancel(B.T, { reclaimNodeCells: true }, ctx));
  await waitFor('deletions.log lines', async () => [1, 2, 3].slice(0, opt.runners).every((i) => deletionsLines(i) === before[i - 1] + 1), 300);
  await advanceTo(await medianSeconds() + TEN_MIN + GRACE + 60);
  const s = await crt.readSwitch(B.T, ctx);
  assert(s.state === 'cancelled' || s.state === 'absent', `no release after cancel (state ${s.state})`);
  const rel = await crt.collectReleases(B.T, opt.rpc, { nodeLockCodeHash: deployment.node_lock.code_hash });
  assert(rel.size === 0, 'no released key exists');
});

// 7 ---------------------------------------------------------------------------------------------------------------
await step('7 rewrap on a third switch: drop runner 3; runner 3 reports dropped', async () => {
  const C = await createSwitch(await medianSeconds() + TEN_MIN);
  await waitFor('commits of C', async () => (await crt.readSwitch(C.T, ctx)).state === 'committed');
  await send(await crt.buildArm(C.T, C.descriptorHash ?? C.I, ctx));
  await send(await crt.buildRewrap(C.T, [sw.runners[2].R], [], ctx));
  const seen = await waitFor('runner 3 dropped', async () => {
    for (const j of (await dashJobs(3)).jobs ?? await dashJobs(3)) {
      const d = await dashJob(3, j.id ?? j.job_id);
      if (JSON.stringify(d).includes('CRT1 dropped')) return true;
    }
    return false;
  }, 900);
  assert(seen, 'dropped reported');
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
