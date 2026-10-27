import { ConfigService } from '@nestjs/config';
import {
  Agent,
  OpenAIProvider,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  MemoryStore,
  type ThreadMetadata,
  type WidgetItem,
} from '@/lib/chatkit/chatkit.service.js';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { MsSuzieChatKitService } from '@/modules/chatkit/chatkit.service.js';
import { SystemPromptsService } from '@/modules/system-prompts/system-prompts.service.js';
import { fakePrisma } from './fake-prisma.js';
import { scriptedModel, type ScriptStep } from './chatkit-model.js';

setTracingDisabled(true);
const cleanup: OpenaiService[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((service) => service.onModuleDestroy()),
  );
  vi.restoreAllMocks();
});
const owner = { userId: 'owner', baseUrl: 'https://example.invalid' };
const input = {
  content: [{ type: 'input_text', text: 'Perform the action.' }],
  attachments: [],
  inference_options: {},
};

async function fixture(
  steps: ScriptStep[] = [{ call: { name: 'effect' } }, { text: 'Completed.' }],
) {
  const fake = fakePrisma();
  const config = new ConfigService({
    OPENAI_API_KEY: 'sk-test',
    DATABASE_URL: 'postgresql://unused/test',
  });
  const store = new MemoryStore<typeof owner>();
  const openai = new OpenaiService(config, fake.prisma);
  cleanup.push(openai);
  const effect = vi.fn(async () => 'Done.');
  const agent = new Agent({
    name: 'MsSuzie',
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
  const server = new MsSuzieChatKitService(
    store as never,
    undefined as never,
    openai,
    new SystemPromptsService(fake.prisma, config),
    fake.prisma,
    config,
  );
  vi.spyOn(server, 'agent').mockReturnValue(agent);
  const model = scriptedModel(steps);
  vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue(model);
  // The protocol store is in memory here; ownership and deletion are tested with PostgreSQL below.
  Object.assign(fake.db, {
    chatkitThread: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; userId: string };
      }) => {
        if (where.userId !== owner.userId) return null;
        try {
          return {
            id: where.id,
            userId: owner.userId,
            data: await store.loadThread(where.id),
          };
        } catch {
          return null;
        }
      },
    },
  });
  const send = async (body: unknown) => {
    const result = await server.process(JSON.stringify(body), owner);
    if (!result.streaming) return [];
    const events: any[] = [];
    for await (const line of result.stream)
      events.push(JSON.parse(line.slice(6)));
    return events;
  };
  const events = await send({ type: 'threads.create', params: { input } });
  const threadId = events[0].thread.id;
  const card = events.find(
    (event) =>
      event.type === 'thread.item.done' && event.item.type === 'widget',
  ).item as WidgetItem;
  const payload = (card.widget as any).confirm.action.payload;
  const answer = (
    thread = threadId,
    checkpoint = payload,
    sender: string | null = card.id,
  ) =>
    send({
      type: 'threads.custom_action',
      params: {
        thread_id: thread,
        ...(sender && { item_id: sender }),
        action: { type: 'approval.approve', payload: checkpoint },
      },
    });
  return {
    ...fake,
    store,
    openai,
    server,
    agent,
    model,
    effect,
    send,
    answer,
    threadId,
    card,
    payload,
  };
}

describe('ChatKit approval binding', () => {
  it.each(['waiting', 'running', 'recovery_required', 'taken'])(
    'blocks new model turns while the thread checkpoint is %s',
    async (status) => {
      const f = await fixture();
      f.db.pausedRun.rows[0].status = status;
      await expect(
        f.send({
          type: 'threads.add_user_message',
          params: { thread_id: f.threadId, input },
        }),
      ).rejects.toThrow(/pending approval/);
      expect(f.model.calls).toBe(1);
      const history = await f.store.loadThreadItems(
        f.threadId,
        null,
        100,
        'asc',
      );
      expect(
        history.data.filter((item) => item.type === 'user_message'),
      ).toHaveLength(1);
    },
  );

  it('refuses the same owner’s approval in another thread', async () => {
    const f = await fixture();
    const other: ThreadMetadata = {
      id: 'thr_other',
      created_at: new Date().toISOString(),
      status: { type: 'active' },
      metadata: {},
    };
    await f.store.saveThread(other, owner);
    await f.answer(other.id, f.payload, null);
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.db.pausedRun.rows[0].status).toBe('waiting');
  });

  it('keeps the pending card when claiming the checkpoint fails', async () => {
    const f = await fixture();
    vi.spyOn(f.openai, 'resumeAgent').mockRejectedValueOnce(
      new Error('Claim unavailable.'),
    );
    await f.answer();
    expect(
      JSON.stringify(await f.store.loadItem(f.threadId, f.card.id)),
    ).not.toContain('Approved.');
    expect(f.db.pausedRun.rows[0].status).toBe('waiting');
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('refuses an earlier card after the same run pauses again', async () => {
    const f = await fixture([
      { call: { name: 'effect' } },
      { call: { name: 'effect' } },
      { text: 'Completed.' },
    ]);
    const first = await f.answer();
    expect(f.effect).toHaveBeenCalledTimes(1);
    const nextCard = first.find(
      (event) =>
        event.type === 'thread.item.done' && event.item.type === 'widget',
    ).item;
    const next = nextCard.widget.confirm.action.payload;
    expect(next.runId).toBe(f.payload.runId);
    expect(next.version).toBeGreaterThan(f.payload.version);
    await f.answer();
    expect(f.effect).toHaveBeenCalledTimes(1);
    await f.answer(f.threadId, next, nextCard.id);
    expect(f.effect).toHaveBeenCalledTimes(2);
  });

  it('records the ChatKit identity independently from the trace group', async () => {
    const f = await fixture();
    expect(f.db.agentRun.rows[0]).toMatchObject({
      chatId: f.threadId,
      conversationType: 'chatkit',
    });
    expect(f.db.pausedRun.rows[0]).toMatchObject({
      chatkitThreadId: f.threadId,
      ownerId: owner.userId,
    });
  });

  it('refuses approval after the configured instructions change', async () => {
    const f = await fixture();
    await f.db.systemPrompt.create({
      data: { name: 'mssuzie', content: 'Different instructions.' },
    });
    await f.answer();
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.db.pausedRun.rows[0].status).toBe('waiting');
  });

  it('issues a fresh card after explicit recovery and rejects the stale card', async () => {
    const f = await fixture();
    f.db.pausedRun.rows[0].status = 'recovery_required';
    const card = await f.server.recoverApproval(
      f.threadId,
      f.payload.runId,
      {
        version: f.payload.version,
        note: 'Verified that no external effect occurred.',
      },
      owner,
    );
    const payload = (card.widget as any).confirm.action.payload;
    expect(payload.version).toBe(f.payload.version + 1);
    await f.answer();
    expect(f.effect).not.toHaveBeenCalled();
    await f.answer(f.threadId, payload, card.id);
    expect(f.effect).toHaveBeenCalledOnce();
  });
});
