// Acceptance for aiworker/01-crt-contracts.md. Run from the repository root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? (e.name === '.git' || e.name === 'target' || e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));

test('phase 1: housekeeping done', () => {
  const all = walk('.');
  assert.equal(all.filter((f) => f.includes('Zone.Identifier')).length, 0, 'Zone.Identifier files remain');
  assert.ok(!exists('crt-spec-repo.tar.gz'));
  assert.ok(exists('docs', 'history', 'concept-v0.3.md'));
  assert.ok(exists('docs', 'history', 'node-api-v0.1-draft.md'));
  assert.ok(!exists('node'));
  assert.ok(exists('contracts', 'Cargo.toml'));
  assert.ok(exists('rust-toolchain.toml') || exists('contracts', 'rust-toolchain.toml'));
  assert.ok(exists('scripts', 'build-contracts.sh'));
  assert.match(read('scripts', 'build-contracts.sh'), /set -euo pipefail/);
  assert.match(read('scripts', 'build-contracts.sh'), /riscv64imac-unknown-none-elf/);
  assert.match(read('contracts', 'Cargo.toml'), /"crt-core"/);
  assert.match(read('contracts', 'Cargo.toml'), /"crt-node-lock"/);
  assert.match(read('contracts', 'Cargo.toml'), /"crt-contract-tests"/);
  assert.match(read('contracts', 'Cargo.toml'), /ckb-std\s*=\s*\{\s*version\s*=\s*"=1\.1\.0"/);
});

test('phase 2: crt-core constants match SPEC.md section 2', () => {
  const src = fs.readdirSync(path.join(ROOT, 'contracts', 'crt-core', 'src')).map((f) => read('contracts', 'crt-core', 'src', f)).join('\n');
  assert.match(src, /#!\[no_std\]/);
  assert.match(src, /PREFIX_CELL[^\n]*b"CRT\/v1\/cell"/);
  assert.match(src, /PREFIX_SHARE[^\n]*b"CRT\/v1\/share"/);
  assert.match(src, /PREFIX_DESCRIPTOR[^\n]*b"CRT\/v1\/descriptor"/);
  assert.match(src, /GRACE_SECONDS[^\n]*86_?400/);
  assert.match(src, /PAYLOAD_MAGIC[^\n]*b"CRTS"/);
  assert.match(src, /NODE_CELL_DATA_LEN[^\n]*139/);
  assert.match(src, /545950455f4944/i);
  assert.match(src, /pub fn identity\(/);
  assert.match(src, /pub fn parse_payload\(/);
  assert.match(src, /pub fn pubkey_from_privkey\(/);
  assert.match(src, /pub fn since_absolute_timestamp\(/);
  assert.match(src, /pub struct NodeCellData/);
  const cargo = read('contracts', 'crt-core', 'Cargo.toml');
  assert.doesNotMatch(cargo, /ckb-std/, 'crt-core must not depend on ckb-std');
  assert.match(cargo, /k256/);
});

test('phase 3: crt-node-lock has every error code of SPEC.md section 4.3', () => {
  const src = fs.readdirSync(path.join(ROOT, 'contracts', 'crt-node-lock', 'src')).map((f) => read('contracts', 'crt-node-lock', 'src', f)).join('\n');
  for (const code of [5, 6, 8, 11, 12, 13, 15, 20, 21, 22, 23, 24]) {
    assert.match(src, new RegExp(`(=|return|Err\\()\\s*${code}\\b`), `error code ${code} not found in crt-node-lock`);
  }
  assert.match(src, /GRACE_SECONDS/);
  assert.match(src, /crt_core/);
  assert.match(read('contracts', 'crt-node-lock', 'Cargo.toml'), /ckb-std/);
});

test('phase 4: contract tests exist with the fixed names', () => {
  const dir = path.join(ROOT, 'contracts', 'crt-contract-tests');
  assert.ok(fs.existsSync(dir));
  const src = walk('contracts/crt-contract-tests').filter((f) => f.endsWith('.rs')).map((f) => read(f)).join('\n');
  for (const n of ['owner_can_update_deadline', 'owner_can_write_descriptor_hash', 'owner_can_destroy', 'node_commit_ok',
    'node_commit_without_runner_input_rejected', 'node_commit_two_outputs_rejected', 'node_commit_zero_pubkey_rejected',
    'node_commit_with_privkey_rejected', 'node_commit_changing_deadline_rejected', 'node_commit_lower_capacity_rejected',
    'node_release_ok', 'node_release_wrong_privkey_rejected', 'node_release_early_since_rejected', 'node_release_block_since_rejected',
    'node_release_relative_timestamp_rejected', 'node_release_without_alive_dep_rejected', 'node_release_alive_dep_wrong_args_rejected',
    'node_release_changes_pubkey_rejected', 'node_release_from_state0_rejected', 'node_state2_to_anything_rejected',
    'bad_args_length_rejected', 'bad_data_length_rejected', 'cycles_release_under_budget', 'vectors_identity_matches']) {
    assert.match(src, new RegExp(`fn ${n}\\(`), `missing test ${n}`);
  }
  assert.match(read('contracts', 'crt-contract-tests', 'Cargo.toml'), /ckb-testtool/);
});

test('vectors are untouched and used', () => {
  const v = JSON.parse(read('spec', 'vectors', 'identity.json'));
  assert.equal(v.vectors.length, 5);
  assert.equal(v.vectors[0].identity, '0x2e854a78b895939d284a957fed2aa32ed9ab9c24b1442c8616f52549d6020596');
  const tests = walk('contracts').filter((f) => f.endsWith('.rs')).map((f) => read(f)).join('\n');
  assert.match(tests, /spec\/vectors\/identity\.json/);
});

test('phase 5: docs', () => {
  assert.ok(exists('docs', 'contracts.md'));
  assert.match(read('docs', 'contracts.md'), /data hash/i);
  assert.match(read('docs', 'contracts.md'), /cycles/i);
  assert.match(read('CHANGELOG.md'), /crt-node-lock/);
  assert.match(read('README.md'), /contracts\//);
  assert.ok(exists('DECISIONS.md'));
});
