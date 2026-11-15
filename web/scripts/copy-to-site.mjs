// Copies web/dist/ into ../site/app/ so that site/ is the single static deploy root.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const target = fileURLToPath(new URL('../../site/app/', import.meta.url));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
console.log('copied web/dist -> site/app');
