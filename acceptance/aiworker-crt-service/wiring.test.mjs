// Acceptance for aiworker/02-crt-service.md. Run from the repository root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const srcOf = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.rs')).map((f) => read(dir, f)).join('\n');

test('phase 1: workspace and host bindings', () => {
  assert.ok(exists('service', 'Cargo.toml'));
  assert.match(read('service', 'Cargo.toml'), /"crt-host"/);
  assert.match(read('service', 'Cargo.toml'), /"crt-service"/);
  const h = srcOf('service/crt-host/src');
  for (const [name, no] of [['job_payload', 7001], ['block_info', 7002], ['chain_read', 7003], ['cells_query', 7004],
    ['kv_get', 7010], ['kv_put', 7011], ['kv_delete', 7012], ['kv_mark_secret', 7013], ['delete_on_consume', 7014],
    ['random_bytes', 7050], ['tx_skeleton_put', 7030], ['result_put', 7031]]) {
    assert.match(h, new RegExp(`${no}`), `syscall number ${no} (${name}) missing`);
    assert.match(h, new RegExp(`fn ${name}\\(`), `wrapper ${name} missing`);
  }
  assert.match(h, /trait Host/);
  assert.match(h, /MockHost/);
  assert.doesNotMatch(read('service', 'Cargo.toml') + read('service', 'crt-host', 'Cargo.toml'), /\.\.\/ckb-service-runner/, 'no path dependency on the CSR checkout');
});

test('phase 2: state machine covers every branch of SPEC.md section 5.3', () => {
  const m = srcOf('service/crt-service/src');
  for (const s of ['hold', 'keygen', 'recommit', 'release', 'done', 'cancelled', 'dropped', 'key_lost', 'bad_args', 'bad_payload']) {
    assert.match(m, new RegExp(s, 'i'), `status ${s} missing`);
  }
  assert.match(m, /random_bytes/);
  assert.match(m, /kv_mark_secret/);
  assert.match(m, /delete_on_consume/);
  assert.match(m, /GRACE_SECONDS/);
  assert.match(m, /b"CRT1"|\[0x43,\s*0x52,\s*0x54,\s*0x01\]|"CRT1"/);
  // never a wall clock
  assert.doesNotMatch(m, /SystemTime|Instant::now|std::time/);
  const main = read('service', 'crt-service', 'src', 'main.rs');
  assert.match(main, /entry!/);
  for (const n of ['hold_before_deadline', 'keygen_stores_key_and_commits', 'keygen_sets_delete_on_consume_on_alive_cell', 'keygen_marks_secret',
    'recommit_reuses_stored_key', 'recommit_never_regenerates', 'release_at_deadline_plus_grace', 'release_not_one_second_early',
    'release_skeleton_has_alive_dep_and_since', 'done_deletes_key', 'cancelled_deletes_key_and_empty_skeleton', 'dropped_deletes_key',
    'key_lost_reports_without_skeleton', 'bad_payload_reports', 'bad_args_reports', 'result_format_is_crt1_status_t',
    'skeleton_capacity_unchanged', 'skeleton_molecule_decodes']) {
    assert.match(m, new RegExp(`fn ${n}\\(`), `missing test ${n}`);
  }
});

test('phase 3: build script, manifest template, enable/disable scripts', () => {
  assert.ok(exists('scripts', 'build-service.sh'));
  assert.match(read('scripts', 'build-service.sh'), /riscv64imac-unknown-none-elf/);
  assert.ok(exists('service', 'manifests', 'crt-local.toml.in'));
  assert.match(read('service', 'manifests', 'crt-local.toml.in'), /@R@/);
  const en = read('scripts', 'crt-enable.sh');
  assert.match(en, /set -euo pipefail/);
  assert.match(en, /add-onchain/); // on-chain manifest per runner (devnet run, 2026-11); add-local only registers the bare code hash
  assert.match(en, /approve/);
  assert.match(en, /enable/);
  assert.match(en, /--dry-run/);
  assert.match(en, /--network/);
  assert.match(en, /CSR-SERVICE-v1|service ID|service_id/i);
  assert.match(en, /manifest_outpoint/);
  const dis = read('scripts', 'crt-disable.sh');
  assert.match(dis, /disable/);
  assert.match(dis, /revoke/);
});

test('phase 4: devnet smoke script present (not run here)', () => {
  const s = read('scripts', 'devnet-service-smoke.sh');
  assert.match(s, /set -euo pipefail/);
  assert.match(s, /deletions\.log/);
  assert.match(s, /PASS|FAIL/);
});

test('phase 5: docs', () => {
  assert.match(read('docs', 'operators.md'), /crt-enable\.sh/);
  assert.match(read('docs', 'operators.md'), /service ID/i);
  assert.ok(exists('docs', 'service.md'));
  assert.match(read('docs', 'service.md'), /CRT1/);
  assert.match(read('CHANGELOG.md'), /crt-service/);
});
