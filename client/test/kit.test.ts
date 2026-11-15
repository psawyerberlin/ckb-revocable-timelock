import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import Ajv2020 from 'ajv/dist/2020.js';
import { bytesToHex, hexToBytes } from '../src/core/bytes.ts';
import { blake2b256 } from '../src/core/hash.ts';
import { encodeNodeCellData, newNodeCellData } from '../src/core/cells.ts';
import { wrap } from '../src/core/envelope.ts';
import type { AccessTree } from '../src/core/tree.ts';
import type { FetchLike } from '../src/chain/rpc.ts';
import {
  type ChainFacts, type Descriptor, type DescriptorPlan, DescriptorError, RecoveryError, buildDescriptor, descriptorHash,
  envelopeAad, unwrapAll, unwrapAllReport, validateDescriptor, wrapKey,
} from '../src/kit/descriptor.ts';
import { collectReleases, parseReleases, recoverOffline, recoverOnline } from '../src/kit/recover.ts';
import { KIT_VERSION, KitError, generateKit } from '../src/kit/kit.ts';
import { KIT_RECOVERY_JS } from '../src/kit/assets.generated.ts';
import { buildKitAssets, GENERATED } from '../scripts/build-kit.mjs';
import { seeded, vector } from './util.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'schema', 'descriptor.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaValid = ajv.compile(schema);

const h = (b: number) => '0x' + b.toString(16).padStart(2, '0').repeat(32);
const T = h(0x5a);
const NODE_LOCK = h(0xa1);

// ---- fixture: 8 runners, tree xor(5-of-8 over all, 2-of-3 mandatory over nodes 0..2) -------------------------------

const nodePriv = Array.from({ length: 8 }, (_, i) => blake2b256(Uint8Array.of(0x70, i)));
const nodePub = nodePriv.map((d) => bytesToHex(secp.getPublicKey(d, true)));
const servicePub = Array.from({ length: 8 }, (_, i) => bytesToHex(secp.getPublicKey(blake2b256(Uint8Array.of(0x71, i)), true)));
const Rs = Array.from({ length: 8 }, (_, i) => bytesToHex(blake2b256(Uint8Array.of(0x72, i))));
const tree: AccessTree = {
  kind: 'xor',
  branches: [
    { kind: 'threshold', t: 5, n: 8, leaves: [0, 1, 2, 3, 4, 5, 6, 7].map((node) => ({ node })) },
    { kind: 'threshold', t: 2, n: 3, leaves: [0, 1, 2].map((node) => ({ node })) },
  ],
};
const K = blake2b256(Uint8Array.of(0x4b));

function chainFacts(): ChainFacts {
  return {
    T,
    deployment: { network_id: 1, node_lock: { code_hash: NODE_LOCK }, crt_code_hash: h(0xb1), crt_data_hash: h(0xb2) },
    aliveCell: { tx_hash: h(0xd0), index: '0x0' },
    nodeCells: Rs.map((R, i) => ({
      R, outPoint: { tx_hash: h(0xd0), index: '0x' + (i + 1).toString(16) },
      data: { ...newNodeCellData(1_900_000_000n, h(0xee)), state: 1 as const, pubkey: nodePub[i]! },
    })),
  };
}
function plan(): DescriptorPlan {
  return {
    K, access_tree: tree, created_at: 1_763_000_000, coordinator_url: 'https://crt.chainsolution.net',
    nodes: Rs.map((R, i) => ({ runner_lock_hash: R, service_pubkey: servicePub[i]!, peer_id: `QmPeer${i}`, label: `runner ${i}` })),
  };
}
const descriptor = (): Descriptor => buildDescriptor(plan(), chainFacts());
const releasesOf = (nodes: number[]) => new Map(nodes.map((i) => [Rs[i]!, bytesToHex(nodePriv[i]!)]));

// ---- descriptor ----------------------------------------------------------------------------------------------------

test('descriptor_schema_vector', () => {
  const v = vector('descriptor.json');
  assert.ok(schemaValid(v.descriptor), JSON.stringify(schemaValid.errors));
  validateDescriptor(v.descriptor);
  assert.equal(descriptorHash(v.descriptor), v.descriptor_hash);
  const d = descriptor();
  assert.ok(schemaValid(d), JSON.stringify(schemaValid.errors));
});

