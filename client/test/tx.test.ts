import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import * as secp from '@noble/secp256k1';
import { bytesToHex } from '../src/core/bytes.ts';
import { GRACE_SECONDS, TYPE_ID_CODE_HASH, decodeNodeCellData, encodeNodeCellData, newNodeCellData } from '../src/core/cells.ts';
import { CKB, DEFAULT_BLOCK_SECONDS, SwitchParamsError, type SwitchParams } from '../src/core/cost.ts';
import { identity } from '../src/core/hash.ts';
import { jobPayload } from '../src/core/payload.ts';
import { crtServiceId, parseDeployment } from '../src/chain/deployment.ts';
import {
  TxBuildError, buildArm, buildCancel, buildCreate, buildReclaim, buildRenew, buildRewrap, heartbeatRuns, jobOutput, txBuilders,
  type TxContext,
} from '../src/tx/index.ts';
import { decodeJob, jobCell, minJobCapacity } from '../vendor/csr-job.mjs';

const h = (b: number, n = 32): `0x${string}` => `0x${b.toString(16).padStart(2, '0').repeat(n)}`;

const deployment = parseDeployment({
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
  type_id_code_hash: TYPE_ID_CODE_HASH,
  rpc_urls: ['http://127.0.0.1:8114'],
  monitor_url: 'http://127.0.0.1:9000',
});

const NOW = 1_800_000_000n; // unix seconds of the mocked tip
const TIP = 1_000_000n;
const FEE_RATE = 1000n;
const DAY = 86_400n;
const PARAMS: SwitchParams = { heartbeatBlocks: 8_000, heartbeatTip: CKB / 2n, keygenTip: CKB, maxFee: CKB / 500n, organiserFee: 0n };

// ---- mocked chain behind a CCC JSON-RPC transport --------------------------------------------------------------------

interface RpcCell { out_point: { tx_hash: string; index: string }; output: { capacity: string; lock: any; type: any }; output_data: string }
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const rpcScript = (s: ccc.ScriptLike) => {
  const x = ccc.Script.from(s);
  return { code_hash: x.codeHash, hash_type: x.hashType, args: x.args };
};

class MockChain {
  cells: RpcCell[] = [];
  methods: string[] = [];
  private seq = 0;

  add(output: { capacity: bigint; lock: ccc.ScriptLike; type?: ccc.ScriptLike | null }, data = '0x'): RpcCell {
    const c: RpcCell = {
      out_point: { tx_hash: '0x' + (++this.seq).toString(16).padStart(64, '0'), index: '0x0' },
      output: { capacity: hex(output.capacity), lock: rpcScript(output.lock), type: output.type ? rpcScript(output.type) : null },
      output_data: data,
    };
    this.cells.push(c);
    return c;
  }

  transport = {
    request: async (payload: { id: any; method: string; params: any[] }) => {
      this.methods.push(payload.method);
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: payload.id, result });
      switch (payload.method) {
        case 'get_tip_header':
          return ok({
            compact_target: '0x1d00ffff', dao: '0x' + '00'.repeat(32), epoch: '0x7080018000001', extra_hash: h(0),
            hash: h(0xee), nonce: '0x0', number: hex(TIP), parent_hash: h(0xed), proposals_hash: h(0),
            timestamp: hex(NOW * 1000n), transactions_root: h(0), version: '0x0',
          });
        case 'get_tip_block_number': return ok(hex(TIP));
        case 'get_fee_rate_statistics': return ok({ mean: hex(FEE_RATE), median: hex(FEE_RATE) });
        case 'get_cells': return ok({ objects: this.search(payload.params[0]), last_cursor: '0x' });
        default: return { jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: `mock: ${payload.method}` } };
      }
    },
  };

  private search(key: any): RpcCell[] {
    return this.cells.filter((c) => {
      const s = key.script_type === 'lock' ? c.output.lock : c.output.type;
      if (!s || s.code_hash !== key.script.code_hash || s.hash_type !== key.script.hash_type) return false;
      const match = key.script_search_mode === 'exact' ? s.args === key.script.args : s.args.startsWith(key.script.args);
      if (!match) return false;
      const f = key.filter;
      if (f?.script_len_range && key.script_type === 'lock' && c.output.type) return false;
      if (f?.output_data_len_range && c.output_data !== '0x') return false;
      return true;
    });
  }
}

