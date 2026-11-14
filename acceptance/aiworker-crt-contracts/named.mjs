// Runs the named Rust tests of aiworker/01-crt-contracts.md (cwd = repository root).
import { spawnSync } from 'node:child_process';

const run = (pkg, name) => {
  const r = spawnSync('cargo', ['test', '--manifest-path', 'contracts/Cargo.toml', '-p', pkg, '--', name], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0 && [...out.matchAll(/test result: ok\. (\d+) passed/g)].some((m) => Number(m[1]) >= 1);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pkg}::${name}`);
  if (!ok) console.log(out.split('\n').slice(-30).join('\n'));
  return ok;
};

const core = ['identity_vectors', 'node_cell_roundtrip', 'since_encoding', 'pubkey_of_one_is_generator', 'rejects_zero_and_n'];
const lock = ['owner_can_update_deadline', 'owner_can_write_descriptor_hash', 'owner_can_destroy', 'node_commit_ok',
  'node_commit_without_runner_input_rejected', 'node_commit_two_outputs_rejected', 'node_commit_zero_pubkey_rejected',
  'node_commit_with_privkey_rejected', 'node_commit_changing_deadline_rejected', 'node_commit_lower_capacity_rejected',
  'node_release_ok', 'node_release_wrong_privkey_rejected', 'node_release_early_since_rejected', 'node_release_block_since_rejected',
  'node_release_relative_timestamp_rejected', 'node_release_without_alive_dep_rejected', 'node_release_alive_dep_wrong_args_rejected',
  'node_release_changes_pubkey_rejected', 'node_release_from_state0_rejected', 'node_state2_to_anything_rejected',
  'bad_args_length_rejected', 'bad_data_length_rejected', 'cycles_release_under_budget', 'vectors_identity_matches'];

let failed = 0;
for (const n of core) if (!run('crt-core', n)) failed++;
for (const n of lock) if (!run('crt-contract-tests', n)) failed++;
console.log(failed ? `${failed} FAILED` : 'all named tests passed');
process.exit(failed ? 1 : 0);