test('descriptor_schema_rejects', () => {
  const base = vector('descriptor.json').descriptor;
  const mutations: [string, (d: any) => void][] = [
    ['extra property', (d) => { d.extra = 1; }],
    ['version 2', (d) => { d.version = 2; }],
    ['uppercase hex', (d) => { d.deployment.crt_code_hash = d.deployment.crt_code_hash.toUpperCase().replace('0X', '0x'); }],
    ['short hash', (d) => { d.identity = '0x1234'; }],
    ['missing nodes', (d) => { delete d.nodes; }],
    ['bad pubkey prefix', (d) => { d.nodes[0].pubkey = '0x04' + d.nodes[0].pubkey.slice(4); }],
    ['node extra field', (d) => { d.nodes[0].x = 'y'; }],
    ['float index', (d) => { d.alive_cell.index = 1.5; }],
    ['unknown tree kind', (d) => { d.access_tree = { kind: 'and', branches: [] }; }],
    ['xor with one branch', (d) => { d.access_tree = { kind: 'xor', branches: [d.access_tree] }; }],
  ];
  for (const [name, f] of mutations) {
    const d = structuredClone(base);
    f(d);
    assert.equal(schemaValid(d), false, `schema accepts: ${name}`);
    assert.throws(() => validateDescriptor(d), DescriptorError, `validateDescriptor accepts: ${name}`);
  }
  // semantic rules beyond the schema
  const semantic: [string, (d: any) => void][] = [
    ['wrong identity', (d) => { d.identity = h(0x11); }],
    ['leaf out of range', (d) => { d.access_tree.leaves[2].node = 7; }],
    ['commitment count', (d) => { d.share_commitments.pop(); }],
    ['t > n', (d) => { d.access_tree.t = 4; }],
    ['duplicate runner', (d) => { d.nodes[1].runner_lock_hash = d.nodes[0].runner_lock_hash; }],
  ];
  for (const [name, f] of semantic) {
    const d = structuredClone(base);
    f(d);
    assert.throws(() => validateDescriptor(d), DescriptorError, `validateDescriptor accepts: ${name}`);
  }
});

test('build_descriptor_from_chain', () => {
  const d = descriptor();
  assert.equal(d.nodes.length, 8);
  assert.equal(d.share_commitments.length, 11);
  assert.deepEqual(d.alive_cell, { tx_hash: h(0xd0), index: 0 });
  assert.equal(d.nodes[3]!.node_cell.index, 4);
  assert.equal(d.nodes[3]!.pubkey, nodePub[3]);
  // deterministic: the same K and switch give the same commitments, a different K does not
  assert.deepEqual(descriptor().share_commitments, d.share_commitments);
  assert.notDeepEqual(buildDescriptor({ ...plan(), K: blake2b256(Uint8Array.of(1)) }, chainFacts()).share_commitments, d.share_commitments);
  const facts = chainFacts();
  facts.nodeCells[2]!.data.state = 0;
  assert.throws(() => buildDescriptor(plan(), facts), /state 0/);
  const facts2 = chainFacts();
  facts2.nodeCells.pop();
  assert.throws(() => buildDescriptor(plan(), facts2), /exactly one Node Cell/);
});

test('wrap_key_refuses_other_key', async () => {
  await assert.rejects(wrapKey(blake2b256(Uint8Array.of(9)), descriptor(), seeded(1)), /K does not match/);
});

// ---- recovery ------------------------------------------------------------------------------------------------------

test('recover_offline_roundtrip', async () => {
  const d = descriptor();
  const envs = await wrapKey(K, d, seeded(42));
  assert.equal(envs.length, 11);
  // exactly t: 5 of the 8, two of them (0, 1) in the mandatory 2-of-3
  const got = await unwrapAll(d, envs, releasesOf([0, 1, 3, 4, 5]));
  assert.deepEqual(got, K);
  // offline: bare private keys pasted, matched to nodes by pubkey; also R:privkey and released Node Cell data
  const pasted = [bytesToHex(nodePriv[0]!), `${Rs[1]}:${bytesToHex(nodePriv[1]!)}`, bytesToHex(nodePriv[3]!).slice(2),
    bytesToHex(encodeNodeCellData({ ...newNodeCellData(1n, h(0xee)), state: 2, pubkey: nodePub[4]!, privkey: bytesToHex(nodePriv[4]!) })),
    bytesToHex(nodePriv[5]!) + '\n0xdeadbeef'];
  assert.deepEqual(await recoverOffline(d, envs, pasted), K);
  assert.deepEqual(parseReleases(d, pasted).unmatched, ['0xdeadbeef']);
  // more releases than needed work too
  assert.deepEqual(await unwrapAll(d, envs, releasesOf([0, 1, 2, 3, 4, 5, 6, 7])), K);
});

test('recover_one_short_headroom_message', async () => {
  const d = descriptor();
  const envs = await wrapKey(K, d, seeded(43));
  // threshold part one short (4 of 5), mandatory fine
  await assert.rejects(unwrapAll(d, envs, releasesOf([0, 1, 3, 4])), (e: unknown) => {
    assert.ok(e instanceof RecoveryError);
    assert.match(e.message, /threshold headroom -1, mandatory headroom 0/);
    assert.equal(e.report.headroom.threshold, -1);
    return true;
  });
  // mandatory part one short (1 of 2), threshold fine
  await assert.rejects(recoverOffline(d, envs, [0, 3, 4, 5, 6].map((i) => bytesToHex(nodePriv[i]!))), /threshold headroom 0, mandatory headroom -1/);
});

