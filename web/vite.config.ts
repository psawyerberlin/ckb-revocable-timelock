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

export default defineConfig({
  base: '/app/',
  plugins: [resolveClientDeps()],
  resolve: { alias: { '@crt/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { fs: { allow: ['..'] } },
});
