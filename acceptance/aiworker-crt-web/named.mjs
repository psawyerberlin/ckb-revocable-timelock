// Builds and tests web/ (cwd = repository root).
import { spawnSync } from 'node:child_process';
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } }).status === 0;
let ok = sh('npm', ['ci', '--no-audit', '--no-fund'], 'web');
ok = ok && sh('npm', ['run', 'build'], 'web');
ok = ok && sh('npm', ['test', '--silent'], 'web');
console.log(ok ? 'web: build and tests passed' : 'web: FAILED');
process.exit(ok ? 0 : 1);
