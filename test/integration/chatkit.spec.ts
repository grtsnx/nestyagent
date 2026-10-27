import { ConfigService } from '@nestjs/config';
import {
  Agent,
  OpenAIProvider,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { z } from 'zod';
import {
  NotFoundError,
  type ThreadItem,
  type ThreadMetadata,
  type ThreadStreamEvent,
} from '@/lib/chatkit/chatkit.service.js';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { MsSuzieChatKitService } from '@/modules/chatkit/chatkit.service.js';
import {
  ChatKitAttachmentStore,
  ChatKitAuth,
  ChatKitStore,
  type ChatKitContext,
} from '@/config/chatkit/index.js';
import { SystemPromptsService } from '@/modules/system-prompts/system-prompts.service.js';
import { scriptedModel, type ScriptStep } from '../unit/chatkit-model.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );

setTracingDisabled(true);

describe('ChatKit in Postgres', () => {
  const config = new ConfigService({
    DATABASE_URL: databaseUrl,
    OPENAI_API_KEY: 'sk-test',
    CHATKIT_SECRET: 'c'.repeat(32),
  });
  const prisma = new PrismaService(config);
  const store = new ChatKitStore(prisma);
  const auth = new ChatKitAuth(config);
  const attachments = new ChatKitAttachmentStore(prisma, auth, config);
  const openai = new OpenaiService(config, prisma);
  const server = new MsSuzieChatKitService(
    store,
    attachments,
    openai,
    new SystemPromptsService(prisma, config),
    prisma,
    config,
  );
  const owner = (): ChatKitContext => ({
    userId: `guardian-${randomUUID()}`,
    baseUrl: 'https://api.mssuzie.io',
  });
  const thread = (id = `thr_${randomUUID()}`): ThreadMetadata => ({
    id,
    created_at: new Date().toISOString(),
    status: { type: 'active' },
    metadata: { secret: 'server only' },
  });

  afterAll(async () => {
    await openai.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  function useModel(steps: ScriptStep[]) {
    const model = scriptedModel(steps);
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue(model);
    return model;
  }

  async function send(body: unknown, context: ChatKitContext) {
    const result = await server.process(JSON.stringify(body), context);
    if (!result.streaming)
      return JSON.parse(result.json) as Record<string, unknown>;
    const events: ThreadStreamEvent[] = [];
    for await (const line of result.stream)
      events.push(JSON.parse(line.slice(6)) as ThreadStreamEvent);
    return events;
  }

  it('keeps every thread, item, and file inside its owner', async () => {
    const alice = owner();
    const bob = owner();
    const mine = thread();
    await store.saveThread(mine, alice);

    await expect(store.loadThread(mine.id, bob)).rejects.toThrow(NotFoundError);
    await expect(
      store.saveThread({ ...mine, title: 'taken' }, bob),
    ).rejects.toThrow(NotFoundError);
    await expect(
      store.addThreadItem(
        mine.id,
        {
          type: 'end_of_turn',
          id: 'eot_1',
          thread_id: mine.id,
          created_at: new Date().toISOString(),
        },
        bob,
      ),
    ).rejects.toThrow(NotFoundError);
    expect((await store.loadThread(mine.id, alice)).title).toBeUndefined();
    await store.deleteThread(mine.id, alice);
  });

  it('pages items in exact order, both ways', async () => {
    const alice = owner();
    const mine = thread();
    await store.saveThread(mine, alice);
    for (const id of ['a', 'b', 'c', 'd'])
      await store.addThreadItem(
        mine.id,
        {
          type: 'end_of_turn',
          id,
          thread_id: mine.id,
          created_at: new Date().toISOString(),
        },
        alice,
      );
    // Saving an item again keeps its place.
    await store.saveItem(
      mine.id,
      {
        type: 'end_of_turn',
        id: 'a',
        thread_id: mine.id,
        created_at: new Date().toISOString(),
      },
      alice,
    );

    const first = await store.loadThreadItems(mine.id, null, 2, 'asc', alice);
    expect(first.data.map((item) => item.id)).toEqual(['a', 'b']);
    expect(first).toMatchObject({ has_more: true, after: 'b' });
    const rest = await store.loadThreadItems(mine.id, 'b', 5, 'asc', alice);
    expect(rest.data.map((item) => item.id)).toEqual(['c', 'd']);
    expect(rest.has_more).toBe(false);
    const newest = await store.loadThreadItems(mine.id, null, 3, 'desc', alice);
    expect(newest.data.map((item) => item.id)).toEqual(['d', 'c', 'b']);
    await store.deleteThread(mine.id, alice);
  });

  it('stores file bytes for the owner and deletes them with the thread', async () => {
    const alice = owner();
    const mine = thread();
    await store.saveThread(mine, alice);
    const image = attachments.describe(
      'atc_' + randomUUID(),
      'work.png',
      'image/png',
      alice,
    );
    await store.saveAttachment(image, alice);
    await store.saveAttachmentContent(image, Buffer.from('png-bytes'), alice);
    await store.saveAttachment({ ...image, thread_id: mine.id }, alice);

    const found = await store.loadAttachmentContent(image.id, alice.userId);
    expect(found.content?.toString()).toBe('png-bytes');
    await expect(
      store.loadAttachmentContent(image.id, owner().userId),
    ).rejects.toThrow(NotFoundError);
    if (image.type !== 'image') throw new Error('Expected an image.');
    const signature = new URL(image.preview_url).searchParams.get('sig')!;
    expect(auth.verifyAttachment(image.id, alice.userId, signature)).toBe(true);

    await store.deleteThread(mine.id, alice);
    await expect(store.loadAttachmentInfo(image.id)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('answers a new chat with the MsSuzie helper and records the run', async () => {
    const alice = owner();
    useModel([{ text: 'Plans start at $89 a month.', id: 'msg_plans' }]);
    const events = (await send(
      {
        type: 'threads.create',
        params: {
          input: {
            content: [
              { type: 'input_text', text: 'How much is tutoring for Grade 7?' },
            ],
            attachments: [],
            inference_options: {},
          },
        },
      },
      alice,
    )) as ThreadStreamEvent[];

    const created = events[0];
    if (created.type !== 'thread.created') throw new Error('No thread.');
    expect(created.thread).not.toHaveProperty('metadata');
    expect(events.map((event) => event.type)).toContain('thread.updated');
    const items = await store.loadThreadItems(
      created.thread.id,
      null,
      10,
      'asc',
      alice,
    );
    expect(items.data.map((item) => item.type)).toEqual([
      'user_message',
      'assistant_message',
    ]);
    expect(items.data[1]).toMatchObject({
      id: 'msg_plans',
      content: [{ text: 'Plans start at $89 a month.' }],
    });
    expect((await store.loadThread(created.thread.id, alice)).title).toBe(
      'How much is tutoring for Grade 7?',
    );
    const run = await prisma.db.agentRun.findFirst({
      where: { userId: alice.userId },
    });
    expect(run).toMatchObject({
      agent: 'MsSuzie',
      userId: alice.userId,
      status: 'completed',
    });
    await store.deleteThread(created.thread.id, alice);
  });

  it('pauses for approval, refuses another user, and finishes after Approve', async () => {
    const alice = owner();
    const cancelOrder = vi.fn(async () => 'Order 42 is cancelled.');
    const helper = new Agent({
      name: 'MsSuzie',
      instructions: 'Help.',
      tools: [
        tool({
          name: 'cancel_session',
          description: 'Cancel a session.',
          parameters: z.object({ sessionId: z.string() }),
          needsApproval: true,
          execute: cancelOrder,
        }),
      ],
    });
    vi.spyOn(server, 'agent').mockReturnValue(helper);
    useModel([
      { call: { name: 'cancel_session', arguments: { sessionId: '42' } } },
      { text: 'Session 42 is cancelled.' },
    ]);
    const events = (await send(
      {
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'Cancel session 42.' }],
            attachments: [],
            inference_options: {},
          },
        },
      },
      alice,
    )) as ThreadStreamEvent[];
    const threadId = (events[0] as { thread: { id: string } }).thread.id;
    const card = events.find(
      (event) =>
        event.type === 'thread.item.done' && event.item.type === 'widget',
    ) as {
      item: ThreadItem & {
        widget: { confirm: { action: { payload: { runId: string } } } };
      };
    };
    expect(card).toBeDefined();
    expect(cancelOrder).not.toHaveBeenCalled();
    const action = card.item.widget.confirm.action;

    // The run belongs to Alice, so Bob's approval is refused even with the right run id.
    const bob = owner();
    await store.saveThread(thread(threadId + '_bob'), bob);
    const refused = (await send(
      {
        type: 'threads.custom_action',
        params: {
          thread_id: threadId + '_bob',
          action: { ...action, type: 'approval.approve' },
        },
      },
      bob,
    )) as ThreadStreamEvent[];
    expect(refused.at(-1)).toMatchObject({
      type: 'error',
      code: 'custom',
      message: 'This request was already answered.',
    });
    expect(cancelOrder).not.toHaveBeenCalled();

    const approved = (await send(
      {
        type: 'threads.custom_action',
        params: {
          thread_id: threadId,
          item_id: card.item.id,
          action: { type: 'approval.approve', payload: action.payload },
        },
      },
      alice,
    )) as ThreadStreamEvent[];
    expect(cancelOrder).toHaveBeenCalledOnce();
    expect(approved.map((event) => event.type)).toContain(
      'thread.item.replaced',
    );
    const items = await store.loadThreadItems(threadId, null, 10, 'asc', alice);
    expect(items.data.at(-1)).toMatchObject({
      type: 'assistant_message',
      content: [{ text: 'Session 42 is cancelled.' }],
    });
    expect(
      JSON.stringify(await store.loadItem(threadId, card.item.id, alice)),
    ).toContain('Approved.');

    // A second click finds the run already answered.
    const again = (await send(
      {
        type: 'threads.custom_action',
        params: {
          thread_id: threadId,
          action: { type: 'approval.approve', payload: action.payload },
        },
      },
      alice,
    )) as ThreadStreamEvent[];
    expect(again.at(-1)).toMatchObject({ type: 'error', code: 'custom' });
    expect(cancelOrder).toHaveBeenCalledOnce();
    await store.deleteThread(threadId, alice);
    await store.deleteThread(threadId + '_bob', bob);
    vi.restoreAllMocks();
  });

  it('saves feedback only on the user’s own thread', async () => {
    const alice = owner();
    const mine = thread();
    await store.saveThread(mine, alice);
    await store.addThreadItem(
      mine.id,
      {
        type: 'assistant_message',
        id: 'msg_1',
        thread_id: mine.id,
        created_at: mine.created_at,
        content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
      },
      alice,
    );
    await send(
      {
        type: 'items.feedback',
        params: { thread_id: mine.id, item_ids: ['msg_1'], kind: 'negative' },
      },
      alice,
    );
    await expect(
      send(
        {
          type: 'items.feedback',
          params: { thread_id: mine.id, item_ids: ['msg_1'], kind: 'positive' },
        },
        owner(),
      ),
    ).rejects.toThrow(NotFoundError);
    const rows = await prisma.db.chatkitFeedback.findMany({
      where: { threadId: mine.id },
    });
    expect(rows).toMatchObject([
      { kind: 'negative', itemIds: ['msg_1'], userId: alice.userId },
    ]);
    await prisma.db.chatkitFeedback.deleteMany({
      where: { threadId: mine.id },
    });
    await store.deleteThread(mine.id, alice);
  });
});
