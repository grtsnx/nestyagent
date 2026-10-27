import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MonitoringService } from '@/modules/admin/monitoring.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );

// Starts from empty monitoring tables, so the counts are exact.
describe('Monitoring in Postgres', () => {
  const config = new ConfigService({ DATABASE_URL: databaseUrl });
  const prisma = new PrismaService(config);
  const monitoring = new MonitoringService(prisma, config);
  const chatId = `chat-${randomUUID()}`;

  beforeAll(async () => {
    const db = prisma.db;
    await db.agentRun.deleteMany();
    await db.pausedRun.deleteMany();
    await db.hostedWebhook.deleteMany();
    await db.remoteMachine.deleteMany();
    await db.chat.create({ data: { id: chatId } });
    await db.chatItem.createMany({
      data: [
        { chatId, item: { role: 'user', content: 'Secret family detail.' } },
        { chatId, item: { role: 'assistant', content: 'Thanks.' } },
      ],
    });
    await db.agentRun.createMany({
      data: [
        {
          chatId,
          agent: 'MsSuzie',
          model: 'gpt-6-astra',
          status: 'completed',
          inputTokens: 1000,
          outputTokens: 100,
          cachedTokens: 750,
          durationMs: 2000,
        },
        {
          chatId,
          agent: 'MsSuzie',
          model: 'gpt-6-astra',
          status: 'failed',
          error: 'Error: Model unavailable.',
          inputTokens: 1000,
          outputTokens: 0,
          cachedTokens: 250,
          durationMs: 4000,
        },
      ],
    });
    await db.pausedRun.create({
      data: { state: '{"secret":"run state"}', chatId, agentName: 'MsSuzie' },
    });
    await db.remoteMachine.create({
      data: {
        sessionId: `sess-${randomUUID()}`,
        environmentId: `env-${randomUUID()}`,
        claimToken: randomUUID(),
        status: 'reconciliation',
      },
    });
    await db.hostedWebhook.create({
      data: {
        id: `evt-${randomUUID()}`,
        type: 'agent.session.failed',
        resourceId: 'sess_1',
        attempts: 3,
        lastError: 'processing_failed',
      },
    });
  });

  afterAll(async () => {
    await prisma.db.chat.deleteMany({ where: { id: chatId } });
    await prisma.db.agentRun.deleteMany();
    await prisma.db.pausedRun.deleteMany();
    await prisma.db.hostedWebhook.deleteMany();
    await prisma.db.remoteMachine.deleteMany();
    await prisma.onModuleDestroy();
  });

  it('counts what needs a person and the last 24 hours', async () => {
    const overview = await monitoring.overview();
    expect(overview.needsAttention).toEqual({
      approvalsWaiting: 1,
      runsNeedingRecovery: 0,
      webhooksRetrying: 1,
      webhooksNeedingCheck: 0,
      machinesNeedingCheck: 1,
    });
    expect(overview.last24Hours).toMatchObject({
      runs: 2,
      failed: 1,
      inputTokens: 2000,
      cachedTokens: 1000,
      cacheHitRate: 0.5,
      averageMs: 3000,
    });
  });

  it('adds up usage per day and per model', async () => {
    const usage = await monitoring.usage(7);
    expect(usage.daily).toHaveLength(1);
    expect(usage.models).toMatchObject([
      { model: 'gpt-6-astra', runs: 2, failed: 1, outputTokens: 100 },
    ]);
  });

  it('lists runs, chats, and paused runs without message text or secrets', async () => {
    const [runs, chats, approvals, machines] = await Promise.all([
      monitoring.runs({ status: 'failed' }),
      monitoring.chats({}),
      monitoring.approvals({}),
      monitoring.machines({}),
    ]);
    expect(runs).toMatchObject([{ status: 'failed', chatId }]);
    expect(chats.find((chat) => chat.id === chatId)).toMatchObject({
      messages: 2,
      runs: 2,
    });
    expect(approvals[0]).toMatchObject({ chatId, status: 'waiting' });
    expect(approvals[0]).not.toHaveProperty('state');
    expect(machines[0]).not.toHaveProperty('claimToken');
    const everything = JSON.stringify({ runs, chats, approvals, machines });
    expect(everything).not.toContain('Secret family detail');
    expect(everything).not.toContain('run state');
  });
});
