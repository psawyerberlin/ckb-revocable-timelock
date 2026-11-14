// Acceptance for aiworker/05-crt-devnet-e2e.md. Run from the repository root. No devnet is started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

test('devnet scripts', () => {
  const e2e = read('scripts', 'devnet-e2e.sh');
  assert.match(e2e, /set -euo pipefail/);
  assert.match(e2e, /--down/);
  assert.match(e2e, /crt-enable\.sh/);
  assert.match(e2e, /deployments\/devnet\.json/);
  assert.match(e2e, /\.devnet/);
  const sc = read('scripts', 'devnet-scenario.mjs');
  for (const s of [/cancel/i, /rewrap/i, /renew/i, /deletions\.log/, /VerificationError/, /cycles/i]) assert.match(sc, s);
});

test('testnet deployment is scripted, the single manual step is documented', () => {
  const d = read('scripts', 'deploy-testnet.sh');
  assert.match(d, /--dry-run/);
  assert.match(d, /deployments\/testnet\.json/);
  assert.ok(exists('deployments', 'README.md'));
  assert.ok(exists('deployments', 'testnet-runners.json'));
  const ms = read('docs', 'manual-steps.md');
  assert.match(ms, /deploy-testnet\.sh/);
  assert.match(ms, /CKB/);
  assert.ok(ms.split('\n').filter((l) => /^\s*(\d+\.|-)\s/.test(l)).length <= 12, 'manual steps must stay short');
});

test('results recorded', () => {
  assert.match(read('DECISIONS.md'), /devnet/i);
  assert.match(read('docs', 'testing.md'), /devnet-e2e\.sh/);
  assert.match(read('.gitignore'), /\.devnet/);
});
