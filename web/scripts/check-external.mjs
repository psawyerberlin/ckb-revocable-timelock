// Fails when the built app (web/dist) references an http(s) host that is not configured.
// Allowed: the RPC/monitor/wallet hosts the app talks to, and namespace/documentation URLs that are never fetched.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = process.argv[2] ?? fileURLToPath(new URL('../dist/', import.meta.url));
const allowed = /ckb\.dev|chainsolution\.net|joy\.id|joyid\.dev|cota\.nervina\.dev|w3\.org|localhost|127\.0\.0\.1|nervos\.org|github\.com/;
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const bad = new Set();
for (const f of walk(dir).filter((f) => /\.(js|html|css)$/.test(f))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/https?:\/\/[a-z0-9.-]+/gi)) if (!allowed.test(m[0].toLowerCase())) bad.add(`${m[0]} (${path.relative(dir, f)})`);
}
if (bad.size) { console.error(`external references in ${dir}:\n  ${[...bad].join('\n  ')}`); process.exit(1); }
console.log('no external references in', dir);
