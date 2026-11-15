import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config.ts';

export default mergeConfig(base, defineConfig({
  test: { environment: 'jsdom', include: ['test/**/*.test.ts'], restoreMocks: true },
}));
