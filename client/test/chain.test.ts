import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as secp from '@noble/secp256k1';
import { bytesToHex, concat } from '../src/core/bytes.ts';
import { ALIVE_CELL_DATA, encodeNodeCellData, newNodeCellData } from '../src/core/cells.ts';
import { descriptorHash } from '../src/core/hash.ts';
import { RpcClient, type FetchLike } from '../src/chain/rpc.ts';
import { DeploymentError, crtServiceId, parseDeployment } from '../src/chain/deployment.ts';
import { decodeRegistryV3, fetchRunners, runnerLockHashFromArgs, selectRunners, type Runner } from '../src/chain/runners.ts';
import { VerificationError, readSwitch, verifyNodes } from '../src/chain/switch.ts';
import { serviceId } from '../vendor/csr-job.mjs';

const h = (b: number, n = 32) => '0x' + b.toString(16).padStart(2, '0').repeat(n);
const TYPE_ID = '0x00000000000000000000000000000000000000000000000000545950455f4944';

export const deploymentJson = () => ({
  network_id: 1, enabled: true,
  node_lock: { code_hash: h(0xa1), out_point: { tx_hash: h(0xa2), index: 0 } },
  crt_code_hash: h(0xb1), crt_data_hash: h(0xb2), crt_data_cell: { tx_hash: h(0xb3), index: 0 },
  csr: {
    job_type: { code_hash: h(0xc1), out_point: { tx_hash: h(0xc2), index: 0 } },
    job_lock: { code_hash: h(0xc3), out_point: { tx_hash: h(0xc4), index: 1 } },
    registry_type_hash: h(0xc5),
    registry_type_script: { code_hash: h(0xc6), hash_type: 'data2', args: h(0xc7) },
    deployment: {
      registry_type_hash: h(0xc5),
      scripts: {
        job_type: { code_hash: h(0xc1), tx_hash: h(0xc2), index: 0, hash_type: 'data2' },
        job_lock: { code_hash: h(0xc3), tx_hash: h(0xc4), index: 1, hash_type: 'data2' },
      },
    },
  },
  type_id_code_hash: TYPE_ID,
  rpc_urls: ['http://127.0.0.1:8114', 'http://127.0.0.1:8115'],
  monitor_url: 'http://127.0.0.1:9000',
});

// ---- mock chain -----------------------------------------------------------------------------------------------------

