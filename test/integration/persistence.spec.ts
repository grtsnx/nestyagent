import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { DatabaseSession, OpenaiService } from '@/lib/openai/openai.service.js';
import {
  Agent,
  Model,
  ModelResponse,
  setTracingDisabled,
  tool,
  Usage,
} from '@openai/agents';
import { z } from 'zod';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );

describe('Postgres persistence', () => {
  setTracingDisabled(true);
  const first = new PrismaService(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  );
  const second = new PrismaService(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  );
  const chats: string[] = [];
  beforeAll(async () => {
    await first.health();
  });
  const chat = () => {
    const id = randomUUID();
    chats.push(id);
    return id;
  };

  afterAll(async () => {
    try {
      await first.db.chat.deleteMany({ where: { id: { in: chats } } });
    } finally {
      await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()]);
    }
  });

  it('excludes another worker until the owner releases the conversation', async () => {
    expect(first.withLock).toBeTypeOf('function');
    const key = `test:${randomUUID()}`;
    let release!: () => void;
    let acquired!: () => void;
    const entered = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = first.withLock(key, async () => {
      acquired();
      await gate;
    });
    try {
      await Promise.race([entered, running]);
      await expect(second.withLock(key, async () => {})).rejects.toThrow(
        /already running/,
      );
    } finally {
      release();
      await running;
    }
    await expect(second.withLock(key, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it('atomically deduplicates repeated history transactions across workers', async () => {
    const id = chat();
    const a = new DatabaseSession(first, id);
    const b = new DatabaseSession(second, id);
    const operation = {
      operationId: 'op-1',
      transaction: {
        type: 'append_items' as const,
        items: [{ role: 'user' as const, content: 'hello' }],
      },
    };
    await Promise.all([
      a.applyHistoryTransaction(operation),
      b.applyHistoryTransaction(operation),
    ]);
    expect(await a.getItems()).toEqual(operation.transaction.items);
    await expect(
      b.applyHistoryTransaction({
        ...operation,
        transaction: {
          ...operation.transaction,
          items: [{ role: 'user', content: 'changed' }],
        },
      }),
    ).rejects.toThrow(/different/);
    expect(await a.getItems()).toEqual(operation.transaction.items);
  });

  it('acquires related locks on one connection without starving the pool', async () => {
    let release!: () => void;
    let entered!: () => void;
    let count = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const allEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const keys = Array.from({ length: 10 }, () => {
      const id = randomUUID();
      return [`run:${id}`, `chat:${id}`];
    });
    const tasks = keys.map((pair) =>
      first.withLock(pair, async () => {
        count += 1;
        if (count === 10) entered();
        await gate;
      }),
    );
    try {
      await Promise.race([allEntered, Promise.all(tasks)]);
      expect(count).toBe(10);
      await expect(second.withLock(keys[0][0], async () => {})).rejects.toThrow(
        /already running/,
      );
    } finally {
      release();
      await Promise.allSettled(tasks);
    }
  });

  it('aborts an owner whose database connection dies and releases its lock', async () => {
    const key = `test:${randomUUID()}`;
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = first.withLock(key, async (signal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    const rejected = expect(running).rejects.toThrow(/lock was lost/);
    await acquired;
    await second.db
      .$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND state = 'idle' AND query LIKE 'SELECT pg_try_advisory_lock%'`;
    await rejected;
    await expect(second.withLock(key, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it('rolls back a suffix rewrite when the expected history changed', async () => {
    const session = new DatabaseSession(first, chat());
    await session.addItems([{ role: 'user', content: 'original' }]);
    await expect(
      session.applyHistoryTransaction({
        operationId: 'rewrite',
        transaction: {
          type: 'replace_suffix',
          expectedSuffix: [{ role: 'user', content: 'stale' }],
          replacement: [],
        },
      }),
    ).rejects.toThrow(/changed/);
    expect(await session.getItems()).toEqual([
      { role: 'user', content: 'original' },
    ]);
  });

  it('resumes a real SDK approval on a new service and persists its tool result once', async () => {
    const id = chat();
    let executions = 0;
    let calls = 0;
    const model: Model = {
      async getResponse(): Promise<ModelResponse> {
        calls += 1;
        return {
          usage: new Usage(),
          output:
            calls === 1
              ? [
                  {
                    type: 'function_call',
                    callId: 'operation-1',
                    name: 'confirm_order',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      { type: 'output_text', text: 'Order confirmed.' },
                    ],
                  },
                ],
        };
      },
      getStreamedResponse() {
        throw new Error('Streaming is not used by this fixture.');
      },
    };
    const agent = new Agent({
      name: 'Order helper',
      model,
      tools: [
        tool({
          name: 'confirm_order',
          description: 'Confirm an order.',
          parameters: z.object({}),
          needsApproval: true,
          execute: async () => {
            executions += 1;
            return 'confirmed';
          },
        }),
      ],
    });
    const original = new OpenaiService(new ConfigService(), first);
    const restarted = new OpenaiService(new ConfigService(), second);
    const turn = await original.reply('Confirm my order.', agent, {
      session: original.createSession(id),
      ownerId: 'test-owner',
      agentVersion: 'v1',
      maxTurns: 4,
    });
    expect(turn.waiting).toBe(true);
    expect(executions).toBe(0);
    const savedId = await original.saveRun(turn.result);
    try {
      await expect(
        restarted.loadRun(agent, savedId, {
          ownerId: 'another-owner',
          agentVersion: 'v1',
        }),
      ).rejects.toThrow();
      await expect(
        restarted.runAgent('new message', agent, {
          session: restarted.createSession(id),
        }),
      ).rejects.toThrow(/pending approval/);
      const state = await restarted.loadRun(agent, savedId, {
        ownerId: 'test-owner',
        agentVersion: 'v1',
      });
      restarted.approve({ state });
      const result = await restarted.resumeAgent(agent, state);
      expect(result.finalOutput).toBe('Order confirmed.');
      expect(executions).toBe(1);
      const history = await restarted.createSession(id).getItems();
      expect(
        history.filter((item) => item.type === 'function_call_result'),
      ).toHaveLength(1);
      expect(JSON.stringify(history)).toContain('Order confirmed.');
      await expect(
        restarted.loadRun(agent, savedId, {
          ownerId: 'test-owner',
          agentVersion: 'v1',
        }),
      ).rejects.toThrow();
    } finally {
      await first.db.pausedRun.deleteMany({ where: { id: savedId } });
    }
  });
});
