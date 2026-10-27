import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { ChatKitStore, type ChatKitContext } from '@/config/chatkit/index.js';
import {
  ChatKitService,
  NotFoundError,
  type Attachment,
  type ThreadItem,
  type ThreadMetadata,
} from '@/lib/chatkit/chatkit.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );
const prisma = new PrismaService(
  new ConfigService({ DATABASE_URL: databaseUrl }),
);
const users: string[] = [];
const locks: string[] = [];
const thread = (id: string): ThreadMetadata => ({
  id,
  created_at: new Date().toISOString(),
  status: { type: 'active' },
  metadata: {},
});

async function fixture() {
  const unique = randomUUID();
  const context: ChatKitContext = {
    userId: `storage-${unique}`,
    baseUrl: 'http://example.test',
  };
  users.push(context.userId);
  const store = new ChatKitStore(prisma);
  const a = thread(`thr_a_${unique}`);
  const b = thread(`thr_b_${unique}`);
  await store.saveThread(a, context);
  await store.saveThread(b, context);
  const file: Attachment = {
    type: 'file',
    id: `atc_${unique}`,
    name: 'fixture.txt',
    mime_type: 'text/plain',
    upload_descriptor: { url: 'http://example.test/upload', method: 'POST' },
  };
  await store.saveAttachment(file, context);
  return { context, store, a, b, file };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const owners = users.splice(0);
  await prisma.db.chatkitThread.deleteMany({
    where: { userId: { in: owners } },
  });
  // Unattached test uploads have no thread cascade.
  await prisma.db.chatkitAttachment.deleteMany({
    where: { userId: { in: owners } },
  });
  await prisma.db.executionLock.deleteMany({
    where: { key: { in: locks.splice(0) } },
  });
});
afterAll(async () => prisma.onModuleDestroy());

describe('ChatKit storage transactions in Postgres', () => {
  it('keeps item pagination owner scoped when a direct caller omits the thread id', async () => {
    const own = await fixture();
    const other = await fixture();
    for (const fixture of [own, other])
      await fixture.store.saveItem(
        fixture.a.id,
        {
          type: 'end_of_turn',
          id: `item_${fixture.a.id}`,
          thread_id: fixture.a.id,
          created_at: new Date().toISOString(),
        },
        fixture.context,
      );
    const page = await own.store.loadThreadItems(
      undefined as unknown as string,
      null,
      100,
      'asc',
      own.context,
    );
    expect(page.data.map((item) => item.id)).toEqual([`item_${own.a.id}`]);
  });

  it('allows exactly one concurrent upload and preserves bound metadata', async () => {
    const { store, context, file, a } = await fixture();
    const results = await Promise.allSettled([
      store.saveAttachmentContent(file, Buffer.from('first'), context),
      store.saveAttachmentContent(file, Buffer.from('second'), context),
      store.saveAttachment({ ...file, thread_id: a.id }, context),
    ]);
    expect(
      results.slice(0, 2).filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.slice(0, 2).filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(results[2].status).toBe('fulfilled');
    const saved = await store.loadAttachmentContent(file.id, context.userId);
    expect(saved.content?.toString()).toBe(
      results[0].status === 'fulfilled' ? 'first' : 'second',
    );
    expect(saved.attachment.thread_id).toBe(a.id);
    expect(saved.attachment).not.toHaveProperty('upload_descriptor');
  });

  it('rejects cross-thread attachment reuse so deleting another thread preserves its bytes', async () => {
    const { store, context, file, a, b } = await fixture();
    await store.saveAttachmentContent(file, Buffer.from('keep'), context);
    await store.saveAttachment({ ...file, thread_id: a.id }, context);
    await expect(
      store.saveAttachment({ ...file, thread_id: b.id }, context),
    ).rejects.toThrow(NotFoundError);
    await store.deleteThread(b.id, context);
    expect(
      (
        await store.loadAttachmentContent(file.id, context.userId)
      ).content?.toString(),
    ).toBe('keep');
  });

  it('rolls direct-upload metadata back when writing bytes fails', async () => {
    const { store, context } = await fixture();
    const file: Attachment = {
      type: 'file',
      id: `atc_rollback_${randomUUID()}`,
      name: 'fixture.txt',
      mime_type: 'text/plain',
    };
    vi.spyOn(store, 'saveAttachmentContent').mockRejectedValueOnce(
      new Error('Bytes failed.'),
    );
    await expect(
      store.saveUploadedAttachment(file, Buffer.from('bytes'), context),
    ).rejects.toThrow('Bytes failed');
    expect(
      await prisma.db.chatkitAttachment.findUnique({ where: { id: file.id } }),
    ).toBeNull();
  });

  it('rejects stale thread writes after another owner takes the lease', async () => {
    const { store, context, a } = await fixture();
    const key = `chatkit:${a.id}`;
    locks.push(key);
    const item: ThreadItem = {
      type: 'end_of_turn',
      id: 'stale',
      thread_id: a.id,
      created_at: new Date().toISOString(),
    };
    await expect(
      prisma.withLock(key, async () => {
        await prisma.db.executionLock.updateMany({
          where: { key },
          data: { owner: randomUUID() },
        });
        await store.saveItem(a.id, item, context);
      }),
    ).rejects.toThrow('lock was lost');
    expect(
      await prisma.db.chatkitItem.findUnique({
        where: { threadId_id: { threadId: a.id, id: item.id } },
      }),
    ).toBeNull();
  });

  it('rolls a retried suffix back when the second deletion fails', async () => {
    const { store, context, a } = await fixture();
    const message: ThreadItem = {
      type: 'user_message',
      id: 'user',
      thread_id: a.id,
      created_at: new Date().toISOString(),
      content: [{ type: 'input_text', text: 'Question' }],
      attachments: [],
      inference_options: {},
    };
    await store.addThreadItem(a.id, message, context);
    for (const id of ['first', 'second'])
      await store.addThreadItem(
        a.id,
        {
          type: 'assistant_message',
          id,
          thread_id: a.id,
          created_at: new Date().toISOString(),
          content: [{ type: 'output_text', text: id, annotations: [] }],
        },
        context,
      );
    const original = store.deleteThreadItem.bind(store);
    let deleted = 0;
    vi.spyOn(store, 'deleteThreadItem').mockImplementation(async (...args) => {
      await original(...args);
      if (++deleted === 2) throw new Error('Second delete failed.');
    });
    let responses = 0;
    class Server extends ChatKitService<ChatKitContext> {
      async *respond() {
        responses++;
        yield* [];
      }
    }
    const result = await new Server(store).process(
      JSON.stringify({
        type: 'threads.retry_after_item',
        params: { thread_id: a.id, item_id: 'user' },
      }),
      context,
    );
    if (!result.streaming) throw new Error('Expected streaming retry.');
    await expect(
      (async () => {
        for await (const _ of result.stream) {
        }
      })(),
    ).rejects.toThrow('Second delete failed');
    expect(
      (await store.loadThreadItems(a.id, null, 10, 'asc', context)).data.map(
        (item) => item.id,
      ),
    ).toEqual(['user', 'first', 'second']);
    expect(responses).toBe(0);
  });
});