async function setup() {
  const chain = new MockChain();
  const client = ccc.ClientPublicTestnet.new({ transport: chain.transport as any });
  const priv = new Uint8Array(32).fill(0x11);
  const signer = new ccc.SignerCkbPublicKey(client, bytesToHex(secp.getPublicKey(priv, true)));
  const owner = (await signer.getRecommendedAddressObj()).script;
  for (let i = 0; i < 4; i++) chain.add({ capacity: 20_000n * CKB, lock: owner });
  const ctx: TxContext = { signer, deployment, feeRate: FEE_RATE };
  return { chain, client, signer, owner, ownerLockHash: owner.hash(), ctx };
}

const runnersR = (n: number) => Array.from({ length: n }, (_, i) => h(0x10 + i));
const servicePubkey = bytesToHex(secp.getPublicKey(new Uint8Array(32).fill(0x22), true));
const nodeLock = (T: string, R: string) => ({ codeHash: deployment.node_lock.code_hash, hashType: 'data2' as const, args: T + R.slice(2) });
const typeId = (T: string) => ccc.Script.from({ codeHash: TYPE_ID_CODE_HASH, hashType: 'type', args: T });
const jobTypeArgs = (o: ccc.CellOutput) => o.type?.args;

/** Puts a switch on the mocked chain: Alive Cell + n Node Cells in `state`. */
function putSwitch(chain: MockChain, owner: ccc.Script, opts: { n?: number; state?: 0 | 1 | 2; deadline?: bigint } = {}) {
  const T = h(0x77);
  const Rs = runnersR(opts.n ?? 5);
  const deadline = opts.deadline ?? NOW + 365n * DAY;
  chain.add({ capacity: 65n * CKB, lock: owner, type: typeId(T) }, '0x43525401');
  const pub = bytesToHex(secp.getPublicKey(new Uint8Array(32).fill(0x33), true));
  for (const R of Rs) {
    const data = { ...newNodeCellData(deadline, owner.hash()), state: opts.state ?? 1, pubkey: (opts.state ?? 1) >= 1 ? pub : '0x' + '00'.repeat(33) } as const;
    chain.add({ capacity: 244n * CKB, lock: nodeLock(T, R) }, bytesToHex(encodeNodeCellData(data)));
  }
  return { T, Rs, deadline };
}

function putJob(chain: MockChain, T: string, R: string, job: any) {
  const o = jobOutput(deployment, R, job);
  return chain.add({ capacity: o.cellOutput.capacity, lock: o.cellOutput.lock, type: o.cellOutput.type }, o.outputData);
}

const heartbeatJobFixture = (T: string, ownerLockHash: string, over: Partial<any> = {}): any => ({
  trigger: { kind: 'Every', blocks: 4_000n }, tipShannons: 7n * CKB / 10n, maxFeeShannons: CKB / 100n, maxCycles: 100_000_000n,
  payload: bytesToHex(jobPayload(T)), expiryBlock: TIP + 50_000n, refundLockHash: ownerLockHash, remainingRuns: 20, ...over,
});

// ---- Create ----------------------------------------------------------------------------------------------------------

