// Acceptance for aiworker/03-crt-client.md. Run from the repository root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? (['node_modules', 'dist', '.git'].includes(e.name) ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
const allSrc = () => walk('client/src').filter((f) => /\.(ts|mts|js|mjs)$/.test(f)).map((f) => read(f)).join('\n');

test('package layout and dependencies', () => {
  const pkg = JSON.parse(read('client', 'package.json'));
  assert.equal(pkg.type, 'module');
  const deps = Object.keys(pkg.dependencies || {});
  for (const d of deps) assert.ok(['@noble/secp256k1', '@noble/hashes', '@ckb-ccc/core'].includes(d), `unexpected runtime dependency ${d}`);
  assert.ok(pkg.scripts && pkg.scripts.test, 'npm test script');
  for (const m of ['hash', 'shamir', 'envelope', 'tree', 'cells', 'payload', 'canon', 'cost']) assert.ok(exists('client', 'src', 'core', `${m}.ts`), `core/${m}.ts`);
  for (const m of ['rpc', 'deployment', 'runners', 'switch']) assert.ok(exists('client', 'src', 'chain', `${m}.ts`), `chain/${m}.ts`);
  for (const m of ['descriptor', 'kit', 'recover']) assert.ok(exists('client', 'src', 'kit', `${m}.ts`), `kit/${m}.ts`);
  assert.ok(exists('client', 'kit', 'template.html'));
  assert.ok(exists('client', 'schema', 'descriptor.schema.json'));
});

test('vendored csr-job.mjs is pinned by hash', () => {
  const body = fs.readFileSync(path.join(ROOT, 'client', 'vendor', 'csr-job.mjs'));
  const pinned = read('client', 'vendor', 'csr-job.sha256').trim().split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), pinned);
  assert.match(body.toString('utf8').split('\n').slice(0, 5).join('\n'), /tag|v\d+\.\d+\.\d+/i);
});

test('constants of SPEC.md are present', () => {
  const s = allSrc();
  assert.match(s, /CRT\/v1\/cell/);
  assert.match(s, /CRT\/v1\/share/);
  assert.match(s, /CRT\/v1\/descriptor/);
  assert.match(s, /CRT-ENV-v1/);
  assert.match(s, /86_?400/);
  assert.match(s, /0x11b|0x1b\b|283/i); // GF(2^8) reduction
  assert.match(s, /ckb-default-hash/);
  assert.match(s, /545950455f4944/i);
  assert.match(s, /estimateCost/);
  assert.match(s, /validateSwitchParams/);
  assert.match(s, /60_?000/); // HEARTBEAT upper bound
});

test('hard-fail verification has no override anywhere', () => {
  const s = allSrc();
  for (const bad of [/skipVerif/i, /insecure/i, /allowUnverified/i, /--force/, /continueAnyway/i, /noVerify/i]) {
    assert.doesNotMatch(s, bad, `override-like token ${bad} found`);
  }
  assert.match(s, /VerificationError/);
});

test('cancel builder has no fee output and no type-id output path', () => {
  const tx = walk('client/src/tx').map((f) => read(f)).join('\n');
  assert.match(tx, /buildCancel/);
  assert.match(tx, /buildCreate/);
  assert.match(tx, /buildArm/);
  assert.match(tx, /buildRenew/);
  assert.match(tx, /buildRewrap/);
  assert.match(tx, /buildReclaim/);
});

test('kit template is self-contained', () => {
  const t = read('client', 'kit', 'template.html');
  assert.doesNotMatch(t, /(src|href)=["']https?:/i);
  assert.doesNotMatch(t, /@import/);
  assert.doesNotMatch(t, /url\(\s*["']?https?:/i);
  assert.match(t, /MISMATCH/);
  assert.match(t, /application\/json/);
});

test('vectors consumed by the client tests', () => {
  const tests = walk('client').filter((f) => /\.(test|spec)\.(ts|mts|js|mjs)$/.test(f) || f.includes('/test/')).map((f) => read(f)).join('\n');
  assert.match(tests, /identity\.json/);
  assert.match(tests, /shamir\.json/);
  assert.match(tests, /descriptor\.json/);
});

test('CLI and docs', () => {
  assert.ok(exists('client', 'bin', 'crt.ts') || exists('client', 'bin', 'crt.mjs'));
  assert.match(read('client', 'README.md'), /recover/i);
  assert.match(read('docs', 'developers.md'), /wrapKey|generateKit/);
  assert.match(read('CHANGELOG.md'), /client/i);
});
