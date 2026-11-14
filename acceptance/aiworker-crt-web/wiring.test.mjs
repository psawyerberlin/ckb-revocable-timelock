// Acceptance for aiworker/04-crt-web.md. Run from the repository root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? (['node_modules', 'dist', '.git'].includes(e.name) ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));

test('vite project with /app/ base, no UI framework, no analytics', () => {
  const pkg = JSON.parse(read('web', 'package.json'));
  const deps = Object.keys({ ...pkg.dependencies });
  for (const d of deps) assert.ok(!/react|vue|svelte|angular|analytics|gtag|sentry/i.test(d), `unexpected dependency ${d}`);
  const cfg = walk('web').filter((f) => /vite\.config\.(ts|js|mts|mjs)$/.test(f)).map((f) => read(f)).join('\n');
  assert.match(cfg, /base:\s*['"]\/app\/['"]/);
  assert.match(pkg.scripts.build, /site\/app|copy/);
});

test('screens exist and cancel is a first-class action', () => {
  const src = walk('web/src').filter((f) => /\.(ts|html)$/.test(f)).map((f) => read(f)).join('\n');
  for (const s of [/deadline/i, /runner/i, /quote/i, /arm/i, /kit/i, /recover/i, /renew/i, /rewrap/i, /cancel/i, /reclaim/i, /headroom/i]) assert.match(src, s);
  assert.match(src, /I understand/);
  assert.match(src, /quantum/i);
  assert.match(src, /testnet until/i);
  assert.match(src, /@crt\/client|\.\.\/client/);
});

test('site links to the app and the built app is static', () => {
  assert.match(read('site', 'index.html'), /href="\/app\/"/);
  assert.ok(exists('site', 'app', 'index.html'), 'web build copied into site/app/');
  const built = walk('site/app').filter((f) => /\.(js|html|css)$/.test(f)).map((f) => read(f)).join('\n');
  const external = [...built.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0].toLowerCase());
  const allowed = /ckb\.dev|chainsolution\.net|joy\.id|joyid\.dev|w3\.org|localhost|127\.0\.0\.1|nervos\.org|github\.com/;
  for (const u of new Set(external)) assert.match(u, allowed, `external reference ${u} in the built app`);
});

test('docs', () => {
  assert.ok(exists('docs', 'web.md'));
  assert.match(read('CHANGELOG.md'), /web/i);
});