test('build_create_layout', async () => {
  const { chain, signer, owner, ownerLockHash } = await setup();
  const organiserLock = ccc.Script.from({ codeHash: h(0xd1), hashType: 'type', args: h(0xd2, 20) });
  const Rs = runnersR(5);
  const deadline = NOW + 365n * DAY;
  const r = await buildCreate({
    signer, deployment, deadline, runners: Rs.map((R) => ({ R, servicePubkey })),
    params: { ...PARAMS, organiserFee: 100n * CKB }, organiserLock, feeRate: FEE_RATE,
  });
  const { tx, T } = r;
  assert.ok(chain.methods.includes('get_cells'));

  // Alive Cell: type-id args computed per the CKB type-id rule from the first input and output index 0.
  assert.equal(T, ccc.hashTypeId(tx.inputs[0]!, 0));
  assert.equal(r.I, bytesToHex(identity(1, T)));
  const alive = tx.outputs[r.aliveCellIndex]!;
  assert.ok(alive.type?.eq(typeId(T)));
  assert.ok(alive.lock.eq(owner));
  assert.equal(tx.outputsData[0], '0x43525401');
  assert.equal(alive.capacity, BigInt(8 + 53 + 65 + 4) * CKB);

  // n Node Cells: state 0, descriptor_hash 0, deadline, owner; 244 CKB.
  assert.deepEqual(r.nodeCellIndices, [1, 2, 3, 4, 5]);
  r.nodeCellIndices.forEach((idx, i) => {
    const o = tx.outputs[idx]!;
    assert.ok(o.lock.eq(ccc.Script.from(nodeLock(T, Rs[i]!))));
    assert.equal(o.type, undefined);
    assert.equal(o.capacity, 244n * CKB);
    const d = decodeNodeCellData(tx.outputsData[idx]!);
    assert.equal(d.state, 0);
    assert.equal(d.descriptorHash, '0x' + '00'.repeat(32));
    assert.equal(d.pubkey, '0x' + '00'.repeat(33));
    assert.equal(d.deadline, deadline);
    assert.equal(d.ownerLockHash, ownerLockHash);
  });

  // n keygen jobs: one per runner service ID, payload = jobPayload(T), capacity = minJobCapacity.
  r.keygenJobIndices.forEach((idx, i) => {
    const o = tx.outputs[idx]!;
    const sid = crtServiceId(deployment, Rs[i]!);
    assert.equal(jobTypeArgs(o), sid);
    assert.equal(o.type!.codeHash, deployment.csr.job_type.code_hash);
    assert.equal(o.lock.codeHash, deployment.csr.job_lock.code_hash);
    assert.equal(o.lock.args, deployment.csr.registry_type_hash);
    const job = decodeJob(tx.outputsData[idx]!);
    assert.equal(job.payload, bytesToHex(jobPayload(T)));
    assert.deepEqual(job.trigger, { kind: 'OnDemand' });
    assert.equal(job.remainingRuns, 1);
    assert.equal(job.tipShannons, PARAMS.keygenTip);
    assert.equal(job.maxFeeShannons, PARAMS.maxFee);
    assert.equal(job.refundLockHash, ownerLockHash);
    assert.ok(job.expiryBlock > TIP);
    assert.equal(o.capacity, minJobCapacity({ deployment: deployment.csr.deployment, serviceId: sid, job }));
  });
  // CSR: at most one job output per service group (F-CON-007).
  const jobTypes = tx.outputs.filter((o) => o.type?.codeHash === deployment.csr.job_type.code_hash).map((o) => o.type!.args);
  assert.equal(new Set(jobTypes).size, jobTypes.length);
  assert.equal(jobTypes.length, 5);

  // organiser fee and change
  assert.equal(r.organiserFeeIndex, 11);
  assert.ok(tx.outputs[11]!.lock.eq(organiserLock));
  assert.equal(tx.outputs[11]!.capacity, 100n * CKB);
  assert.equal(tx.outputs.length, 13);
  assert.ok(tx.outputs[12]!.lock.eq(owner));
  assert.equal(tx.outputs[12]!.type, undefined);

  // job deps; fee paid
  const deps = tx.cellDeps.map((c) => c.outPoint.txHash);
  assert.ok(deps.includes(h(0xc2)) && deps.includes(h(0xc4)));
  assert.equal(tx.inputs.length, 1);
  const inCap = tx.inputs.length * 20_000 * Number(CKB);
  const fee = BigInt(inCap) - tx.getOutputsCapacity();
  assert.ok(fee > 0n && fee < CKB, `fee ${fee}`);
});

test('build_create_validates_params', async () => {
  const { signer } = await setup();
  const base = { signer, deployment, deadline: NOW + 365n * DAY, runners: runnersR(5).map((R) => ({ R, servicePubkey })), feeRate: FEE_RATE };
  await assert.rejects(buildCreate({ ...base, params: { ...PARAMS, heartbeatBlocks: 500 } }), SwitchParamsError);
  await assert.rejects(buildCreate({ ...base, params: { ...PARAMS, heartbeatTip: CKB / 20n } }), SwitchParamsError);
  await assert.rejects(buildCreate({ ...base, runners: base.runners.slice(0, 2), params: PARAMS }), SwitchParamsError);
  await assert.rejects(buildCreate({ ...base, deadline: NOW + 3600n, params: PARAMS }), SwitchParamsError);
  await assert.rejects(buildCreate({ ...base, params: { ...PARAMS, organiserFee: 10n * CKB } }), TxBuildError); // no organiser lock
  const dup = [...base.runners.slice(0, 4), base.runners[0]!];
  await assert.rejects(buildCreate({ ...base, runners: dup, params: PARAMS }), TxBuildError);
});

// ---- Arm -------------------------------------------------------------------------------------------------------------

