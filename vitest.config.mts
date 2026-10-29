import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

const alias = { '@': new URL('./src', import.meta.url).pathname };

const shared = {
  restoreMocks: true,
  clearMocks: true,
  testTimeout: 10_000,
  // An empty suite is not a failure: `pnpm test` must stay green before the
  // first real test lands, and for projects without matching tests.
  passWithNoTests: true,
};

export default defineConfig({
  test: {
    ...shared,
    projects: [
      {
        resolve: { alias },
        test: {
          ...shared,
          name: 'unit-node',
          environment: 'node',
          include: ['src/lib/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.test.tsx', 'src/lib/hooks/**'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          ...shared,
          name: 'unit-dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', 'src/lib/hooks/**/*.test.ts'],
          setupFiles: ['./src/test/setup-dom.ts'],
        },
      },
    ],
  },
});
