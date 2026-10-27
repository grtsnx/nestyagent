import { defineConfig } from 'prisma/config';

// DATABASE_URL comes from .env in Bun scripts, and from the host's settings in the container.
// generate does not need it.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