test('build_arm_sets_descriptor_and_heartbeat_jobs', async () => {
  const { chain, ctx, ownerLockHash } = await setup();
  const { T, Rs, deadline } = putSwitch(chain, (await ctx.signer.getRecommendedAddressObj()).script);
  const dh = h(0x99);
  const tx = await buildArm(T, dh, { ...ctx, params: { heartbeatBlocks: 8_000 } });
  const nodes = tx.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.lock.codeHash === deployment.node_lock.code_hash);
  assert.equal(nodes.length, 5);
  for (const { o, i } of nodes) {
    const d = decodeNodeCellData(tx.outputsData[i]!);
    assert.equal(d.descriptorHash, dh);
    assert.equal(d.state, 1);
    assert.equal(d.deadline, deadline);
    assert.equal(o.capacity, 244n * CKB);
  }
  // heartbeat jobs: remainingRuns = ceil(term / HEARTBEAT), term = deadline + GRACE − now.
  const term = Number(deadline + BigInt(GRACE_SECONDS) - NOW);
  const runs = Math.ceil(term / (DEFAULT_BLOCK_SECONDS * 8_000));
  assert.equal(runs, heartbeatRuns(term, 8_000, DEFAULT_BLOCK_SECONDS));
  const jobs = tx.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.type?.codeHash === deployment.csr.job_type.code_hash);
  assert.equal(jobs.length, 5);
  assert.deepEqual(jobs.map(({ o }) => o.type!.args).sort(), Rs.map((R) => crtServiceId(deployment, R)).sort());
  for (const { o, i } of jobs) {
    const job = decodeJob(tx.outputsData[i]!);
    assert.deepEqual(job.trigger, { kind: 'Every', blocks: 8_000n });
    assert.equal(job.remainingRuns, runs);
    assert.equal(job.payload, bytesToHex(jobPayload(T)));
    assert.equal(job.tipShannons, PARAMS.heartbeatTip);
    assert.equal(job.refundLockHash, ownerLockHash);
    assert.ok(job.expiryBlock >= TIP + BigInt(runs * 8_000));
    assert.ok(o.capacity >= minJobCapacity({ deployment: deployment.csr.deployment, serviceId: o.type!.args, job }));
    assert.ok(o.capacity >= BigInt(runs) * (job.tipShannons + job.maxFeeShannons));
  }
  // owner input present (owner path) and node lock dep
  assert.ok(tx.cellDeps.some((c) => c.outPoint.txHash === h(0xa2)));
  assert.equal(tx.inputs.length, 6);
});

test('build_arm_requires_committed_nodes', async () => {
  const { chain, ctx, owner } = await setup();
  const { T } = putSwitch(chain, owner, { state: 0 });
  await assert.rejects(buildArm(T, h(0x99), ctx), /state 0/);
});

test('build_arm_skips_runners_with_heartbeat_job', async () => {
  const { chain, ctx, owner, ownerLockHash } = await setup();
  const { T, Rs } = putSwitch(chain, owner);
  putJob(chain, T, Rs[0]!, heartbeatJobFixture(T, ownerLockHash));
  const tx = await txBuilders(ctx).buildArm(T, h(0x99));
  const jobs = tx.outputs.filter((o) => o.type?.codeHash === deployment.csr.job_type.code_hash);
  assert.equal(jobs.length, 4);
  assert.ok(!jobs.some((o) => o.type!.args === crtServiceId(deployment, Rs[0]!)));
  // params come from the live heartbeat job
  const job = decodeJob(tx.outputsData[tx.outputs.indexOf(jobs[0]!)]!);
  assert.deepEqual(job.trigger, { kind: 'Every', blocks: 4_000n });
});

// ---- Renew -----------------------------------------------------------------------------------------------------------

