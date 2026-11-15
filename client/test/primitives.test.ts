import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes, concat } from '../src/core/bytes.ts';
import { blake2b256, identity, shareCommitment, descriptorHash } from '../src/core/hash.ts';
import { canonicalize } from '../src/core/canon.ts';
import { split, combine } from '../src/core/shamir.ts';
import { wrap, unwrap, envelopeKey } from '../src/core/envelope.ts';
import { jobPayload, parseResult } from '../src/core/payload.ts';
import { readJson, vector, seeded } from './util.ts';

test('identity_vectors', () => {
  for (const v of vector('identity.json').vectors) {
    assert.equal(bytesToHex(identity(v.network_id, v.type_id)), v.identity);
    assert.equal(bytesToHex(jobPayload(v.type_id)), v.job_payload);
  }
  assert.throws(() => identity(1, '0x00'));
});

test('blake2b256 uses the CKB personalization', () => {
  // blake2b-256("") with ckb-default-hash
  assert.equal(bytesToHex(blake2b256(new Uint8Array())), '0x44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e');
});

test('descriptor_hash_vector', () => {
  const v = vector('descriptor.json');
  assert.equal(canonicalize(v.descriptor), v.canonical);
  assert.equal(bytesToHex(descriptorHash(v.descriptor)), v.descriptor_hash);
});

test('canonicalize: key order, escapes, rejects floats', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x"\n'], 'é': 2, '10': 3, '2': 4 }), '{"10":3,"2":4,"a":[true,null,"x\\"\\n"],"b":1,"é":2}');
  assert.equal(canonicalize({ "😀": 1, "～": 2 }), `{"😀":1,"～":2}`); // UTF-16 code unit order: 0xD83D < 0xFF5E
  assert.throws(() => canonicalize(1.5));
  assert.throws(() => canonicalize({ a: undefined } as never));
});

test('shamir_combine_vectors', () => {
  for (const v of vector('shamir.json').vectors) {
    const shares: Uint8Array[] = v.shares.map(hexToBytes);
    v.share_commitments.forEach((c: string, i: number) => assert.equal(bytesToHex(shareCommitment(shares[i]!)), c));
    for (const subset of v.combine_subsets as number[][]) {
      assert.equal(bytesToHex(combine(subset.map((i) => shares[i]!))), v.secret);
    }
  }
});

test('shamir_roundtrip', () => {
  const rng = seeded(42);
  for (let n = 1; n <= 12; n++) for (let t = 1; t <= n; t++) {
    const secret = rng(32);
    const shares = split(secret, t, n, rng);
    assert.equal(shares.length, n);
    shares.forEach((s, i) => { assert.equal(s.length, 33); assert.equal(s[0], i + 1); });
    // first t, last t, and a scattered subset
    for (const pick of [shares.slice(0, t), shares.slice(n - t), [...shares].reverse().filter((_, i) => i % 2 === 0 || i < t).slice(0, t)]) {
      assert.deepEqual(combine(pick), secret);
    }
  }
});

test('wrong share is detected by commitment, not by combine', () => {
  const rng = seeded(7);
  const secret = rng(32);
  const shares = split(secret, 3, 5, rng);
  const commitments = shares.map((s) => bytesToHex(shareCommitment(s)));
  const bad = shares.map((s) => s.slice());
  bad[1]![5]! ^= 0x01;
  const result = combine([bad[0]!, bad[1]!, bad[2]!]); // does not throw
  assert.notDeepEqual(result, secret);
  assert.equal(bytesToHex(shareCommitment(bad[1]!)) === commitments[1], false);
  assert.equal(bytesToHex(shareCommitment(bad[0]!)), commitments[0]);
  assert.throws(() => combine([shares[0]!, shares[0]!]), /duplicate/);
});

test('envelope_roundtrip', async () => {
  const rng = seeded(1);
  const d = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const P = secp.getPublicKey(d, true);
  const aad = concat(rng(32), Uint8Array.of(0, 3));
  for (const len of [1, 33, 32]) {
    const m = rng(len);
    const env = await wrap(P, m, aad, rng);
    assert.equal(env.length, 33 + 12 + len + 16);
    assert.deepEqual(await unwrap(d, env, aad), m);
  }
  // default rng
  const m = new Uint8Array(33).fill(9);
  assert.deepEqual(await unwrap(d, await wrap(P, m, aad), aad), m);
});

test('envelope_tamper_fails', async () => {
  const rng = seeded(2);
  const d = rng(32);
  const P = secp.getPublicKey(d, true);
  const aad = rng(34);
  const m = rng(33);
  const env = await wrap(P, m, aad, rng);
  for (const i of [40, 33, env.length - 1]) { // nonce, ciphertext, tag bytes
    const t = env.slice(); const k = i === 40 ? 35 : i; t[k]! ^= 1;
    await assert.rejects(unwrap(d, t, aad));
  }
  const badE = env.slice(); badE[0] = badE[0] === 2 ? 3 : 2;
  await assert.rejects(unwrap(d, badE, aad));
  const wrongAad = aad.slice(); wrongAad[33]! ^= 1;
  await assert.rejects(unwrap(d, env, wrongAad));
  await assert.rejects(unwrap(rng(32), env, aad));
  await assert.rejects(unwrap(d, env.slice(0, 40), aad));
});

test('envelope HKDF known-answer', () => {
  const k = readJson('kat-hkdf.json');
  assert.equal(bytesToHex(envelopeKey(hexToBytes(k.s), hexToBytes(k.E), hexToBytes(k.P))), k.key);
});

test('parseResult', () => {
  const T = new Uint8Array(32).fill(7);
  const r = parseResult(concat(new TextEncoder().encode('CRT1'), Uint8Array.of(3), T));
  assert.equal(r.status, 'release');
  assert.equal(r.T, bytesToHex(T));
  assert.equal(parseResult(concat(new TextEncoder().encode('CRT1'), Uint8Array.of(8))).T, null);
  assert.throws(() => parseResult(new TextEncoder().encode('CRT1\x63')));
  assert.throws(() => parseResult(new Uint8Array(10)));
});

test('csr_job_vendor_hash', () => {
  const body = fs.readFileSync(new URL('../vendor/csr-job.mjs', import.meta.url));
  const pinned = fs.readFileSync(new URL('../vendor/csr-job.sha256', import.meta.url), 'utf8').trim().split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), pinned);
});
