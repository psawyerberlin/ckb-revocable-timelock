import { defineConfig } from 'vite';

export default defineConfig({
  base: '/app/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { fs: { allow: ['..'] } },
});
