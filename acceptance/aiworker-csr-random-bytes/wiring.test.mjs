// Acceptance for aiworker spec 00 (crt repo: aiworker/00-csr-random-bytes.md).
// Runs from the ROOT OF THE ckb-service-runner CHECKOUT: copy this directory there first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

test('runs inside the CSR repository', () => {
  assert.ok(exists('runner', 'src', 'runtime', 'host.rs'), 'run from the ckb-service-runner root');
});

test('host interface spec defines 7050 random_bytes and keeps 7051 reserved', () => {
  const s = read('spec', 'host-interface.md');
  assert.match(s, /\|\s*7050\s*\|\s*`random_bytes\(addr,\s*len\)`/);
  assert.match(s, /1024/);
  assert.match(s, /\|\s*7051\s*\|\s*`prekey_decrypt`[^\n]*reserved/i);
  assert.doesNotMatch(s, /7050,\s*7051\s*\|\s*`random_bytes`,\s*`prekey_decrypt`\s*\|\s*reserved/);
});

test('host implements syscall 7050 with the documented codes', () => {
  const h = read('runner', 'src', 'runtime', 'host.rs');
  assert.match(h, /7050/);
  assert.match(h, /random_bytes/i);
  assert.match(h, /1024/);
  // never logged: no debug/log macro on the same line as the drawn bytes
  for (const line of h.split('\n')) {
    if (/random_bytes|OsRng|getrandom/.test(line)) assert.doesNotMatch(line, /debug!|info!|warn!|println!|log::/);
  }
});

test('randtest service, manifest and workspace entry exist', () => {
  assert.ok(exists('services', 'rust', 'randtest', 'src', 'main.rs'));
  assert.ok(exists('services', 'manifests', 'randtest.toml'));
  assert.match(read('services', 'rust', 'Cargo.toml'), /"randtest"/);
  const m = read('services', 'rust', 'randtest', 'src', 'main.rs');
  assert.match(m, /1025/);
  assert.match(m, /result_put/);
});

test('csr-svc wrapper exposes random_bytes', () => {
  const l = read('services', 'rust', 'csr-svc', 'src', 'lib.rs');
  assert.match(l, /RANDOM_BYTES:\s*u64\s*=\s*7050/);
  assert.match(l, /pub fn random_bytes\(/);
});

test('docs updated', () => {
  assert.match(read('CHANGELOG.md'), /random_bytes/);
  assert.doesNotMatch(read('docs', 'open-questions.md'), /random_bytes`\) is reserved/);
  assert.match(read('docs', 'open-questions.md'), /prekey_decrypt/);
  assert.match(read('docs', 'testing.md'), /randtest/);
});
