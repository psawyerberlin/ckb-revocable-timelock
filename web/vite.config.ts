import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const clientDir = fileURLToPath(new URL('../client/', import.meta.url));
const webEntry = fileURLToPath(new URL('./src/main.ts', import.meta.url));

/** `../client` has no node_modules of its own here: resolve its bare imports from the web project. */
function resolveClientDeps(): Plugin {
  return {
    name: 'crt-client-deps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(clientDir)) return null;
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('node:')) return null;
      return this.resolve(source, webEntry, { ...options, skipSelf: true });
    },
  };
}

/**
 * CCC's bundle carries hosts the app never contacts: the second public RPC mirror (`*.ckbapp.dev`), documentation
 * links in error messages and the COTA aggregator. The built app must contain no external host except the configured
 * RPC and wallet ones, so these strings are rewritten (SPEC-less hardening, see DECISIONS.md, spec 04 phase 4).
 */
function stripUnusedHosts(): Plugin {
  const rules: [RegExp, string][] = [
    [/,?"https:\/\/(?:main|test)net\.ckbapp\.dev\/"/g, ''],
    [/https:\/\/api\.ckbccc\.com\//g, 'https://github.com/ckb-devrel/ccc/'],
    [/https:\/\/cota\.nervina\.dev\/(?:mainnet-)?aggregator/g, 'https://crt.chainsolution.net/app/unused'],
    [/nervosnetwork\\+\.github\\+\.io\//g, 'github.com/nervosnetwork/'],
  ];
  return {
    name: 'crt-strip-unused-hosts',
    enforce: 'post',
    generateBundle(_o, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type !== 'chunk') continue;
        for (const [re, to] of rules) f.code = f.code.replace(re, to);
      }
    },
  };
}

export default defineConfig({
  base: '/app/',
  plugins: [resolveClientDeps(), stripUnusedHosts()],
  resolve: { alias: { '@crt/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { fs: { allow: ['..'] } },
});