test('build_renew_defaults_to_current_params', async () => {
  const { chain, ctx, owner, ownerLockHash } = await setup();
  const { T, Rs } = putSwitch(chain, owner);
  for (const R of Rs) putJob(chain, T, R, heartbeatJobFixture(T, ownerLockHash));
  const newDeadline = NOW + 730n * DAY;
  const tx = await txBuilders(ctx).buildRenew(T, newDeadline);
  const nodeIdx = tx.outputs.map((o, i) => (o.lock.codeHash === deployment.node_lock.code_hash ? i : -1)).filter((i) => i >= 0);
  assert.equal(nodeIdx.length, 5);
  for (const i of nodeIdx) assert.equal(decodeNodeCellData(tx.outputsData[i]!).deadline, newDeadline);
  const jobIdx = tx.outputs.map((o, i) => (o.type?.codeHash === deployment.csr.job_type.code_hash ? i : -1)).filter((i) => i >= 0);
  assert.equal(jobIdx.length, 5);
  const runs = Math.ceil(Number(newDeadline + BigInt(GRACE_SECONDS) - NOW) / (DEFAULT_BLOCK_SECONDS * 4_000));
  for (const i of jobIdx) {
    const job = decodeJob(tx.outputsData[i]!);
    assert.deepEqual(job.trigger, { kind: 'Every', blocks: 4_000n });
    assert.equal(job.tipShannons, 7n * CKB / 10n);
    assert.equal(job.maxFeeShannons, CKB / 100n);
    assert.equal(job.remainingRuns, runs);
  }
  // explicit parameters win
  const tx2 = await buildRenew(T, newDeadline, { heartbeatBlocks: 16_000 }, ctx);
  const j2 = decodeJob(tx2.outputsData[tx2.outputs.findIndex((o) => o.type?.codeHash === deployment.csr.job_type.code_hash)]!);
  assert.deepEqual(j2.trigger, { kind: 'Every', blocks: 16_000n });
  assert.equal(j2.tipShannons, 7n * CKB / 10n);
});

test('build_renew_without_jobs_needs_params', async () => {
  const { chain, ctx, owner } = await setup();
  const { T } = putSwitch(chain, owner);
  await assert.rejects(buildRenew(T, NOW + 400n * DAY, undefined, ctx), TxBuildError);
  await assert.rejects(buildRenew(T, NOW + 400n * DAY, { heartbeatBlocks: 70_000, heartbeatTip: CKB, maxFee: 0n }, ctx), SwitchParamsError);
});

// ---- Rewrap ----------------------------------------------------------------------------------------------------------

test('build_rewrap_drops_and_adds', async () => {
  const { chain, ctx, owner, ownerLockHash } = await setup();
  const { T, Rs, deadline } = putSwitch(chain, owner);
  const newR = h(0x5e);
  const tx = await buildRewrap(T, [Rs[1]!], [{ R: newR, servicePubkey }], ctx);
  const nodeInputs = tx.inputs.filter((i) => i.cellOutput?.lock.codeHash === deployment.node_lock.code_hash);
  assert.equal(nodeInputs.length, 1);
  assert.ok(nodeInputs[0]!.cellOutput!.lock.eq(ccc.Script.from(nodeLock(T, Rs[1]!))));
  const nodeOuts = tx.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.lock.codeHash === deployment.node_lock.code_hash);
  assert.equal(nodeOuts.length, 1);
  assert.ok(nodeOuts[0]!.o.lock.eq(ccc.Script.from(nodeLock(T, newR))));
  const d = decodeNodeCellData(tx.outputsData[nodeOuts[0]!.i]!);
  assert.equal(d.state, 0);
  assert.equal(d.deadline, deadline);
  assert.equal(d.ownerLockHash, ownerLockHash);
  const jobs = tx.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.type?.codeHash === deployment.csr.job_type.code_hash);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.o.type!.args, crtServiceId(deployment, newR));
  assert.deepEqual(decodeJob(tx.outputsData[jobs[0]!.i]!).trigger, { kind: 'OnDemand' });
  await assert.rejects(buildRewrap(T, [], [{ R: Rs[0]!, servicePubkey }], ctx), /already has a Node Cell/);
  await assert.rejects(buildRewrap(T, [h(0x01)], [], ctx), /no Node Cell/);
});

// ---- Cancel ----------------------------------------------------------------------------------------------------------

test('build_cancel_has_no_typeid_output', async () => {
  const { chain, ctx, owner } = await setup();
  const { T } = putSwitch(chain, owner);
  const tx = await txBuilders(ctx).buildCancel(T, { reclaimNodeCells: true });
  const aliveIn = tx.inputs.filter((i) => i.cellOutput?.type?.eq(typeId(T)));
  assert.equal(aliveIn.length, 1);
  assert.equal(tx.inputs.filter((i) => i.cellOutput?.lock.codeHash === deployment.node_lock.code_hash).length, 5);
  assert.ok(!tx.outputs.some((o) => o.type?.codeHash === TYPE_ID_CODE_HASH), 'no output with the type-id script');
  // no fee output of any kind: the only output is the signer's change
  assert.equal(tx.outputs.length, 1);
  assert.ok(tx.outputs[0]!.lock.eq(owner));
  assert.equal(tx.outputs[0]!.type, undefined);
  assert.ok(tx.cellDeps.some((c) => c.outPoint.txHash === h(0xa2)));

  const keep = await buildCancel(T, { reclaimNodeCells: false }, ctx);
  assert.equal(keep.inputs.filter((i) => i.cellOutput?.lock.codeHash === deployment.node_lock.code_hash).length, 0);
  assert.ok(!keep.outputs.some((o) => o.type?.codeHash === TYPE_ID_CODE_HASH));
});

