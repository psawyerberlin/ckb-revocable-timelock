// After `tsc -p tsconfig.build.json`: copy the vendored CSR job library next to the compiled sources (tsc does not emit
// .mjs inputs), then import the built entry once so a broken dist fails the build instead of its consumers.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist', 'vendor'), { recursive: true });
for (const f of readdirSync(join(root, 'vendor')).filter((f) => /\.(mjs|d\.mts)$/.test(f))) {
  cpSync(join(root, 'vendor', f), join(root, 'dist', 'vendor', f));
}
const m = await import(pathToFileURL(join(root, 'dist', 'src', 'index.js')).href);
for (const name of ['generateKit', 'fetchRunners', 'selectRunners', 'buildCreate', 'recoverOnline', 'estimateCost']) {
  if (typeof m[name] !== 'function') throw new Error(`dist entry lacks ${name}`);
}
console.log(`dist ok: ${Object.keys(m).length} exports`);