interface MockCell { out_point: { tx_hash: string; index: string }; output: any; output_data: string }
class MockChain {
  cells: MockCell[] = [];
  monitor = new Map<string, unknown>();
  calls = 0;
  fail = 0; // number of failing calls before success
  fetch: FetchLike = async (url, init) => {
    this.calls++;
    if (this.fail > 0) { this.fail--; return { ok: false, status: 503, json: async () => ({}) }; }
    if (init.method === 'GET') {
      const peer = decodeURIComponent(url.split('/v1/nodes/')[1]!);
      const m = this.monitor.get(peer);
      return m ? { ok: true, status: 200, json: async () => m } : { ok: false, status: 404, json: async () => ({ error: 'unknown_node' }) };
    }
    const req = JSON.parse(init.body!);
    const [p0] = req.params;
    let result: unknown;
    if (req.method === 'get_cells') {
      const sk = p0 as { script: any; script_type: 'lock' | 'type'; script_search_mode?: string };
      const objects = this.cells.filter((c) => {
        const s = sk.script_type === 'lock' ? c.output.lock : c.output.type;
        if (!s || s.code_hash !== sk.script.code_hash || s.hash_type !== sk.script.hash_type) return false;
        return sk.script_search_mode === 'prefix' ? s.args.startsWith(sk.script.args) : s.args === sk.script.args;
      });
      result = { objects, last_cursor: '0x' };
    } else if (req.method === 'get_tip_header') result = { number: '0x10' };
    else return { ok: true, status: 200, json: async () => ({ error: { code: -1, message: 'unknown method' } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) };
  };
}

// ---- fixtures -------------------------------------------------------------------------------------------------------

function molBytes(b: Uint8Array) { const o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length, true); o.set(b, 4); return o; }
export function encodeRegistryV3(r: { peer: string; pubkey: Uint8Array; network: number; endpoint?: string }): Uint8Array {
  const u64 = new Uint8Array(8); new DataView(u64.buffer).setBigUint64(0, 1_900_000_000_000n, true);
  const stake = new Uint8Array(36).fill(0x5a); new DataView(stake.buffer).setUint32(32, 3, true);
  const fields = [
    Uint8Array.of(3), molBytes(new TextEncoder().encode(r.peer)), r.pubkey, new Uint8Array(32).fill(9), Uint8Array.of(r.network),
    stake, u64, new Uint8Array(65).fill(7), molBytes(new TextEncoder().encode(r.endpoint ?? '')), molBytes(new Uint8Array(0)),
  ];
  const head = 4 + 4 * fields.length;
  const out = new Uint8Array(head + fields.reduce((a, f) => a + f.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length, true);
  let o = head;
  fields.forEach((f, i) => { dv.setUint32(4 + 4 * i, o, true); out.set(f, o); o += f.length; });
  return out;
}

const T = h(0x77);
const OWNER = h(0x33);
const privOf = (i: number) => new Uint8Array(32).fill(i + 1);
const pubOf = (i: number) => secp.getPublicKey(privOf(i), true);
const Rof = (i: number) => h(0x40 + i);

interface World { chain: MockChain; rpc: RpcClient; deployment: ReturnType<typeof parseDeployment>; nodes: any[] }
function world(n = 3, opts: { state?: number; armedHash?: string } = {}): World {
  const dep = parseDeployment(deploymentJson());
  const chain = new MockChain();
  const rpc = new RpcClient(['http://x'], { fetch: chain.fetch });
  chain.cells.push({
    out_point: { tx_hash: h(0xe0), index: '0x0' },
    output: { capacity: '0x1', lock: { code_hash: h(0x01), hash_type: 'data', args: '0x' }, type: { code_hash: TYPE_ID, hash_type: 'type', args: T } },
    output_data: bytesToHex(ALIVE_CELL_DATA),
  });
  const nodes: any[] = [];
  for (let i = 0; i < n; i++) {
    const R = Rof(i);
    const data = { ...newNodeCellData(1_900_000_000n, OWNER), state: (opts.state ?? 1) as 0 | 1, pubkey: bytesToHex(pubOf(i)), descriptorHash: opts.armedHash ?? h(0, 32) };
    chain.cells.push({
      out_point: { tx_hash: h(0xf0 + i), index: '0x1' },
      output: { capacity: '0x5af3107a4000', lock: { code_hash: dep.node_lock.code_hash, hash_type: 'data2', args: T + R.slice(2) }, type: null },
      output_data: bytesToHex(encodeNodeCellData(data)),
    });
    chain.cells.push({
      out_point: { tx_hash: h(0xd0 + i), index: '0x0' },
      output: { capacity: '0x1', lock: { code_hash: h(0xc8), hash_type: 'data2', args: OWNER + R.slice(2) }, type: dep.csr.registry_type_script },
      output_data: bytesToHex(encodeRegistryV3({ peer: `Qm${i}`, pubkey: pubOf(100 + i), network: 1 })),
    });
    nodes.push({ runner_lock_hash: R, service_pubkey: bytesToHex(pubOf(100 + i)), node_cell: { tx_hash: h(0xf0 + i), index: 1 } });
  }
  return { chain, rpc, deployment: dep, nodes };
}
const plan = (w: World) => ({ type_id: T, nodes: w.nodes.map((n) => ({ ...n })) });

// ---- tests ----------------------------------------------------------------------------------------------------------

test('rpc_fallback_and_retry', async () => {
  const w = world(1);
  w.chain.fail = 1; // first attempt fails, retry succeeds
  assert.deepEqual(await w.rpc.getTipHeader(), { number: '0x10' });
  assert.equal(w.chain.calls, 2);
  const urls: string[] = [];
  const f: FetchLike = async (u) => { urls.push(u); if (u === 'http://a') throw new Error('down'); return { ok: true, status: 200, json: async () => ({ result: 5 }) }; };
  const c = new RpcClient(['http://a', 'http://b'], { fetch: f });
  assert.equal(await c.call('x'), 5);
  assert.deepEqual(urls, ['http://a', 'http://a', 'http://b']);
  await assert.rejects(new RpcClient('http://a', { fetch: async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 1, message: 'bad' } }) }) }).call('x'), /bad/);
});

