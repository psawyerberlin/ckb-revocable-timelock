// Runs the named Rust tests of spec 00 in the ckb-service-runner checkout (cwd = its root).
// A name is a cargo test filter: at least one test must run and all that run must pass.
import { spawnSync } from 'node:child_process';

const names = [
  'random_bytes_fills_len',
  'random_bytes_len_zero_is_12',
  'random_bytes_len_over_1024_is_11',
  'random_bytes_local_mode_works',
  'random_bytes_never_in_debug',
  'randtest_two_draws_differ',
];
let failed = 0;
for (const n of names) {
  const r = spawnSync('cargo', ['test', '-p', 'csr', '--', n], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = [...out.matchAll(/test result: ok\. (\d+) passed/g)];
  const ran = r.status === 0 && m.some((x) => Number(x[1]) >= 1);
  console.log(`${ran ? 'ok  ' : 'FAIL'} ${n}`);
  if (!ran) { failed++; console.log(out.split('\n').slice(-25).join('\n')); }
}
process.exit(failed ? 1 : 0);
