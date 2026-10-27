import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Agent,
  OpenAIProvider,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import request from 'supertest';
import { vi } from 'vitest';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ChatKitStore } from '@/config/chatkit/index.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { MsSuzieChatKitService } from '@/modules/chatkit/chatkit.service.js';
import { scriptedModel } from '../unit/chatkit-model.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );

const ADMIN_KEY = 'a'.repeat(32);
const SITE = 'https://chat.example.com';
// The app reads its settings when it is imported, so these are set first and put back after.
const settings = {
  DATABASE_URL: databaseUrl,
  OPENAI_API_KEY: 'sk-test',
  CHATKIT_SECRET: 'c'.repeat(32),
  ADMIN_API_KEY: ADMIN_KEY,
  LANGFUSE_PUBLIC_KEY: '',
  LANGFUSE_SECRET_KEY: '',
  LANGFUSE_BASE_URL: '',
  COMPOSIO_API_KEY: '',
  OPENAI_WEBHOOK_SECRET: '',
};
const saved = Object.fromEntries(
  Object.keys(settings).map((key) => [key, process.env[key]]),
);

setTracingDisabled(true);

describe('ChatKit over HTTP', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    Object.assign(process.env, settings);
    const [{ AppModule }, { configureApplication }, { validateEnvironment }] =
      await Promise.all([
        import('@/app'),
        import('@/bootstrap/application.js'),
        import('@/config/index.js'),
      ]);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureApplication(
      app,
      validateEnvironment({ NODE_ENV: 'test', CORS_ORIGINS: SITE }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    vi.restoreAllMocks();
  });

  async function tokenFor(userId: string) {
    const response = await http()
      .post('/v1/chatkit/tokens')
      .set('x-admin-key', ADMIN_KEY)
      .send({ userId, ttlSeconds: 600 });
    expect(response.status).toBe(201);
    return `Bearer ${(response.body as { data: { token: string } }).data.token}`;
  }

  // Parses the SSE body into ChatKit events.
  function events(text: string) {
    return text
      .split('\n\n')
      .filter(Boolean)
      .map((line) => {
        expect(line.startsWith('data: ')).toBe(true);
        return JSON.parse(line.slice(6)) as Record<string, any>;
      });
  }

  it('reports a failed message save after the decline was sent, and keeps the decline', async () => {
    const userId = `guardian-${Date.now()}-decline`;
    const effect = vi.fn(async () => 'Cancelled.');
    vi.spyOn(app.get(MsSuzieChatKitService), 'agent').mockReturnValue(
      new Agent({
        name: 'MsSuzie',
        tools: [
          tool({
            name: 'cancel_session',
            description: 'Cancel a session.',
            parameters: z.object({}),
            needsApproval: true,
            execute: effect,
          }),
        ],
      }),
    );
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue(
      scriptedModel([
        { call: { name: 'cancel_session' } },
        { text: 'Sure, what else?' },
      ]),
    );
    const token = await tokenFor(userId);
    const message = (text: string) => ({
      content: [{ type: 'input_text', text }],
      attachments: [],
      inference_options: {},
    });
    const created = events(
      (
        await http()
          .post('/v1/chatkit')
          .set('Authorization', token)
          .send({
            type: 'threads.create',
            params: { input: message('Cancel my session.') },
          })
          .expect(200)
      ).text,
    );
    const threadId = created[0].thread.id as string;
    const card = created.find(
      (event) =>
        event.type === 'thread.item.done' && event.item.type === 'widget',
    )!.item;

    // Saving the new message fails after the decline was already committed and sent.
    const store = app.get(ChatKitStore);
    const add = store.addThreadItem.bind(store);
    const write = vi
      .spyOn(store, 'addThreadItem')
      .mockImplementation(async (id, item, context) => {
        if (item.type === 'user_message')
          throw new Error('Message write failed.');
        return add(id, item, context);
      });
    const add_message = {
      type: 'threads.add_user_message',
      params: { thread_id: threadId, input: message('Never mind.') },
    };
    const failed = await http()
      .post('/v1/chatkit')
      .set('Authorization', token)
      .send(add_message)
      .expect(200);
    expect(failed.headers['content-type']).toContain('text/event-stream');
    const sent = events(failed.text);
    expect(sent.map((event) => event.type)).toEqual([
      'thread.item.replaced',
      'error',
    ]);
    expect(JSON.stringify(sent[0].item)).toContain('Declined.');
    expect(sent[1]).toEqual({
      type: 'error',
      code: 'stream.error',
      allow_retry: true,
    });

    // The decline is stored as sent; the message is not.
    const context = { userId, baseUrl: 'https://example.invalid' };
    const stored = await store.loadItem(threadId, card.id, context);
    expect(stored).toEqual(sent[0].item);
    expect(
      await app.get(PrismaService).db.pausedRun.findFirstOrThrow({
        where: { chatkitThreadId: threadId },
      }),
    ).toMatchObject({ status: 'completed', recoveryNote: 'cancelled' });
    const users = async () =>
      (
        await store.loadThreadItems(threadId, null, 50, 'asc', context)
      ).data.filter((item) => item.type === 'user_message');
    expect(await users()).toHaveLength(1);

    // Retrying the message works and is answered.
    write.mockRestore();
    const retried = events(
      (
        await http()
          .post('/v1/chatkit')
          .set('Authorization', token)
          .send(add_message)
          .expect(200)
      ).text,
    );
    expect(retried.some((event) => event.type === 'error')).toBe(false);
    expect(await users()).toHaveLength(2);
    expect(effect).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('issues tokens only with the admin key, and needs one for chat', async () => {
    await http()
      .post('/v1/chatkit/tokens')
      .send({ userId: 'guardian-1' })
      .expect(401);
    await http()
      .post('/v1/chatkit')
      .send({ type: 'threads.list', params: {} })
      .expect(401);
    await http()
      .post('/v1/chatkit')
      .set('Authorization', 'Bearer not-a-token')
      .send({ type: 'threads.list', params: {} })
      .expect(401);
  });

  it('streams a reply as server-sent events and keeps each chat private', async () => {
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue(
      scriptedModel([{ text: 'Hello from MsSuzie.' }]),
    );
    const alice = await tokenFor(`guardian-${Date.now()}-a`);
    const response = await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .set('Origin', SITE)
      .set('Accept-Language', 'fr-CA')
      .send({
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'Hi' }],
            attachments: [],
            inference_options: {},
          },
        },
      })
      .expect(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['x-accel-buffering']).toBe('no');
    const streamed = events(response.text);
    const threadId = streamed[0].thread.id as string;
    expect(streamed.at(-1)?.type).not.toBe('error');
    expect(response.text).toContain('Hello from MsSuzie.');

    const list = await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .send({ type: 'threads.list', params: { limit: 5 } })
      .expect(200);
    expect(list.body.data[0]).toMatchObject({ id: threadId, title: 'Hi' });

    // Another user gets "not found" for the same thread, never its content.
    const bob = await tokenFor(`guardian-${Date.now()}-b`);
    await http()
      .post('/v1/chatkit')
      .set('Authorization', bob)
      .send({ type: 'items.list', params: { thread_id: threadId } })
      .expect(404);
    await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .send({ type: 'threads.delete', params: { thread_id: threadId } })
      .expect(200);
  });

  it('rejects unknown requests and untrusted sites', async () => {
    const alice = await tokenFor('guardian-x');
    await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .send({ type: 'threads.explode', params: {} })
      .expect(400);
    await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .set('Origin', 'https://evil.example.com')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ type: 'threads.list', params: {} })
      .expect(403);
  });

  it('uploads directly and serves images through the signed link only', async () => {
    const alice = await tokenFor('guardian-files');
    const image = await http()
      .post('/v1/chatkit/attachments')
      .set('Authorization', alice)
      .attach('file', Buffer.from('png-bytes'), {
        filename: 'work.png',
        contentType: 'image/png',
      })
      .expect(200);
    expect(image.body).toMatchObject({ type: 'image', name: 'work.png' });
    const link = new URL(image.body.preview_url as string);

    const shown = await http()
      .get(link.pathname + link.search)
      .expect(200);
    expect(shown.headers['content-type']).toBe('image/png');
    expect(shown.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.from(shown.body as Buffer).toString()).toBe('png-bytes');
    await http().get(`${link.pathname}?sig=wrong`).expect(404);

    // Anything that is not a safe image downloads instead of opening in the page.
    const page = await http()
      .post('/v1/chatkit/attachments')
      .set('Authorization', alice)
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'page.html',
        contentType: 'text/html',
      })
      .expect(200);
    expect(page.body).toMatchObject({ type: 'file' });
    await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .send({
        type: 'attachments.delete',
        params: { attachment_id: image.body.id },
      })
      .expect(200);
    await http()
      .get(link.pathname + link.search)
      .expect(404);
  });

  it('uploads in two phases through the signed upload link', async () => {
    const alice = await tokenFor('guardian-two-phase');
    const created = await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .send({
        type: 'attachments.create',
        params: { name: 'notes.txt', size: 5, mime_type: 'text/plain' },
      })
      .expect(200);
    const upload = new URL(created.body.upload_descriptor.url as string);
    expect(created.body.upload_descriptor.method).toBe('POST');

    await http()
      .post(`${upload.pathname}?sig=wrong`)
      .attach('file', Buffer.from('hello'), 'notes.txt')
      .expect(404);
    // More bytes than were announced are refused, and the link still works after.
    await http()
      .post(upload.pathname + upload.search)
      .attach('file', Buffer.from('hello, world'), 'notes.txt')
      .expect(400);
    const done = await http()
      .post(upload.pathname + upload.search)
      .attach('file', Buffer.from('hello'), 'notes.txt')
      .expect(200);
    expect(done.body).toMatchObject({ id: created.body.id, type: 'file' });
    expect(done.body).not.toHaveProperty('upload_descriptor');

    // Too large for what was announced, or over the limit, is refused.
    await http()
      .post('/v1/chatkit')
      .set('Authorization', alice)
      .send({
        type: 'attachments.create',
        params: { name: 'big.bin', size: 10 ** 9, mime_type: 'text/plain' },
      })
      .expect(400);
  });

  it('lets only an admin recover a chat, and only one that needs it', async () => {
    const userId = `guardian-${Date.now()}-recover`;
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue(
      scriptedModel([{ text: 'Hello.' }]),
    );
    // Fetch the token first: supertest closes the shared server after each request.
    const token = await tokenFor(userId);
    const created = await http()
      .post('/v1/chatkit')
      .set('Authorization', token)
      .send({
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'Hi' }],
            attachments: [],
            inference_options: {},
          },
        },
      })
      .expect(200);
    const threadId = events(created.text)[0].thread.id as string;
    const body = { userId, decision: 'cancel', note: 'Checked: nothing ran.' };

    await http()
      .post(`/v1/chatkit/threads/${threadId}/recover`)
      .send(body)
      .expect(401);
    await http()
      .post(`/v1/chatkit/threads/${threadId}/recover`)
      .set('x-admin-key', ADMIN_KEY)
      .send(body)
      .expect(400);
    await http()
      .post(`/v1/chatkit/threads/${threadId}/recover`)
      .set('x-admin-key', ADMIN_KEY)
      .send({ ...body, userId: 'someone-else' })
      .expect(404);
    await http()
      .post(
        `/v1/chatkit/threads/${threadId}/approvals/0192f1e2-0000-7000-8000-000000000001/recover`,
      )
      .set('x-admin-key', ADMIN_KEY)
      .send({ userId, version: 0, note: 'Checked.' })
      .expect(404);

    // An interrupted approval in this chat, at version 2.
    const runId = randomUUID();
    await app.get(PrismaService).db.pausedRun.create({
      data: {
        id: runId,
        state: '{}',
        status: 'recovery_required',
        version: 2,
        chatkitThreadId: threadId,
        ownerId: userId,
        agentName: 'MsSuzie',
      },
    });
    const approval = `/v1/chatkit/threads/${threadId}/approvals/${runId}/recover`;
    const checked = { userId, version: 2, note: 'Checked: nothing ran.' };
    const recover = (path: string, payload: object) =>
      http().post(path).set('x-admin-key', ADMIN_KEY).send(payload);

    // Expected client mistakes are client errors, never 500.
    await recover(approval, { ...checked, version: 1 }).expect(409);
    await recover(approval, { ...checked, note: '   ' }).expect(400);
    await recover(`/v1/chatkit/threads/${threadId}/recover`, {
      ...body,
      note: '   ',
    }).expect(400);
    await recover(
      `/v1/chatkit/threads/${threadId}/approvals/not-a-uuid/recover`,
      checked,
    ).expect(400);
    await recover(approval, { ...checked, userId: 'someone-else' }).expect(404);
    await http().post(approval).send(checked).expect(401);
  });
});
