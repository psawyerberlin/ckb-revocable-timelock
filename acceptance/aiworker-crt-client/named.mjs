// Runs `npm test` in client/ and checks that the fixed test names appear as passed (cwd = repository root).
import { spawnSync } from 'node:child_process';

const names = ['identity_vectors', 'descriptor_hash_vector', 'shamir_combine_vectors', 'shamir_roundtrip', 'envelope_roundtrip',
  'envelope_tamper_fails', 'tree_xor_threshold_roundtrip', 'headroom_separate', 'nodecell_roundtrip', 'verify_hard_fail_no_override',
  'build_cancel_has_no_typeid_output', 'build_create_layout', 'kit_deterministic', 'kit_self_contained', 'kit_under_400kb',
  'recover_offline_roundtrip', 'csr_job_vendor_hash'];

const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: 'client', stdio: 'inherit' });
if (install.status !== 0) { console.log('npm ci failed'); process.exit(1); }
const r = spawnSync('npm', ['test', '--silent'], { cwd: 'client', encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
const out = (r.stdout || '') + (r.stderr || '');
let failed = r.status === 0 ? 0 : 1;
if (r.status !== 0) console.log(out.split('\n').slice(-40).join('\n'));
for (const n of names) {
  // node:test prints "ok N - name" / vitest prints "✓ name"; a failed test prints "not ok" / "✗ name" or "×"
  const passed = new RegExp(`(ok \\d+ - |✓ |√ |PASS[^\\n]*)${n}\\b`).test(out) && !new RegExp(`(not ok \\d+ - |✗ |× |FAIL[^\\n]*)${n}\\b`).test(out);
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${n}`);
  if (!passed) failed++;
}
process.exit(failed ? 1 : 0);
