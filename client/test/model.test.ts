import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '../src/core/bytes.ts';
import { shareCommitment } from '../src/core/hash.ts';
import { type AccessTree, validateTree, leafPositions, splitKey, combineKey, headroom } from '../src/core/tree.ts';
import { encodeNodeCellData, decodeNodeCellData, newNodeCellData, aliveCellData, isAliveCell, sinceAbsoluteTimestamp } from '../src/core/cells.ts';
import { estimateCost, SWITCH_PARAM_RANGES, validateSwitchParams, SwitchParamsError, SWITCH_PARAM_RANGES as R } from '../src/core/cost.ts';
import { seeded } from './util.ts';

const thr = (t: number, nodes: number[]) => ({ kind: 'threshold' as const, t, n: nodes.length, leaves: nodes.map((node) => ({ node })) });

test('tree_xor_threshold_roundtrip', () => {
  const rng = seeded(11);
  const K = rng(32);
  const plain = thr(3, [0, 1, 2, 3, 4]);
  const xor: AccessTree = { kind: 'xor', branches: [thr(2, [0, 1, 2]), thr(5, [3, 4, 5, 6, 7, 8, 9, 10])] };
  for (const tree of [plain, xor]) {
    const { leafSecrets, commitments } = splitKey(K, tree, rng);
    const pos = leafPositions(tree);
    assert.equal(leafSecrets.length, pos.length);
    assert.deepEqual(pos.map((p) => p.position), pos.map((_, i) => i));
    commitments.forEach((c, i) => assert.deepEqual(c, shareCommitment(leafSecrets[i]!)));
    // all leaves
    assert.deepEqual(combineKey(tree, new Map(leafSecrets.map((s, i) => [i, s]))), K);
  }
  const { leafSecrets } = splitKey(K, xor, rng);
  // exactly t of each branch (positions 0..2 -> need 2; 3..10 -> need 5)
  const ok = new Map([[0, leafSecrets[0]!], [2, leafSecrets[2]!], ...[3, 5, 7, 8, 10].map((i) => [i, leafSecrets[i]!] as [number, Uint8Array])]);
  assert.deepEqual(combineKey(xor, ok), K);
  // mandatory branch one short -> fails
  const short = new Map(ok); short.delete(0);
  assert.throws(() => combineKey(xor, short), /branch 0: 1 of 2/);
  // main branch alone cannot give K
  assert.throws(() => combineKey(xor, new Map([3, 4, 5, 6, 7].map((i) => [i, leafSecrets[i]!] as [number, Uint8Array]))));
});

test('tree rejects unsupported shapes', () => {
  const bad: unknown[] = [
    { kind: 'leaf', node: 0 },
    { kind: 'threshold', t: 0, n: 1, leaves: [{ node: 0 }] },
    { kind: 'threshold', t: 3, n: 2, leaves: [{ node: 0 }, { node: 1 }] },
    { kind: 'threshold', t: 1, n: 2, leaves: [{ node: 0 }] },
    { kind: 'threshold', t: 1, n: 2, leaves: [{ node: 0 }, { node: 0 }] },
    { kind: 'xor', branches: [thr(1, [0])] },
    { kind: 'xor', branches: [thr(1, [0]), { kind: 'xor', branches: [thr(1, [1]), thr(1, [2])] }] },
    { kind: 'threshold', t: 1, n: 1, leaves: [{ kind: 'threshold', t: 1, n: 1, leaves: [{ node: 0 }] }] },
  ];
  for (const b of bad) assert.throws(() => validateTree(b as AccessTree), Error, JSON.stringify(b));
  assert.throws(() => validateTree(thr(1, [5]), 3), /out of range/);
  validateTree(thr(2, [0, 1, 2]), 3);
});

