// CRT smoke test on CKB testnet with ONE runner (n = 1 is allowed on testnet and devnet only, SPEC 6.2).
// There is no time travel on testnet: the term is the client's minimum of 1 day, and a release comes GRACE (24 h)
// after the deadline, about 2 days after Create. Two named switches, so the quick path does not wait for the slow one:
//   cancel   create, wait for the commit, arm, cancel; the runner deletes its key at its next heartbeat
//   release  create, wait for the commit, arm, (renew), and 2 days later recover K from the released key
//
// Usage (run with the client's tsx):
//   client/node_modules/.bin/tsx scripts/testnet-smoke.mjs <command> --name <cancel|release> [options]
// Commands:
//   create     Create + wait for the commit + verify + Arm; writes the state file and the kit
//   status     the switch on chain, its Node Cell states and the time left to the release
//   renew      move the deadline by +1 hour (needs state armed)
//   cancel     cancel the switch (the Alive Cell is consumed; the Node Cells stay)
//   recover    after deadline + GRACE: collect the releases and recover K from the chain; compares it to the wrapped K
// Options:
//   --key-file FILE      the owner key (hex; never printed). Pays about 600 CKB, most of it refundable
//   --identity FILE      output of `csr identity --json` of the runner (runner_lock_hash, service_pubkey)
//   --rpc URL            testnet node with the indexer (default http://127.0.0.1:8112)
//   --state DIR          state directory (default .devnet/testnet-smoke; files hold K: keep them private)
//   --heartbeat BLOCKS   heartbeat interval in blocks (default 1000, the minimum, about 2-3 hours)
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = { name: 'release', rpc: 'http://127.0.0.1:8112', state: resolve(ROOT, '.devnet/testnet-smoke'), heartbeat: 1000, key: '', identity: '' };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--name') opt.name = argv[++i];
  else if (a === '--key-file') opt.key = argv[++i];
  else if (a === '--identity') opt.identity = argv[++i];
  else if (a === '--rpc') opt.rpc = argv[++i];
  else if (a === '--state') opt.state = resolve(argv[++i]);
  else if (a === '--heartbeat') opt.heartbeat = Number(argv[++i]);
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
if (!['create', 'status', 'renew', 'cancel', 'recover'].includes(cmd) || !['cancel', 'release'].includes(opt.name)) {
  console.error('usage: testnet-smoke.mjs <create|status|renew|cancel|recover> --name <cancel|release> [--key-file F --identity F --rpc URL]');
  process.exit(2);
}
if (!opt.key) { console.error('--key-file is required'); process.exit(2); }
const DAY = 86400, GRACE = 86400;
const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const crt = await import(resolve(ROOT, 'client/src/index.ts'));
const ccc = (createRequire(resolve(ROOT, 'client/package.json'))('@ckb-ccc/core').ccc) ?? createRequire(resolve(ROOT, 'client/package.json'))('@ckb-ccc/core');
const deployment = crt.parseDeployment(JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8')));
const client = new ccc.ClientPublicTestnet({ url: opt.rpc });
const signer = new ccc.SignerCkbPrivateKey(client, readFileSync(opt.key, 'utf8').trim());
const ctx = { signer, deployment };
const swCtx = { rpc: new crt.RpcClient(opt.rpc), deployment };
mkdirSync(opt.state, { recursive: true });
const stateFile = resolve(opt.state, `${opt.name}.json`);
const saved = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const save = (s) => { writeFileSync(stateFile, JSON.stringify(s, null, 2)); chmodSync(stateFile, 0o600); };

async function rpc(method, params) {
  const r = await fetch(opt.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function medianSeconds() {
  // the median of the last 37 block timestamps, as consensus computes it for `since`
  const tip = Number(BigInt((await rpc('get_tip_block_number', []))));
  const ts = [];
  for (let n = tip; n > tip - 37 && n >= 0; n--) ts.push(Number(BigInt((await rpc('get_header_by_number', ['0x' + n.toString(16)])).timestamp)));
  ts.sort((a, b) => a - b);
  return Math.floor(ts[ts.length >> 1] / 1000);
}
async function waitFor(what, fn, { timeoutS = 1200, everyS = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if ((Date.now() - t0) / 1000 > timeoutS) throw new Error(`timeout waiting for ${what}`);
    await sleep(everyS * 1000);
  }
}
async function send(tx, what) {
  const h = await signer.sendTransaction(tx);
  log(`${what}: ${h}`);
  await signer.client.waitTransaction(h, 1, 120_000).catch(() => {});
  return h;
}
const tree = { kind: 'threshold', t: 1, n: 1, leaves: [{ node: 0 }] };

if (cmd === 'create') {
  if (existsSync(stateFile)) { console.error(`${stateFile} exists: this switch was created already (use another --name or --state)`); process.exit(1); }
  if (!opt.identity) { console.error('--identity FILE is required for create'); process.exit(2); }
  const id = JSON.parse(readFileSync(opt.identity, 'utf8'));
  const runner = { R: id.runner_lock_hash, servicePubkey: id.service_pubkey };
  const params = { ...crt.defaultSwitchParams(), heartbeatBlocks: opt.heartbeat };
  const tipS = Math.ceil(Number(BigInt((await rpc('get_tip_header', [])).timestamp)) / 1000);
  const deadline = Math.max(tipS, await medianSeconds()) + DAY + 3600; // minimum term 1 day, plus an hour of margin
  const built = await crt.buildCreate({ signer, deployment, deadline, runners: [runner], params, validation: { t: 1 } });
  log(`create: switch T=${built.T}, deadline ${new Date(deadline * 1000).toISOString()}`);
  await send(built.tx, 'create tx');
  save({ name: opt.name, T: built.T, I: built.I, deadline, runner, heartbeat: opt.heartbeat, createdAt: Date.now() });
  log('waiting for the runner to commit its key (keygen job; usually a few minutes)...');
  await waitFor('the commit', async () => (await crt.readSwitch(built.T, swCtx)).state === 'committed', { timeoutS: 1800 });
  log('committed');
  const plan = { type_id: built.T, nodes: [{ runner_lock_hash: runner.R, service_pubkey: runner.servicePubkey, label: 'my runner' }] };
  await crt.verifyNodes(built.T, plan, swCtx);
  log('verified (SPEC 8.3 rules 1-5)');
  const K = crypto.getRandomValues(new Uint8Array(32));
  const descriptor = await crt.buildVerifiedDescriptor({ K, access_tree: tree, nodes: plan.nodes, created_at: Math.floor(Date.now() / 1000) }, built.T, swCtx);
  await waitFor('the owner client to see the Node Cell in state 1', async () => (await crt.liveNodeCells(built.T, ctx)).every((n) => n.data.state === 1), { timeoutS: 300 });
  await send(await crt.buildArm(built.T, crt.descriptorHash(descriptor), { ...ctx, params: { heartbeatBlocks: opt.heartbeat } }), 'arm tx');
  await waitFor('armed', async () => (await crt.readSwitch(built.T, swCtx)).state === 'armed', { timeoutS: 600 });
  const envelopes = await crt.wrapKeyAnchored(K, descriptor, swCtx);
  const kit = crt.generateKit({ descriptor, envelopes, kitVersion: crt.KIT_VERSION, deadline });
  writeFileSync(resolve(opt.state, `${opt.name}-kit.html`), kit);
  save({ ...saved(), K: hex(K), descriptor, envelopes, armedAt: Date.now() });
  log(`armed. Kit: ${resolve(opt.state, `${opt.name}-kit.html`)}; state: ${stateFile}`);
  log(opt.name === 'release'
    ? `next: wait until ${new Date((deadline + GRACE) * 1000).toISOString()} (deadline + 24 h), then run: recover`
    : 'next: run cancel, then wait a few hours (the runner deletes its key at its next heartbeat)');
} else if (cmd === 'status') {
  const s = saved();
  const sw = await crt.readSwitch(s.T, swCtx);
  const nowS = Math.floor(Date.now() / 1000);
  console.log(JSON.stringify({ name: s.name, T: s.T, state: sw.state, deadline: new Date(Number(sw.deadline) * 1000).toISOString(),
    nodeCells: sw.nodeCells.map((n) => ({ R: n.R.slice(0, 12), state: n.data.state })),
    hoursToRelease: Math.round(((Number(sw.deadline) + GRACE - nowS) / 3600) * 10) / 10 }, null, 2));
} else if (cmd === 'renew') {
  const s = saved();
  const deadline = s.deadline + 3600;
  await send(await crt.buildRenew(s.T, deadline, undefined, ctx), 'renew tx');
  await waitFor('the new deadline', async () => (await crt.readSwitch(s.T, swCtx)).deadline === BigInt(deadline), { timeoutS: 900 });
  save({ ...s, deadline });
  log(`renewed: deadline ${new Date(deadline * 1000).toISOString()}`);
} else if (cmd === 'cancel') {
  const s = saved();
  await send(await crt.buildCancel(s.T, { reclaimNodeCells: false }, ctx), 'cancel tx');
  save({ ...s, canceledAt: Date.now() });
  log('cancelled. The runner deletes its key at its next heartbeat; check the runner dashboard (jobs, storage) and its deletions.log');
} else if (cmd === 'recover') {
  const s = saved();
  const rel = await crt.collectReleases(s.T, opt.rpc, { nodeLockCodeHash: deployment.node_lock.code_hash });
  log(`releases on chain: ${rel.size}`);
  if (s.canceledAt) { console.log(rel.size === 0 ? 'PASS: cancelled switch has no release' : 'FAIL: a cancelled switch was released'); process.exit(rel.size === 0 ? 0 : 1); }
  if (rel.size < 1) { console.log('not released yet (needs deadline + GRACE passed and a heartbeat of the runner)'); process.exit(1); }
  const got = await crt.recoverOnline(s.descriptor, s.envelopes, opt.rpc);
  const ok = Buffer.from(got).equals(Buffer.from(unhex(s.K)));
  console.log(ok ? 'PASS: K recovered from the released key equals the wrapped K' : 'FAIL: recovered K differs');
  process.exit(ok ? 0 : 1);
}