test('build_cancel_without_alive_cell_fails', async () => {
  const { ctx } = await setup();
  await assert.rejects(buildCancel(h(0x78), undefined, ctx), /no live Alive Cell/);
});

// ---- Reclaim ---------------------------------------------------------------------------------------------------------

test('build_reclaim_nodes_and_one_expired_job', async () => {
  const { chain, ctx, owner, ownerLockHash } = await setup();
  const { T, Rs } = putSwitch(chain, owner, { state: 2 });
  putJob(chain, T, Rs[0]!, heartbeatJobFixture(T, ownerLockHash, { expiryBlock: TIP - 10n }));
  putJob(chain, T, Rs[1]!, heartbeatJobFixture(T, ownerLockHash, { expiryBlock: TIP - 20n }));
  putJob(chain, T, Rs[2]!, heartbeatJobFixture(T, ownerLockHash, { expiryBlock: TIP + 10n })); // not yet expired
  const tx = await buildReclaim(T, ctx);
  assert.equal(tx.inputs.filter((i) => i.cellOutput?.lock.codeHash === deployment.node_lock.code_hash).length, 5);
  const jobIn = tx.inputs.filter((i) => i.cellOutput?.lock.codeHash === deployment.csr.job_lock.code_hash);
  assert.equal(jobIn.length, 1, 'the CSR job lock accepts one job input per transaction');
  assert.equal(jobIn[0]!.since, TIP - 20n); // absolute block number, flags 0x00
  assert.equal(jobIn[0]!.cellOutput!.type!.args, crtServiceId(deployment, Rs[1]!));
  // owner input for the owner path and the refund path; deps: node lock + job deps, no registry dep
  assert.ok(tx.inputs.some((i) => i.cellOutput?.lock.eq(owner)));
  const deps = tx.cellDeps.map((c) => c.outPoint.txHash);
  assert.ok(deps.includes(h(0xa2)) && deps.includes(h(0xc2)) && deps.includes(h(0xc4)));
  assert.ok(!deps.includes(h(0xc7)) && !deps.includes(h(0xc6)));
  assert.equal(tx.outputs.length, 1);
  assert.ok(tx.outputs[0]!.lock.eq(owner));
});

test('build_reclaim_after_cancel_uses_runner_list', async () => {
  const { chain, ctx, ownerLockHash } = await setup();
  const T = h(0x79);
  await assert.rejects(buildReclaim(T, ctx), /nothing to reclaim/);
  putJob(chain, T, h(0x42), heartbeatJobFixture(T, ownerLockHash, { expiryBlock: TIP }));
  putJob(chain, T, h(0x43), heartbeatJobFixture(T, h(0x01), { expiryBlock: TIP - 1n })); // someone else's refund
  const tx = await txBuilders(ctx).buildReclaim(T, [h(0x42), h(0x43)]);
  const jobIn = tx.inputs.filter((i) => i.cellOutput?.lock.codeHash === deployment.csr.job_lock.code_hash);
  assert.equal(jobIn.length, 1);
  assert.equal(jobIn[0]!.cellOutput!.type!.args, crtServiceId(deployment, h(0x42)));
});

test('job_cells_respect_min_capacity', async () => {
  const { ownerLockHash } = await setup();
  const T = h(0x77);
  for (const job of [heartbeatJobFixture(T, ownerLockHash), heartbeatJobFixture(T, ownerLockHash, { trigger: { kind: 'OnDemand' }, remainingRuns: 1 })]) {
    const sid = crtServiceId(deployment, h(0x10));
    const o = jobOutput(deployment, h(0x10), job);
    const ref = jobCell({ deployment: deployment.csr.deployment, serviceId: sid, job });
    assert.equal(o.cellOutput.capacity, minJobCapacity({ deployment: deployment.csr.deployment, serviceId: sid, job }));
    assert.equal(o.outputData, ref.outputData);
  }
});
