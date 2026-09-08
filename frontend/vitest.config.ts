import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/**
 * Kept separate from `vite.config.ts` so the build config stays free of test
 * concerns; the alias and plugin setup are inherited rather than duplicated.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      // Explicit imports from 'vitest' instead of ambient globals: one less
      // thing to configure in tsconfig, and the imports document themselves.
      globals: false,
      restoreMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }),
);
