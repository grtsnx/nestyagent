import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// The Prisma CLI runs on Node, which does not read .env by itself. Values already set win.
// In the container there is no .env, so DATABASE_URL comes from the host's settings.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
