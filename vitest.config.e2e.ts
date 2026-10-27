import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    // The same settings on every machine. Bun loads .env first, so real values are blanked here.
    env: {
      OPENAI_API_KEY: 'sk-e2e-test',
      DATABASE_URL: '',
      OPENAI_WEBHOOK_SECRET: '',
      LANGFUSE_PUBLIC_KEY: '',
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_BASE_URL: '',
      TRACE_PAYLOADS: '',
    },
  },
});
