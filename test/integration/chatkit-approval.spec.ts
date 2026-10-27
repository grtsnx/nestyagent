import { ConfigService } from '@nestjs/config';
import {
  Agent,
  OpenAIProvider,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { vi } from 'vitest';
import { z } from 'zod';
import { ChatKitStore, type ChatKitContext } from '@/config/chatkit/index.js';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { AgenticChatKitService } from '@/modules/chatkit/chatkit.service.js';
import { SystemPromptsService } from '@/modules/system-prompts/system-prompts.service.js';
import { AdminService } from '@/modules/admin/admin.service.js';
import { scriptedModel, type ScriptStep } from '../unit/chatkit-model.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );
setTracingDisabled(true);
const input = {
  content: [{ type: 'input_text', text: 'Perform the action.' }],
  attachments: [],
  inference_options: {},
};

describe('Durable ChatKit approvals in Postgres', () => {
  const config = new ConfigService({
    DATABASE_URL: databaseUrl,
    OPENAI_API_KEY: 'sk-test',
  });
  const prisma = new PrismaService(config);
  const userIds: string[] = [];
  const clients: OpenaiService[] = [];
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await prisma.db.chatkitFeedback.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.db.pausedRun.deleteMany({
      where: { ownerId: { in: userIds } },
    });
    await prisma.db.agentRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.db.chatkitThread.deleteMany({
      where: { userId: { in: userIds } },
    });
    await Promise.all(clients.map((client) => client.onModuleDestroy()));
    await prisma.onModuleDestroy();
  });

  it('migrates the latest legacy approval card with its checkpoint version', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `approval_${randomUUID().replaceAll('-', '')}`;
    const runId = randomUUID();
    const card = {
      type: 'widget',
      id: 'msg_old',
      thread_id: 'thr_old',
      widget: {
        confirm: { action: { payload: { runId } } },
        cancel: { action: { payload: { runId } } },
      },
    };
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`CREATE TABLE chatkit_threads(id text PRIMARY KEY, user_id text);
        CREATE TABLE paused_runs(id uuid PRIMARY KEY, version int, status text, owner_id text, run_options jsonb);
        CREATE TABLE chatkit_items(thread_id text, id text, seq bigint, data jsonb, PRIMARY KEY(thread_id,id));
        CREATE TABLE agent_runs(chat_id text, created_at timestamptz);`);
      await client.query(
        "INSERT INTO chatkit_threads VALUES ('thr_old','owner')",
      );
      await client.query(
        "INSERT INTO paused_runs VALUES ($1,2,'waiting','owner',$2)",
        [runId, { workflowName: 'chatkit-turn', groupId: 'thr_old' }],
      );
      await client.query(
        "INSERT INTO chatkit_items VALUES ('thr_old','msg_older',1,$1),('thr_old','msg_old',2,$2)",
        [{ ...card, id: 'msg_older' }, card],
      );
      await client.query(
        readFileSync(
          new URL(
            '../../prisma/migrations/20261028010000_chatkit_approval_binding/migration.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const { rows } = await client.query(
        'SELECT id, data FROM chatkit_items ORDER BY seq',
      );
      const expectedId = `msg_approval_${runId.replaceAll('-', '')}_2`;
      expect(rows[1]).toMatchObject({
        id: expectedId,
        data: {
          id: expectedId,
          widget: {
            confirm: { action: { payload: { runId, version: 2 } } },
            cancel: { action: { payload: { runId, version: 2 } } },
          },
        },
      });
      expect(rows[0].data.widget.confirm.action.payload).not.toHaveProperty(
        'version',
      );
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  async function fixture(
    steps: ScriptStep[] = [
      { call: { name: 'effect' } },
      { text: 'Completed.' },
    ],
  ) {
    const context: ChatKitContext = {
      userId: `approval-${randomUUID()}`,
      baseUrl: 'https://example.invalid',
    };
    userIds.push(context.userId);
    const store = new ChatKitStore(prisma);
    const openai = new OpenaiService(config, prisma);
    clients.push(openai);
    const effect = vi.fn(async () => 'Done.');
    const agent = new Agent({
      name: 'Agentic',
      tools: [
        tool({
          name: 'effect',
          description: 'Perform an action.',
          parameters: z.object({}),
          needsApproval: true,
          execute: effect,
        }),
      ],
    });
    const server = new AgenticChatKitService(
      store,
      undefined as never,
      openai,
      new SystemPromptsService(prisma, config),
      prisma,
      config,
    );
    vi.spyOn(server, 'agent').mockReturnValue(agent);
    const model = scriptedModel(steps);
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue(model);
    const send = async (body: unknown) => {
      const result = await server.process(JSON.stringify(body), context);
      if (!result.streaming) return [];
      const events: any[] = [];
      for await (const line of result.stream)
        events.push(JSON.parse(line.slice(6)));
      return events;
    };
    const create = async () => {
      const events = await send({ type: 'threads.create', params: { input } });
      const threadId = events[0].thread.id as string;
      const card = events.find(
        (event) =>
          event.type === 'thread.item.done' && event.item.type === 'widget',
      )?.item;
      return {
        events,
        threadId,
        card,
        payload: card?.widget.confirm.action.payload,
      };
    };
    return {
      context,
      store,
      openai,
      agent,
      model,
      effect,
      send,
      create,
      server,
    };
  }

  it('keeps the approval untouched when its declined card cannot be stored', async () => {
    const f = await fixture([
      { call: { name: 'effect' } },
      { text: 'Sure, what else?' },
    ]);
    const paused = await f.create();
    const before = await prisma.db.pausedRun.findFirstOrThrow({
      where: { ownerId: f.context.userId },
    });
    const save = f.store.saveItem.bind(f.store);
    const write = vi
      .spyOn(f.store, 'saveItem')
      .mockImplementation(async (id, item, context) => {
        if (item.type === 'widget') throw new Error('Card write failed.');
        return save(id, item, context);
      });
    const message = {
      type: 'threads.add_user_message',
      params: { thread_id: paused.threadId, input },
    };
    await expect(f.send(message)).rejects.toThrow('Card write failed.');
    // Checkpoint, card, and history are exactly as before: nothing half-done.
    expect(
      await prisma.db.pausedRun.findUniqueOrThrow({ where: { id: before.id } }),
    ).toMatchObject({ status: 'waiting', version: before.version });
    expect(
      JSON.stringify(
        await f.store.loadItem(paused.threadId, paused.card.id, f.context),
      ),
    ).not.toContain('Declined.');
    const users = async () =>
      (
        await f.store.loadThreadItems(
          paused.threadId,
          null,
          50,
          'asc',
          f.context,
        )
      ).data.filter((item) => item.type === 'user_message');
    expect(await users()).toHaveLength(1);

    // Once the store works again, the same message declines the card and is answered.
    write.mockRestore();
    const events = await f.send(message);
    const stored = await f.store.loadItem(
      paused.threadId,
      paused.card.id,
      f.context,
    );
    expect(JSON.stringify(stored)).toContain('Declined.');
    expect(events).toContainEqual({
      type: 'thread.item.replaced',
      item: stored,
    });
    expect(
      await prisma.db.pausedRun.findUniqueOrThrow({ where: { id: before.id } }),
    ).toMatchObject({ status: 'completed', recoveryNote: 'cancelled' });
    expect(await users()).toHaveLength(2);
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('moves retry receipts out of thread metadata without losing any', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `receipts_${randomUUID().replaceAll('-', '')}`;
    const receipt = { id: 'request-0', kind: 'retry', status: 'completed' };
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(
        'CREATE TABLE chatkit_threads(id text PRIMARY KEY, data jsonb)',
      );
      await client.query(
        "INSERT INTO chatkit_threads VALUES ('thr_old', $1), ('thr_plain', $2)",
        [
          {
            id: 'thr_old',
            metadata: {
              keep: true,
              _chatkit_retry_receipts: { 'request:request-0': receipt },
            },
          },
          { id: 'thr_plain', metadata: {} },
        ],
      );
      // The test owns the transaction, so it can roll the whole schema back.
      await client.query(
        readFileSync(
          new URL(
            '../../prisma/migrations/20261028020000_chatkit_operation_receipts/migration.sql',
            import.meta.url,
          ),
          'utf8',
        ).replace(/^(BEGIN|COMMIT);$/gm, ''),
      );
      const receipts = await client.query(
        'SELECT thread_id, request_key, data FROM chatkit_operation_receipts',
      );
      expect(receipts.rows).toEqual([
        {
          thread_id: 'thr_old',
          request_key: 'request:request-0',
          data: receipt,
        },
      ]);
      const threads = await client.query(
        "SELECT data FROM chatkit_threads WHERE id = 'thr_old'",
      );
      expect(threads.rows[0].data.metadata).toEqual({ keep: true });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('rolls back the initial checkpoint when its approval card cannot be stored', async () => {
    const f = await fixture();
    const add = f.store.addThreadItem.bind(f.store);
    vi.spyOn(f.store, 'addThreadItem').mockImplementation(
      async (id, item, context) => {
        if (item.type === 'widget') throw new Error('Card insert failed.');
        return add(id, item, context);
      },
    );
    const result = await f.create();
    expect(result.events.some((event) => event.type === 'error')).toBe(true);
    expect(
      await prisma.db.pausedRun.count({ where: { ownerId: f.context.userId } }),
    ).toBe(0);
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('deleting a thread invalidates its saved approval and any already loaded state', async () => {
    const f = await fixture();
    const paused = await f.create();
    const saved = await prisma.db.pausedRun.findUniqueOrThrow({
      where: { id: paused.payload.runId },
    });
    const state = await f.openai.loadRun(f.agent, paused.payload.runId, {
      ownerId: f.context.userId,
      agentVersion: saved.agentVersion,
      chatkitThreadId: paused.threadId,
      version: paused.payload.version,
    } as never);
    f.openai.approve({ state });
    await f.store.deleteThread(paused.threadId, f.context);
    expect(
      Boolean(
        await prisma.db.pausedRun.findUnique({
          where: { id: paused.payload.runId },
        }),
      ),
    ).toBe(false);
    await expect(f.openai.resumeAgent(f.agent, state)).rejects.toThrow();
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('rejects feedback for an item outside the owned thread', async () => {
    const f = await fixture();
    const paused = await f.create();
    const server = new AgenticChatKitService(
      f.store,
      undefined as never,
      f.openai,
      new SystemPromptsService(prisma, config),
      prisma,
      config,
    );
    await expect(
      server.addFeedback(
        paused.threadId,
        ['missing-item'],
        'positive',
        f.context,
      ),
    ).rejects.toThrow();
    expect(
      await prisma.db.chatkitFeedback.count({
        where: { userId: f.context.userId },
      }),
    ).toBe(0);
  });

  it('commits a recovered checkpoint and its replacement card together', async () => {
    const f = await fixture();
    const paused = await f.create();
    await prisma.db.pausedRun.update({
      where: { id: paused.payload.runId },
      data: { status: 'recovery_required' },
    });
    const add = f.store.addThreadItem.bind(f.store);
    vi.spyOn(f.store, 'addThreadItem').mockImplementationOnce(async () => {
      throw new Error('Recovery card insert failed.');
    });
    const recovery = {
      version: paused.payload.version,
      note: 'Verified that no external effect occurred.',
    };
    await expect(
      f.server.recoverApproval(
        paused.threadId,
        paused.payload.runId,
        recovery,
        f.context,
      ),
    ).rejects.toThrow(/Recovery card/);
    expect(
      await prisma.db.pausedRun.findUniqueOrThrow({
        where: { id: paused.payload.runId },
      }),
    ).toMatchObject({ status: 'recovery_required', version: recovery.version });
    vi.spyOn(f.store, 'addThreadItem').mockImplementation(add);
    const card = await f.server.recoverApproval(
      paused.threadId,
      paused.payload.runId,
      recovery,
      f.context,
    );
    const payload = (card.widget as any).confirm.action.payload;
    expect(payload.version).toBe(recovery.version + 1);
    expect(await f.store.loadItem(paused.threadId, card.id, f.context)).toEqual(
      card,
    );
    expect(
      await prisma.db.pausedRun.findUniqueOrThrow({
        where: { id: paused.payload.runId },
      }),
    ).toMatchObject({ status: 'waiting', version: payload.version });
  });

  it('rolls back a resumed pause when its next card fails, leaving recovery required', async () => {
    const f = await fixture([
      { call: { name: 'effect' } },
      { call: { name: 'effect' } },
    ]);
    const paused = await f.create();
    const add = f.store.addThreadItem.bind(f.store);
    vi.spyOn(f.store, 'addThreadItem').mockImplementation(
      async (id, item, context) => {
        if (item.type === 'widget') throw new Error('Next card insert failed.');
        return add(id, item, context);
      },
    );
    const events = await f.send({
      type: 'threads.custom_action',
      params: {
        thread_id: paused.threadId,
        item_id: paused.card.id,
        action: { type: 'approval.approve', payload: paused.payload },
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(f.effect).toHaveBeenCalledTimes(1);
    const row = await prisma.db.pausedRun.findUniqueOrThrow({
      where: { id: paused.payload.runId },
    });
    expect(row.status).toBe('recovery_required');
    expect(row.version).toBe(paused.payload.version + 1);
  });

  it('reports ChatKit and database chats separately even when their ids match', async () => {
    const f = await fixture();
    const paused = await f.create();
    const admin = new AdminService(prisma, config);
    await prisma.db.chat.create({ data: { id: paused.threadId } });
    await prisma.db.chatItem.create({
      data: {
        chatId: paused.threadId,
        item: { role: 'user', content: 'Legacy.' },
      },
    });
    await prisma.db.agentRun.create({
      data: {
        chatId: paused.threadId,
        agent: 'Legacy',
        status: 'completed',
        durationMs: 1,
        userId: f.context.userId,
      },
    });
    try {
      const chats = (await admin.chats({ limit: 200 })).filter(
        (chat) => chat.id === paused.threadId,
      );
      expect(chats).toHaveLength(2);
      expect(chats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationType: 'chatkit',
            messages: 1,
            runs: 1,
          }),
          expect.objectContaining({
            conversationType: 'chat',
            messages: 1,
            runs: 1,
          }),
        ]),
      );
      const run = await prisma.db.agentRun.findFirstOrThrow({
        where: { userId: f.context.userId, agent: 'Agentic' },
      });
      expect(run).toMatchObject({
        chatId: paused.threadId,
        conversationType: 'chatkit',
      });
      expect(
        (await admin.approvals({})).find(
          (row) => row.id === paused.payload.runId,
        ),
      ).toMatchObject({
        chatkitThreadId: paused.threadId,
        version: paused.payload.version,
      });
    } finally {
      await prisma.db.chat.delete({ where: { id: paused.threadId } });
    }
  });
});