test('deployment_validation_and_service_id', () => {
  const d = parseDeployment(deploymentJson());
  assert.equal(d.network_id, 1);
  const R = Rof(1);
  assert.equal(crtServiceId(d, R), serviceId(h(0xb1), R, [h(0xb2)]));
  assert.notEqual(crtServiceId(d, R), crtServiceId(d, Rof(2)));
  for (const mut of [
    (j: any) => { j.crt_code_hash = '0x12'; }, (j: any) => { delete j.node_lock; }, (j: any) => { j.rpc_urls = []; },
    (j: any) => { j.monitor_url = 'ftp://x'; }, (j: any) => { j.csr.registry_type_script.hash_type = 'nope'; },
    (j: any) => { j.csr.deployment.registry_type_hash = h(0x99); }, (j: any) => { j.network_id = 300; },
  ]) { const j = deploymentJson(); mut(j); assert.throws(() => parseDeployment(j), DeploymentError); }
  const disabled = JSON.parse(fs.readFileSync(new URL('../../deployments/mainnet.json', import.meta.url), 'utf8'));
  assert.throws(() => parseDeployment(disabled), /not enabled/);
});

test('registry_decode_and_runner_hash', () => {
  const pk = pubOf(1);
  const reg = decodeRegistryV3(encodeRegistryV3({ peer: 'QmPeer', pubkey: pk, network: 1, endpoint: 'https://h:1' }));
  assert.equal(reg.peerId, 'QmPeer'); assert.equal(reg.servicePubkey, bytesToHex(pk)); assert.equal(reg.network, 1);
  assert.equal(reg.endpoint, 'https://h:1'); assert.deepEqual(reg.stake, { txHash: h(0x5a), index: 3 }); assert.equal(reg.expiryMs, 1_900_000_000_000n);
  const enc = encodeRegistryV3({ peer: 'Q', pubkey: pk, network: 1 });
  assert.throws(() => decodeRegistryV3(enc.subarray(0, enc.length - 1)));
  assert.throws(() => decodeRegistryV3(concat(enc, Uint8Array.of(0))));
  assert.equal(runnerLockHashFromArgs(OWNER + Rof(1).slice(2)), Rof(1));
  assert.equal(runnerLockHashFromArgs(Rof(1)), Rof(1));
  assert.throws(() => runnerLockHashFromArgs('0x1234'));
});

test('runners_fetch_and_select', async () => {
  const w = world(4);
  // a registry cell on another network is ignored
  w.chain.cells.push({
    out_point: { tx_hash: h(0xee), index: '0x0' },
    output: { capacity: '0x1', lock: { code_hash: h(0xc8), hash_type: 'data2', args: Rof(9) }, type: w.deployment.csr.registry_type_script },
    output_data: bytesToHex(encodeRegistryV3({ peer: 'Qm9', pubkey: pubOf(9), network: 0 })),
  });
  const mon = (check: string, country: string) => ({ rank: 1, availability: { d7: 1, d30: 1, d365: null }, check_type: check, attestation: { status: 'valid' }, stake: { status: 'deposited' }, country });
  w.chain.monitor.set('Qm0', mon('p2p_verified', 'DE'));
  w.chain.monitor.set('Qm1', mon('peer_connected', 'DE'));
  w.chain.monitor.set('Qm2', mon('p2p_verified', 'FR'));
  w.chain.monitor.set('Qm3', { ...mon('p2p_verified', 'US'), stake: { status: 'withdrawn' } });
  const rs = await fetchRunners({ rpc: w.rpc, deployment: w.deployment, fetch: w.chain.fetch, crtList: [{ runner_lock_hash: Rof(0), label: 'mine' }] });
  assert.equal(rs.length, 4);
  const r0 = rs.find((r) => r.R === Rof(0))!;
  assert.equal(r0.label, 'mine'); assert.equal(r0.crtAnnounced, true); assert.equal(r0.unproven, true); assert.equal(r0.diversityKey, 'DE/?');
  assert.equal(rs.find((r) => r.R === Rof(3))!.monitor?.stakeStatus, 'withdrawn');
  // default: deposited+valid only, one per country → Qm0 (DE) and Qm2 (FR); Qm1 shares DE, Qm3 not deposited
  const sel = selectRunners(rs, { n: 2 });
  assert.deepEqual(sel.map((r) => r.R).sort(), [Rof(0), Rof(2)]);
  assert.throws(() => selectRunners(rs, { n: 3 }), /only 2 suitable/);
  assert.equal(selectRunners(rs, { n: 3, excludeSameDiversityKey: false }).length, 3);
  // mandatory is exempt from quality filters and always included
  const withM = selectRunners(rs, { n: 2, mandatory: [Rof(3)] });
  assert.ok(withM.some((r) => r.R === Rof(3)));
  assert.throws(() => selectRunners(rs, { n: 2, mandatory: [h(0xaa)] }), /not in the candidate list/);
  // runner-published limits
  const lim: Runner[] = rs.map((r) => ({ ...r, maxHeartbeatBlocks: 5000 }));
  assert.throws(() => selectRunners(lim, { n: 1, heartbeatBlocks: 8000 }));
});

