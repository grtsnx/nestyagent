import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    include: ['test/integration/**/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