test('recover_garbage_identified_by_commitment', async () => {
  const d = descriptor();
  const envs = await wrapKey(K, d, seeded(44));
  // a well-formed envelope that carries a garbage share for leaf 3 (node 3)
  const bad = envs.map((e) => ({ ...e }));
  const garbage = Uint8Array.of(4, ...blake2b256(Uint8Array.of(0x99)));
  bad[3]!.envelope = bytesToHex(await wrap(hexToBytes(nodePub[3]!), garbage, envelopeAad(d.identity, 3), seeded(5)));
  const r = await unwrapAllReport(d, bad, releasesOf([0, 1, 3, 4, 5]));
  assert.equal(r.K, null);
  assert.deepEqual(r.leaves.filter((l) => l.status === 'commitment-mismatch').map((l) => l.position), [3]);
  await assert.rejects(unwrapAll(d, bad, releasesOf([0, 1, 3, 4, 5])), /leaf 3 .*does not match its commitment/);
  // one more honest release makes up for it
  assert.deepEqual(await unwrapAll(d, bad, releasesOf([0, 1, 3, 4, 5, 6])), K);
  // a garbage release value (wrong private key) is caught by the pubkey check
  const rel = releasesOf([0, 1, 3, 4, 5]);
  rel.set(Rs[5]!, bytesToHex(nodePriv[6]!));
  const r2 = await unwrapAllReport(d, envs, rel);
  assert.deepEqual(r2.leaves.filter((l) => l.status === 'bad-privkey').map((l) => l.position), [5]);
  // a tampered envelope byte
  const t = envs.map((e) => ({ ...e }));
  t[4]!.envelope = t[4]!.envelope.slice(0, -2) + (t[4]!.envelope.endsWith('00') ? '01' : '00');
  const r3 = await unwrapAllReport(d, t, releasesOf([0, 1, 3, 4, 5]));
  assert.deepEqual(r3.leaves.filter((l) => l.status === 'unwrap-failed').map((l) => l.position), [4]);
});

function mockChain(cells: any[]): FetchLike {
  return async (_url, init) => {
    const req = JSON.parse(init.body!);
    assert.equal(req.method, 'get_cells');
    const sk = req.params[0];
    const objects = cells.filter((c) => {
      const s = sk.script_type === 'lock' ? c.output.lock : c.output.type;
      return s && s.code_hash === sk.script.code_hash && s.hash_type === sk.script.hash_type && s.args.startsWith(sk.script.args);
    });
    return { ok: true, status: 200, json: async () => ({ id: req.id, jsonrpc: '2.0', result: { objects, last_cursor: '0x' } }) };
  };
}

test('collect_releases_online', async () => {
  const d = descriptor();
  const envs = await wrapKey(K, d, seeded(45));
  const cell = (i: number, state: 0 | 1 | 2, priv?: string) => ({
    out_point: { tx_hash: h(0xd1), index: '0x' + i.toString(16) },
    output: { capacity: '0x5af3107a4000', lock: { code_hash: NODE_LOCK, hash_type: 'data2', args: T + Rs[i]!.slice(2) }, type: null },
    output_data: bytesToHex(encodeNodeCellData({ ...newNodeCellData(1n, h(0xee)), state, pubkey: nodePub[i]!, privkey: priv ?? h(0) })),
  });
  const cells = [0, 1, 3, 4, 5].map((i) => cell(i, 2, bytesToHex(nodePriv[i]!)));
  cells.push(cell(6, 1));
  cells.push(cell(7, 2, bytesToHex(nodePriv[2]!))); // privkey does not match its pubkey: ignored
  const fetch = mockChain(cells);
  const rel = await collectReleases(T, ['http://rpc.invalid'], { nodeLockCodeHash: NODE_LOCK, fetch });
  assert.deepEqual([...rel.keys()].sort(), [0, 1, 3, 4, 5].map((i) => Rs[i]!).sort());
  assert.deepEqual(await recoverOnline(d, envs, ['http://rpc.invalid'], { fetch }), K);
});

// ---- kit -----------------------------------------------------------------------------------------------------------

async function kitInput(seed = 46) {
  const d = descriptor();
  const envelopes = await wrapKey(K, d, seeded(seed));
  return {
    descriptor: d, envelopes, kitVersion: KIT_VERSION, deadline: 1_900_000_000,
    application: { name: 'test-app', version: '1.2.3', payload: { ciphertext: '0x00ff', note: '</script><b>' },
      script: 'window.crtApplication = { onKey(K) { window.__gotKey = Array.from(K); } };' },
  };
}

