import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { ComposioService } from '@/lib/composio/composio.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';

const create = vi.hoisted(() => vi.fn());
const use = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
vi.mock('@composio/core', () => ({
  Composio: vi.fn(function () {
    return { create, use, sessions: { delete: remove } };
  }),
}));
vi.mock('@composio/openai-agents', () => ({
  OpenAIAgentsProvider: vi.fn(),
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );

describe('Composio sessions in Postgres', () => {
  const env = {
    NODE_ENV: 'development',
    COMPOSIO_ENABLED: true,
    COMPOSIO_API_KEY: 'ak_test',
    DATABASE_URL: databaseUrl,
  };
  const prisma = new PrismaService(new ConfigService(env));
  afterAll(() => prisma.onModuleDestroy());

  it('keeps one session per user when five first messages race', async () => {
    const userId = `user-${randomUUID()}`;
    let made = 0;
    create.mockImplementation(async () => ({
      sessionId: `sess-${(made += 1)}-${userId}`,
      tools: async () => [],
    }));
    use.mockImplementation(async (sessionId: string) => ({
      sessionId,
      tools: async () => [],
    }));
    remove.mockResolvedValue({});
    const servers = Array.from(
      { length: 5 },
      () => new ComposioService(new ConfigService(env), prisma),
    );
    try {
      await Promise.all(servers.map((server) => server.tools(userId)));
      const rows = await prisma.db.composioSession.findMany({
        where: { userId },
      });
      expect(rows).toHaveLength(1);
      expect(remove).toHaveBeenCalledTimes(made - 1);
    } finally {
      await prisma.db.composioSession.deleteMany({ where: { userId } });
    }
  });
});
