// Runs the named service tests of aiworker/02-crt-service.md (cwd = repository root).
import { spawnSync } from 'node:child_process';

const names = ['hold_before_deadline', 'keygen_stores_key_and_commits', 'keygen_sets_delete_on_consume_on_alive_cell', 'keygen_marks_secret',
  'recommit_reuses_stored_key', 'recommit_never_regenerates', 'release_at_deadline_plus_grace', 'release_not_one_second_early',
  'release_skeleton_has_alive_dep_and_since', 'done_deletes_key', 'cancelled_deletes_key_and_empty_skeleton', 'dropped_deletes_key',
  'key_lost_reports_without_skeleton', 'bad_payload_reports', 'bad_args_reports', 'result_format_is_crt1_status_t',
  'skeleton_capacity_unchanged', 'skeleton_molecule_decodes'];

let failed = 0;
for (const n of names) {
  const r = spawnSync('cargo', ['test', '--manifest-path', 'service/Cargo.toml', '-p', 'crt-service', '--features', 'mock', '--', n], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0 && [...out.matchAll(/test result: ok\. (\d+) passed/g)].some((m) => Number(m[1]) >= 1);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}`);
  if (!ok) { failed++; console.log(out.split('\n').slice(-30).join('\n')); }
}
process.exit(failed ? 1 : 0);
