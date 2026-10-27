import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OpenAIProvider, setTracingDisabled } from '@openai/agents';
import request from 'supertest';
import { vi } from 'vitest';
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
});
