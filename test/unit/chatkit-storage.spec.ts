import { ConfigService } from '@nestjs/config';
import { ConflictException, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  ChatKitAttachmentStore,
  ChatKitAuth,
  ChatKitStore,
} from '@/config/chatkit/index.js';
import {
  ChatKitService,
  MemoryStore,
  NotFoundError,
  type Attachment,
  type ThreadMetadata,
} from '@/lib/chatkit/chatkit.service.js';
import { ChatKitController } from '@/modules/chatkit/chatkit.controller.js';
import { MsSuzieChatKitService } from '@/modules/chatkit/chatkit.service.js';
import { ChatKitUploadInterceptor } from '@/config/chatkit/chatkit.upload.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { EventEmitter } from 'node:events';

const context = { userId: 'alice', baseUrl: 'https://api.example.test' };
const thread = (id: string): ThreadMetadata => ({
  id,
  created_at: new Date().toISOString(),
  status: { type: 'active' },
  metadata: {},
});
const attachment = (): Attachment => ({
  type: 'image',
  id: 'atc_fixture',
  name: 'image.png',
  mime_type: 'image/png',
  preview_url: 'https://api.example.test/image',
});

function fixture() {
  const threads = new Map<string, Record<string, any>>();
  const attachments = new Map<string, Record<string, any>>();
  const items = new Map<string, Record<string, any>>();
  const matches = (
    row: Record<string, any>,
    where: Record<string, any>,
  ): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'OR')
        return value.some((clause: Record<string, any>) =>
          matches(row, clause),
        );
      if (key === 'AND')
        return value.every((clause: Record<string, any>) =>
          matches(row, clause),
        );
      return row[key] === value;
    });
  const table = (rows: Map<string, Record<string, any>>) => ({
    findFirst: vi.fn(async ({ where }) =>
      structuredClone(
        [...rows.values()].find((row) => matches(row, where)) ?? null,
      ),
    ),
    findUnique: vi.fn(async ({ where }) =>
      structuredClone(rows.get(where.id) ?? null),
    ),
    create: vi.fn(async ({ data }) => {
      if (rows.has(data.id))
        throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      const row = { threadId: null, content: null, ...structuredClone(data) };
      rows.set(data.id, row);
      return structuredClone(row);
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      let count = 0;
      for (const row of rows.values())
        if (matches(row, where)) {
          Object.assign(row, structuredClone(data));
          count++;
        }
      return { count };
    }),
    deleteMany: vi.fn(async ({ where }) => {
      let count = 0;
      for (const [id, row] of rows)
        if (matches(row, where)) {
          rows.delete(id);
          count++;
        }
      return { count };
    }),
  });
  const db = {
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, id: string) =>
      attachments.has(id) ? [structuredClone(attachments.get(id))] : [],
    ),
    chatkitThread: table(threads),
    chatkitAttachment: table(attachments),
    chatkitItem: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = `${where.threadId_id.threadId}:${where.threadId_id.id}`;
        const row = items.has(key)
          ? { ...items.get(key), ...structuredClone(update) }
          : structuredClone(create);
        items.set(key, row);
        return row;
      }),
    },
  };
  const transaction = vi.fn(async (work: (tx: typeof db) => Promise<unknown>) =>
    work(db),
  );
  const prisma = {
    db,
    connection: db,
    transaction,
  } as unknown as PrismaService;
  const config = new ConfigService({
    CHATKIT_SECRET: 's'.repeat(32),
    CHATKIT_MAX_UPLOAD_BYTES: 1024,
  });
  const auth = new ChatKitAuth(config);
  return {
    db,
    threads,
    attachments,
    items,
    transaction,
    prisma,
    config,
    auth,
    store: new ChatKitStore(prisma),
    files: new ChatKitAttachmentStore(prisma, auth, config),
  };
}

