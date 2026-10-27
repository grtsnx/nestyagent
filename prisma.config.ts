import { defineConfig } from 'prisma/config';

// Bun scripts load .env, so DATABASE_URL is set for migrate. generate does not need it.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