test('kit_deterministic', async () => {
  const input = await kitInput();
  const a = generateKit(input);
  const b = generateKit(structuredClone(input));
  assert.equal(a, b);
  // key order of the inputs does not matter
  const reordered = { ...input, descriptor: Object.fromEntries(Object.entries(input.descriptor).reverse()) as unknown as Descriptor };
  assert.equal(generateKit(reordered), a);
  assert.throws(() => generateKit({ ...input, kitVersion: '0' }), KitError);
});

test('kit_self_contained', async () => {
  const html = generateKit(await kitInput());
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']?\s*(https?:)?\/\//i);
  assert.doesNotMatch(html, /\bsrc\s*=/i);
  assert.doesNotMatch(html, /\bhref\s*=/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(/i);
  assert.doesNotMatch(html, /<link\b|<iframe\b|<img\b/i);
  // embedded data, banner, application slot
  assert.match(html, /<script type="application\/json" id="crt-descriptor">/);
  assert.match(html, /<script type="application\/json" id="crt-envelopes">/);
  assert.match(html, /<div id="crt-application"><\/div>/);
  assert.match(html, /MISMATCH/);
  assert.match(html, /@media print/);
  assert.ok(html.includes(`<code id="crt-printed-hash">${descriptorHash((await kitInput()).descriptor)}</code>`));
  // the payload's "</script>" cannot close the data block: exactly the expected number of script elements
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 5);
  assert.ok(!KIT_RECOVERY_JS.includes('</script'));
});

test('kit_under_400kb', async () => {
  const html = generateKit(await kitInput());
  const size = new TextEncoder().encode(html).length;
  assert.ok(size < 400 * 1024, `kit is ${size} bytes`);
});

test('kit_assets_up_to_date', async () => {
  assert.equal(fs.readFileSync(GENERATED, 'utf8'), await buildKitAssets(), 'run npm run build:kit');
});

/** Runs the kit's scripts in a VM with a minimal DOM: self-verification and `window.CRT_KIT.api.recover`. */
function runKit(html: string) {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1]!, body: m[2]! }));
  const printed = /<code id="crt-printed-hash">([^<]*)<\/code>/.exec(html)![1]!;
  const els = new Map<string, any>();
  const el = (id: string, textContent = '') => {
    if (!els.has(id)) els.set(id, { id, textContent, value: textContent, className: '', attrs: {} as Record<string, string>, getAttribute(n: string) { return this.attrs[n] ?? null; }, addEventListener() {} });
    return els.get(id);
  };
  for (const s of scripts) {
    const id = /id="([^"]+)"/.exec(s.attrs)?.[1];
    if (!id) continue;
    const e = el(id, s.body);
    const kv = /data-kit-version="([^"]*)"/.exec(s.attrs);
    if (kv) e.attrs['data-kit-version'] = kv[1];
  }
  el('crt-printed-hash', printed);
  el('crt-verify');
  const document = { readyState: 'complete', getElementById: (id: string) => el(id), addEventListener() {} };
  const ctx: any = vm.createContext({ document, crypto: globalThis.crypto, TextEncoder, TextDecoder, console });
  ctx.window = ctx;
  for (const s of scripts) if (!/application\/json/.test(s.attrs)) vm.runInContext(s.body, ctx);
  return { ctx, els };
}

test('kit_recovery_in_page', async () => {
  const input = await kitInput();
  const html = generateKit(input);
  const { ctx, els } = runKit(html);
  assert.match(els.get('crt-verify').textContent, /^MATCH/);
  assert.equal(ctx.CRT_KIT.version, KIT_VERSION);
  assert.equal(ctx.CRT_KIT.application.name, 'test-app');
  assert.equal(ctx.CRT_KIT.application.payload.note, '</script><b>');
  assert.equal(typeof ctx.CRT_KIT.api.readSwitch, 'function');
  assert.equal(typeof ctx.CRT_KIT.api.collectReleases, 'function');
  const got = await ctx.CRT_KIT.api.recover([0, 1, 3, 4, 5].map((i) => bytesToHex(nodePriv[i]!)));
  assert.deepEqual(Array.from(got), Array.from(K));
  assert.deepEqual(Array.from(ctx.__gotKey), Array.from(K));
  assert.equal(els.get('crt-key').textContent, bytesToHex(K));
  // a kit whose embedded descriptor was altered shows MISMATCH
  const tampered = html.replace('"label": "runner 3"', '"label": "runner X"');
  assert.notEqual(tampered, html);
  assert.match(runKit(tampered).els.get('crt-verify').textContent, /^MISMATCH/);
});