describe('ChatKit storage boundaries', () => {
  it('rejects invalid capabilities before multipart parsing and enforces the configured limit', async () => {
    const f = fixture();
    const file = await f.files.createAttachment(
      { name: 'image.png', mime_type: 'image/png', size: 4 },
      context,
    );
    await f.store.saveAttachment(file, context);
    const upload = new URL(file.upload_descriptor!.url);
    const preview = new URL((file as { preview_url: string }).preview_url);
    const module = await Test.createTestingModule({
      controllers: [ChatKitController],
      providers: [
        { provide: ConfigService, useValue: f.config },
        { provide: ChatKitAuth, useValue: f.auth },
        { provide: ChatKitStore, useValue: f.store },
        { provide: PrismaService, useValue: f.prisma },
        {
          provide: MsSuzieChatKitService,
          useValue: { chatkitStore: f.store, chatkitAttachments: f.files },
        },
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI });
    const intercept = vi.spyOn(ChatKitUploadInterceptor.prototype, 'intercept');
    try {
      await app.init();
      const http = () => request(app.getHttpServer());
      await http()
        .post(`${upload.pathname}?sig=${preview.searchParams.get('sig')}`)
        .attach('file', Buffer.alloc(2048), {
          filename: 'image.png',
          contentType: 'image/png',
        })
        .expect(404);
      expect(intercept).not.toHaveBeenCalled();
      await http()
        .post(upload.pathname + upload.search)
        .attach('file', Buffer.alloc(2048), {
          filename: 'image.png',
          contentType: 'image/png',
        })
        .expect(413);
      expect(f.attachments.get(file.id)?.content).toBeNull();
      await http()
        .post(upload.pathname + upload.search)
        .attach('file', Buffer.from('png!'), {
          filename: 'image.png',
          contentType: 'image/png',
        })
        .expect(200);
      const attempts = intercept.mock.calls.length;
      await http()
        .post(upload.pathname + upload.search)
        .attach('file', Buffer.from('changed'), {
          filename: 'image.png',
          contentType: 'image/png',
        })
        .expect(404);
      expect(intercept).toHaveBeenCalledTimes(attempts);
      const content = await http()
        .get(preview.pathname + preview.search)
        .expect(200);
      expect(Buffer.from(content.body).toString()).toBe('png!');
      const pending = await f.files.createAttachment(
        { name: 'race.png', mime_type: 'image/png', size: 4 },
        context,
      );
      await f.store.saveAttachment(pending, context);
      const race = new URL(pending.upload_descriptor!.url);
      // The guard passed, but another upload consumed the capability before the write.
      const write = vi
        .spyOn(f.store, 'saveAttachmentContent')
        .mockRejectedValueOnce(new NotFoundError('Attachment not found.'));
      await http()
        .post(race.pathname + race.search)
        .attach('file', Buffer.from('png!'), {
          filename: 'race.png',
          contentType: 'image/png',
        })
        .expect(404);
      write.mockRestore();
    } finally {
      intercept.mockRestore();
      await app.close();
    }
  });

  it('expires upload tokens and binds them to the attachment and owner', () => {
    const { auth } = fixture();
    const token = auth.issueUpload('file', context.userId);
    expect(auth.verifyUpload('file', token)).toBe(context.userId);
    expect(auth.verifyUpload('other', token)).toBeUndefined();
    expect(
      auth.verifyUpload('file', auth.signAttachment('file', context.userId)),
    ).toBeUndefined();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
    try {
      expect(auth.verifyUpload('file', token)).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['drain', 'close'])(
    'waits for SSE backpressure and releases on %s',
    async (event) => {
      let produced = 0;
      async function* events() {
        for (let index = 0; index < 3; index++) {
          produced++;
          yield `data: ${index}\n\n`;
        }
      }
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        status() {
          return this;
        },
        setHeader() {
          return this;
        },
        flushHeaders() {},
        write: vi.fn(() => false),
        end() {
          this.writableEnded = true;
        },
      });
      const controller = new ChatKitController({} as any, {} as any, {} as any);
      const streaming = (controller as any).stream(events(), response);
      await new Promise((resolve) => setImmediate(resolve));
      const before = produced;
      response.write.mockReturnValue(true);
      if (event === 'close') response.destroyed = true;
      response.emit(event);
      await streaming;
      expect(before).toBe(1);
      expect(produced).toBe(3);
      if (event === 'close') expect(response.write).toHaveBeenCalledOnce();
      expect(response.listenerCount('drain')).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
    },
  );
  it('cancels a failed SSE write and holds the lease until generator cleanup settles', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: AbortSignal;
    let locked = false;
    let cleaning = false;
    let finalized = false;
    async function* events() {
      try {
        yield 'data: first\n\n';
        signal.throwIfAborted();
      } finally {
        cleaning = true;
        await cleanup;
        finalized = true;
      }
    }
    const server = {
      process: async (_body: string, context: { signal: AbortSignal }) => {
        signal = context.signal;
        return { streaming: true, stream: events() };
      },
    };
    const prisma = {
      withLock: async (
        _key: string,
        work: (signal: AbortSignal) => Promise<void>,
      ) => {
        locked = true;
        try {
          await work(new AbortController().signal);
        } finally {
          locked = false;
        }
      },
    };
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      status() {
        return this;
      },
      setHeader() {
        return this;
      },
      flushHeaders() {},
      write() {
        throw new Error('Socket write failed.');
      },
      end() {
        this.writableEnded = true;
      },
    });
    const controller = new ChatKitController(
      server as any,
      {} as any,
      prisma as any,
    );
    const running = controller.process(
      {
        chatkit: context,
        body: {
          type: 'threads.custom_action',
          params: { thread_id: 'thr_test', action: { type: 'test' } },
        },
      } as any,
      response as any,
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(signal.aborted).toBe(true);
      expect(cleaning).toBe(true);
      expect(locked).toBe(true);
      expect(finalized).toBe(false);
    } finally {
      release();
      await running;
    }
    expect(finalized).toBe(true);
    expect(locked).toBe(false);
  });

  it('separates read capabilities from upload capabilities', async () => {
    const { files, auth } = fixture();
    const file = await files.createAttachment(
      { name: 'image.png', mime_type: 'image/png', size: 4 },
      context,
    );
    const upload = new URL(file.upload_descriptor!.url);
    expect(
      auth.verifyAttachment(
        file.id,
        context.userId,
        upload.searchParams.get('sig')!,
      ),
    ).toBe(false);
  });

  it('never overwrites completed upload bytes', async () => {
    const { store } = fixture();
    const file = attachment();
    await store.saveAttachment(file, context);
    await store.saveAttachmentContent(file, Buffer.from('first'), context);
    await expect(
      store.saveAttachmentContent(file, Buffer.from('replacement'), context),
    ).rejects.toThrow(NotFoundError);
    expect(
      (
        await store.loadAttachmentContent(file.id, context.userId)
      ).content?.toString(),
    ).toBe('first');
  });

  it('rejects moving an attachment to another thread', async () => {
    const { store } = fixture();
    const file = attachment();
    await store.saveThread(thread('thr_a'), context);
    await store.saveThread(thread('thr_b'), context);
    await store.saveAttachment({ ...file, thread_id: 'thr_a' }, context);
    await expect(
      store.saveAttachment({ ...file, thread_id: 'thr_b' }, context),
    ).rejects.toThrow();
    expect((await store.loadAttachment(file.id, context)).thread_id).toBe(
      'thr_a',
    );
  });

  it('does not persist a stale owner item after losing its lease', async () => {
    const { store, transaction, db } = fixture();
    await store.saveThread(thread('thr_a'), context);
    transaction.mockRejectedValueOnce(
      new Error('Database execution lock was lost.'),
    );
    await expect(
      store.saveItem(
        'thr_a',
        {
          id: 'item',
          thread_id: 'thr_a',
          type: 'end_of_turn',
          created_at: new Date().toISOString(),
        },
        context,
      ),
    ).rejects.toThrow('lock was lost');
    expect(db.chatkitItem.upsert).not.toHaveBeenCalled();
  });

  it('holds the new thread lock before publishing its id', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let published!: (id: string) => void;
    const created = new Promise<string>((resolve) => {
      published = resolve;
    });
    let active = 0;
    let maximum = 0;
    class Store extends MemoryStore<any> {
      generateThreadId() {
        return 'thr_new';
      }
    }
    class Server extends ChatKitService<any> {
      readonly chatkitStore = this.store;
      async *respond() {
        active++;
        maximum = Math.max(maximum, active);
        started();
        await gate;
        active--;
        yield* [];
      }
    }
    const server = new Server(new Store());
    const held = new Set<string>();
    const prisma = {
      withLock: async (
        key: string,
        work: (signal: AbortSignal) => Promise<void>,
      ) => {
        if (held.has(key)) throw new ConflictException('Already running.');
        held.add(key);
        try {
          return await work(new AbortController().signal);
        } finally {
          held.delete(key);
        }
      },
    };
    const controller = new ChatKitController(
      server as any,
      {} as any,
      prisma as any,
    );
    const response = () => ({
      writableEnded: false,
      on() {
        return this;
      },
      status() {
        return this;
      },
      setHeader() {
        return this;
      },
      flushHeaders() {},
      write(value: string) {
        const event = JSON.parse(value.slice(6));
        if (event.type === 'thread.created') published(event.thread.id);
        return true;
      },
      end() {
        this.writableEnded = true;
      },
    });
    const input = {
      content: [{ type: 'input_text', text: 'Hi' }],
      attachments: [],
      inference_options: {},
    };
    const first = controller.process(
      {
        body: { type: 'threads.create', params: { input } },
        chatkit: context,
      } as any,
      response() as any,
    );
    const id = await created;
    await firstStarted;
    const second = controller
      .process(
        {
          body: {
            type: 'threads.add_user_message',
            params: { thread_id: id, input },
          },
          chatkit: context,
        } as any,
        response() as any,
      )
      .then(
        () => 'completed',
        () => 'locked',
      );
    let outcome: string;
    try {
      outcome = await Promise.race([
        second,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('overlap'), 30),
        ),
      ]);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(outcome).toBe('locked');
    expect(maximum).toBe(1);
  });
});