test('read_switch_states', async () => {
  const w = world(3);
  let s = await readSwitch(T, w);
  assert.equal(s.state, 'committed'); assert.equal(s.nodeCells.length, 3); assert.equal(s.armed, 3);
  assert.equal(s.deadline, 1_900_000_000n); assert.ok(s.alive); assert.equal(s.headroom, null);
  const desc = { nodes: w.nodes, access_tree: { kind: 'threshold' as const, t: 2, n: 3, leaves: [{ node: 0 }, { node: 1 }, { node: 2 }] } };
  s = await readSwitch(T, w, { descriptor: desc });
  assert.equal(s.headroom?.threshold, 1);
  s = await readSwitch(T, w, { descriptor: desc, heartbeatFresh: (R) => R !== Rof(0) });
  assert.equal(s.headroom?.threshold, 0);
  assert.equal((await readSwitch(h(0x12), w)).state, 'absent');
  assert.equal((await readSwitch(T, world(3, { state: 0 }))).state, 'pending');
  assert.equal((await readSwitch(T, world(3, { armedHash: h(5) }))).state, 'armed');
  const noAlive = world(2); noAlive.chain.cells.shift();
  assert.equal((await readSwitch(T, noAlive)).state, 'cancelled');
});

test('verify_nodes_ok', async () => {
  const w = world(3);
  const nodes = await verifyNodes(T, plan(w), w);
  assert.equal(nodes.length, 3);
});

async function ruleOf(p: Promise<unknown>): Promise<number | null> {
  try { await p; return null; } catch (e) { if (e instanceof VerificationError) return e.rule; throw e; }
}

test('verify_after_arm_recorded_outpoint_is_dead', async () => {
  // Arm replaces every Node Cell: the out point recorded in the descriptor is no longer live, the cell with the lock is
  const w = world(3);
  const p = plan(w);
  p.nodes.forEach((n, i) => { n.node_cell = { tx_hash: h(0x10 + i), index: 7 }; });
  const found = await verifyNodes(T, p, w);
  assert.equal(found.length, 3);
});