test('headroom_separate', () => {
  const tree: AccessTree = { kind: 'xor', branches: [thr(5, [0, 1, 2, 3, 4, 5, 6, 7]), thr(2, [8, 9, 10])] };
  // all armed
  assert.deepEqual(headroom(tree, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { threshold: 3, mandatory: 1, overall: 1, mandatoryBranch: 1 });
  // threshold part generous, mandatory part at the limit
  const h = headroom(tree, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(h.threshold, 3);
  assert.equal(h.mandatory, 0);
  assert.equal(h.overall, 0);
  // mandatory broken but threshold fine: separate numbers, not averaged
  const h2 = headroom(tree, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([h2.threshold, h2.mandatory, h2.overall], [3, -1, -1]);
  // threshold at the limit, mandatory generous
  const h3 = headroom(tree, [0, 1, 2, 3, 4, 8, 9, 10]);
  assert.deepEqual([h3.threshold, h3.mandatory, h3.overall], [0, 1, 0]);
  // plain threshold has no mandatory part
  assert.deepEqual(headroom(thr(3, [0, 1, 2, 3, 4]), [0, 1, 2, 3]), { threshold: 1, mandatory: null, overall: 1, mandatoryBranch: null });
  assert.equal(headroom(tree, [8, 9], { mandatoryBranch: 1 }).mandatory, 0);
});

test('nodecell_roundtrip', () => {
  const d = {
    ...newNodeCellData(1_763_000_000n, '0x' + '11'.repeat(32)),
    state: 2 as const, descriptorHash: '0x' + '22'.repeat(32), pubkey: '0x02' + '33'.repeat(32), privkey: '0x' + '44'.repeat(32),
  };
  const enc = encodeNodeCellData(d);
  assert.equal(enc.length, 139);
  assert.equal(enc[0], 1);
  assert.equal(enc[1], 2);
  assert.deepEqual([...enc.slice(2, 10)], [0x00, 0x2b, 0x1f, 0x69, 0, 0, 0, 0].map((_, i) => Number((1_763_000_000n >> BigInt(8 * i)) & 0xffn)));
  assert.deepEqual(decodeNodeCellData(enc), d);
  assert.deepEqual(decodeNodeCellData(bytesToHex(enc)), d);
  const fresh = newNodeCellData(5n, '0x' + 'aa'.repeat(32));
  assert.deepEqual(decodeNodeCellData(encodeNodeCellData(fresh)), fresh);
  assert.equal(fresh.state, 0);
  // rejects
  assert.throws(() => decodeNodeCellData(enc.slice(0, 138)));
  assert.throws(() => decodeNodeCellData(new Uint8Array(140)));
  const v2 = enc.slice(); v2[0] = 2;
  assert.throws(() => decodeNodeCellData(v2), /version/);
  const s3 = enc.slice(); s3[1] = 3;
  assert.throws(() => decodeNodeCellData(s3), /state/);
  assert.throws(() => encodeNodeCellData({ ...d, pubkey: '0x02' }));
});

test('alive cell and since', () => {
  assert.equal(bytesToHex(aliveCellData()), '0x43525401');
  assert.ok(isAliveCell({ data: aliveCellData() }));
  assert.ok(isAliveCell({ outputData: '0x43525401' }));
  assert.ok(!isAliveCell({ outputData: '0x43525402' }));
  assert.ok(!isAliveCell({ outputData: '0x' }));
  assert.ok(!isAliveCell({}));
  assert.equal(sinceAbsoluteTimestamp(1_763_086_400), 0x4000000000000000n + 1_763_086_400n);
});

const defaults = {
  deployment: {},
  n: 8,
  termSeconds: 365 * 86_400,
  heartbeatBlocks: 8_000,
  heartbeatTipShannons: R.heartbeatTip.default,
  keygenTipShannons: R.keygenTip.default,
  maxFeeShannons: R.maxFee.default,
  organiserFeeShannons: R.organiserFee.default,
};
const within = (actual: number, expected: number, pct = 0.02) => assert.ok(Math.abs(actual - expected) <= expected * pct, `${actual} not within ${pct * 100}% of ${expected}`);

test('cost_estimate_defaults', () => {
  const c = estimateCost(defaults);
  within(c.spentNow + (c.spentOverTerm - c.spentNow), 1530); // organiser fee + fees + tips
  within(c.spentOverTerm, 1530);
  within(c.parked, 4440);
  assert.ok(c.parkedTransient > 2_000 && c.parkedTransient < 2_600); // ≈ 8 × 288
  assert.equal(c.runs, 365);
  assert.equal(c.detectionDelaySeconds, 3 * 8000 * 10.8);
  assert.ok(c.lines.length >= 6 && c.assumptions.length >= 3);
  assert.ok(c.lines.every((l) => l.fiat === undefined));
  const f = estimateCost({ ...defaults, fiatPerCkb: 0.01 });
  within(f.lines.find((l) => l.id === 'heartbeat_tips')!.fiat!, 0.01 * f.lines.find((l) => l.id === 'heartbeat_tips')!.ckb, 1e-9);
  within(c.monthly, (c.spentOverTerm - c.spentNow) / (365 / 30), 0.001);
});

test('cost_scales_with_heartbeat', () => {
  const tip = (hb: number) => estimateCost({ ...defaults, heartbeatBlocks: hb, heartbeatTipShannons: 100_000_000n, maxFeeShannons: 0n }).lines.find((l) => l.id === 'heartbeat_tips')!.ckb;
  within(tip(4_000), 2 * tip(8_000), 0.01);
  within(tip(8_000), 2 * tip(16_000), 0.01);
  assert.equal(estimateCost({ ...defaults, heartbeatBlocks: 4_000 }).detectionDelaySeconds, 3 * 4000 * 10.8);
});

test('switch_params_ranges', () => {
  const ok = { heartbeatBlocks: 8_000, heartbeatTip: 50_000_000n, keygenTip: 100_000_000n, maxFee: 200_000n, organiserFee: 0n };
  assert.deepEqual(validateSwitchParams(ok), []);
  assert.equal(SWITCH_PARAM_RANGES.heartbeatBlocks.max, 60_000);
  for (const heartbeatBlocks of [999, 60_001, 8000.5]) assert.throws(() => validateSwitchParams({ ...ok, heartbeatBlocks }), SwitchParamsError);
  validateSwitchParams({ ...ok, heartbeatBlocks: 1_000 });
  validateSwitchParams({ ...ok, heartbeatBlocks: 60_000 });
  assert.throws(() => validateSwitchParams({ ...ok, heartbeatTip: 9_999_999n }));
  validateSwitchParams({ ...ok, heartbeatTip: 10_000_000n });
  assert.throws(() => validateSwitchParams({ ...ok, keygenTip: 49_999_999n }));
  assert.throws(() => validateSwitchParams({ ...ok, organiserFee: -1n }));
  assert.throws(() => validateSwitchParams(ok, { n: 2 }));
  assert.throws(() => validateSwitchParams(ok, { n: 17 }));
  assert.throws(() => validateSwitchParams(ok, { n: 8, t: 9 }));
  assert.throws(() => validateSwitchParams(ok, { termSeconds: 86_399 }));
  assert.equal(validateSwitchParams(ok, { n: 4, t: 3 }).length, 1); // n < 5 warning
  assert.equal(validateSwitchParams(ok, { n: 8, t: 5, termSeconds: 6 * 365 * 86_400 }).length, 1); // > 5 years warning
  const long = { n: 8, t: 5, termSeconds: 2 * 365 * 86_400, mandatory: { j: 1, m: 1 } };
  assert.throws(() => validateSwitchParams(ok, long), /acknowledgement/);
  validateSwitchParams(ok, { ...long, acknowledgedOneOfOne: true });
  validateSwitchParams(ok, { ...long, mandatory: { j: 2, m: 3 } });
});
