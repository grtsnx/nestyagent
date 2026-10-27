import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { DatabaseSession, OpenaiService } from '@/lib/openai/openai.service.js';
import { SystemPromptsService } from '@/modules/system-prompts/system-prompts.service.js';
import { defaultSystemPrompts } from '@/config/system-prompts/index.js';
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

  it('runs fifty chats at once, because a lock holds no connection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    const keys = Array.from({ length: 50 }, () => {
      const id = randomUUID();
      return [`run:${id}`, `chat:${id}`];
    });
    const tasks = keys.map((pair) =>
      first.withLock(pair, async () => {
        running += 1;
        await gate;
      }),
    );
    try {
      await expect.poll(() => running, { timeout: 10_000 }).toBe(50);
      await expect(second.withLock(keys[0][1], async () => {})).rejects.toThrow(
        /already running/,
      );
    } finally {
      release();
      await Promise.all(tasks);
    }
    const left = await first.db.executionLock.count({
      where: { key: { in: keys.flat() } },
    });
    expect(left).toBe(0);
  });

  it('aborts an owner that loses its lock', async () => {
    const key = `test:${randomUUID()}`;
    first.lockRenewMs = 100;
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
    try {
      const rejected = expect(running).rejects.toThrow(/lock was lost/);
      await acquired;
      // Another worker took the row, as if this owner had stalled past its expiry.
      await second.db.executionLock.update({
        where: { key },
        data: { owner: randomUUID() },
      });
      await rejected;
    } finally {
      first.lockRenewMs = 15_000;
    }
  });

  it('frees the lock of an owner that crashed once it expires', async () => {
    const key = `test:${randomUUID()}`;
    await first.db.executionLock.create({
      data: {
        key,
        owner: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(second.withLock(key, async () => {})).rejects.toThrow(
      /already running/,
    );
    await first.db.executionLock.update({
      where: { key },
      // Well in the past, so a small clock gap between this machine and Postgres does not matter.
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(second.withLock(key, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it('fences a stale SDK run before it saves history after another worker takes over', async () => {
    const id = chat();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const model: Model = {
      async getResponse() {
        const call = ++calls;
        if (call === 1) {
          entered();
          await gate;
        }
        return {
          usage: new Usage(),
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: `answer-${call}` }],
            },
          ],
        };
      },
      getStreamedResponse() {
        throw new Error('Unused stream');
      },
    };
    const a = new OpenaiService(new ConfigService(), first);
    const b = new OpenaiService(new ConfigService(), second);
    const agent = new Agent({ name: 'Fence helper', model });
    const stale = a.runAgent('First question.', agent, {
      session: a.createSession(id),
    });
    // Observe rejection before releasing the deliberately delayed worker.
    const outcome = stale.then(
      () => 'succeeded',
      () => 'rejected',
    );
    try {
      await started;
      await second.db.executionLock.update({
        where: { key: `chat:${id}` },
        data: { expiresAt: new Date(0) },
      });
      await b.runAgent('Second question.', agent, {
        session: b.createSession(id),
      });
      release();
      expect(await outcome).toBe('rejected');
      const history = JSON.stringify(await b.createSession(id).getItems());
      expect(history).toContain('Second question.');
      expect(history).not.toContain('First question.');
    } finally {
      release();
      await outcome;
      await Promise.all([a.onModuleDestroy(), b.onModuleDestroy()]);
    }
  });

  it('sends a current turn longer than maxItems whole', async () => {
    const session = new DatabaseSession(first, chat(), { maxItems: 3 });
    const steps = Array.from({ length: 4 }, (_, index) => ({
      type: 'function_call_result' as const,
      callId: `c${index}`,
      name: 'bake',
      status: 'completed' as const,
      output: { type: 'text' as const, text: 'ok' },
    }));
    await session.addItems([
      { role: 'user', content: 'old' },
      { role: 'user', content: 'Bake 4 cakes.' },
      ...steps,
    ]);
    expect(await session.getItems()).toEqual([
      { role: 'user', content: 'Bake 4 cakes.' },
      ...steps,
    ]);
  });

  it('lets only one of two editors save from the same version', async () => {
    const config = new ConfigService({ DATABASE_URL: databaseUrl });
    const a = new SystemPromptsService(first, config);
    const b = new SystemPromptsService(second, config);
    const name = `test-${randomUUID().slice(0, 8)}`;
    try {
      const initial = await a.create(name, 'Version one.');
      const saves = await Promise.allSettled([
        a.update(name, 'Editor A.', initial.version!),
        b.update(name, 'Editor B.', initial.version!),
      ]);
      expect(saves.filter((save) => save.status === 'fulfilled')).toHaveLength(
        1,
      );
      const winner = saves.find((save) => save.status === 'fulfilled');
      if (!winner || winner.status !== 'fulfilled')
        throw new Error('No winner');
      expect(winner.value.version).toBeGreaterThan(initial.version!);
      await expect(b.get(name)).resolves.toEqual(winner.value);
      await expect(
        a.remove(name, winner.value.version!),
      ).resolves.toBeUndefined();
    } finally {
      await first.db.systemPrompt.deleteMany({ where: { name } });
    }
  });

  it('falls back to the default after the custom version is deleted', async () => {
    const systemPrompts = new SystemPromptsService(
      first,
      new ConfigService({ DATABASE_URL: databaseUrl }),
    );
    await first.db.systemPrompt.deleteMany({ where: { name: 'agentic' } });
    const created = await systemPrompts.create('agentic', 'Custom.');
    await expect(
      systemPrompts.remove('agentic', created.version!),
    ).resolves.toMatchObject({
      source: 'default',
      content: defaultSystemPrompts.agentic,
    });
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