test('verify_hard_fail_no_override', async () => {
  // rule 1: missing / wrong lock / wrong args
  { const w = world(3); w.chain.cells = w.chain.cells.filter((c) => c.out_point.tx_hash !== h(0xf1)); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 1); }
  { const w = world(3); w.chain.cells.find((c) => c.out_point.tx_hash === h(0xf1))!.output.lock.hash_type = 'type'; assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 1); }
  { const w = world(3); const p = plan(w); p.nodes[0]!.runner_lock_hash = h(0x99); assert.equal(await ruleOf(verifyNodes(T, p, w)), 1); }
  // rule 2: registry cell missing, wrong network, wrong service pubkey
  { const w = world(3); w.chain.cells = w.chain.cells.filter((c) => c.out_point.tx_hash !== h(0xd1)); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 2); }
  { const w = world(3); w.chain.cells.find((c) => c.out_point.tx_hash === h(0xd1))!.output_data = bytesToHex(encodeRegistryV3({ peer: 'Qm1', pubkey: pubOf(101), network: 0 })); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 2); }
  { const w = world(3); const p = plan(w); p.nodes[2]!.service_pubkey = bytesToHex(pubOf(50)); assert.equal(await ruleOf(verifyNodes(T, p, w)), 2); }
  // rule 3: state 0, invalid pubkey, recorded pubkey differs
  { const w = world(3, { state: 0 }); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 3); }
  { const w = world(3); const c = w.chain.cells.find((x) => x.out_point.tx_hash === h(0xf0))!;
    c.output_data = bytesToHex(encodeNodeCellData({ ...newNodeCellData(1_900_000_000n, OWNER), state: 1, pubkey: '0x02' + '00'.repeat(32) })); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 3); }
  { const w = world(3); const p = plan(w); (p.nodes[1] as any).pubkey = bytesToHex(pubOf(60)); assert.equal(await ruleOf(verifyNodes(T, p, w)), 3); }
  // rule 4: deadline / owner / descriptor hash differ; armed without descriptor; descriptor mismatch
  { const w = world(3); const c = w.chain.cells.find((x) => x.out_point.tx_hash === h(0xf2))!;
    c.output_data = bytesToHex(encodeNodeCellData({ ...newNodeCellData(1_900_000_001n, OWNER), state: 1, pubkey: bytesToHex(pubOf(2)) })); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 4); }
  { const w = world(3); const c = w.chain.cells.find((x) => x.out_point.tx_hash === h(0xf2))!;
    c.output_data = bytesToHex(encodeNodeCellData({ ...newNodeCellData(1_900_000_000n, h(0x34)), state: 1, pubkey: bytesToHex(pubOf(2)) })); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 4); }
  { const w = world(3, { armedHash: h(5) }); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 4); }
  { const w = world(3, { armedHash: h(5) }); const d = { ...plan(w), access_tree: { kind: 'threshold', t: 1, n: 3, leaves: [] } }; assert.equal(await ruleOf(verifyNodes(T, d as any, w)), 4); }
  // armed with the right descriptor passes
  { const w = world(3); const d: any = { ...plan(w), version: 1, access_tree: { kind: 'threshold', t: 2, n: 3, leaves: [{ node: 0 }, { node: 1 }, { node: 2 }] } };
    const hash = bytesToHex(descriptorHash(d));
    for (const c of w.chain.cells) if (c.out_point.tx_hash >= h(0xf0) && c.out_point.tx_hash <= h(0xf2)) c.output_data = bytesToHex(encodeNodeCellData({ ...newNodeCellData(1_900_000_000n, OWNER), state: 1, pubkey: bytesToHex(pubOf(Number('0x' + c.out_point.tx_hash.slice(2, 4)) - 0xf0)), descriptorHash: hash }));
    assert.equal(await ruleOf(verifyNodes(T, d, w)), null); }
  // rule 5: no alive cell, wrong data, wrong args
  { const w = world(3); w.chain.cells.shift(); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 5); }
  { const w = world(3); w.chain.cells[0]!.output_data = '0x43525402'; assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 5); }
  { const w = world(3); w.chain.cells[0]!.output.type.args = h(0x78); assert.equal(await ruleOf(verifyNodes(T, plan(w), w)), 5); }
  // the failing rule is reported with its number in the message
  { const w = world(3); w.chain.cells.shift(); await assert.rejects(verifyNodes(T, plan(w), w), /rule 5/); }

  // no override of any kind anywhere in the sources
  const dir = new URL('../src/', import.meta.url);
  const walk = (u: URL): string[] => fs.readdirSync(u, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(e.name + '/', u)) : [fs.readFileSync(new URL(e.name, u), 'utf8')]);
  const src = walk(dir).join('\n');
  for (const bad of ['skipVerif', 'insecure', 'allowUnverified', '--force']) assert.ok(!src.toLowerCase().includes(bad.toLowerCase()), bad);
  assert.equal(verifyNodes.length, 3);
});
