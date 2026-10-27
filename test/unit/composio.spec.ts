import { ConfigService } from '@nestjs/config';
import {
  Agent,
  OpenAIProvider,
  setTracingDisabled,
  tool,
  Usage,
  type Model,
  type Tool,
} from '@openai/agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ComposioService } from '@/lib/composio/composio.service.js';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { fakePrisma } from './fake-prisma.js';

const create = vi.hoisted(() => vi.fn());
const use = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const Composio = vi.hoisted(() =>
  vi.fn(function () {
    return { create, use, sessions: { delete: remove } };
  }),
);
const OpenAIAgentsProvider = vi.hoisted(() => vi.fn());

vi.mock('@composio/core', () => ({ Composio }));
vi.mock('@composio/openai-agents', () => ({ OpenAIAgentsProvider }));

setTracingDisabled(true);

const ON = {
  NODE_ENV: 'development',
  COMPOSIO_ENABLED: true,
  COMPOSIO_API_KEY: 'ak_test',
  DATABASE_URL: 'postgresql://localhost/test',
};

function service(values: Record<string, unknown>, fake = fakePrisma()) {
  return {
    ...fake,
    composio: new ComposioService(new ConfigService(values), fake.prisma),
  };
}

function session(id: string, tools: unknown[] = []) {
  return { sessionId: id, tools: vi.fn().mockResolvedValue(tools) };
}

describe('ComposioService', () => {
  beforeEach(() => {
    create.mockReset();
    use.mockReset();
    remove.mockReset();
    Composio.mockClear();
    OpenAIAgentsProvider.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('stays off until the project key is configured', async () => {
    const { composio } = service({ NODE_ENV: 'development' });

    expect(composio.enabled).toBe(false);
    await expect(composio.tools('user_123')).rejects.toThrow(
      /COMPOSIO_API_KEY/,
    );
    expect(Composio).not.toHaveBeenCalled();
  });

  it('stays off during tests', async () => {
    const { composio } = service({ ...ON, NODE_ENV: 'test' });

    expect(composio.enabled).toBe(false);
    await expect(composio.tools('user_123')).rejects.toThrow(
      /COMPOSIO_API_KEY/,
    );
    expect(Composio).not.toHaveBeenCalled();
  });

  it('passes the checked API key to Composio', async () => {
    create.mockResolvedValue(session('sess_1'));
    const { composio } = service(ON);

    await composio.tools('user_123');
    expect(Composio).toHaveBeenCalledWith({
      apiKey: 'ak_test',
      provider: expect.any(OpenAIAgentsProvider),
    });
  });

  it('stores the session on the server and reuses it for that user', async () => {
    create.mockResolvedValue(session('sess_1'));
    use.mockResolvedValue(session('sess_1'));
    const { db, composio } = service(ON);

    await composio.tools('user_123');
    await composio.tools('user_123');

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith('user_123');
    expect(use).toHaveBeenCalledWith('sess_1');
    expect(db.composioSession.rows).toMatchObject([
      { userId: 'user_123', sessionId: 'sess_1' },
    ]);
  });

  it('never opens another user’s session', async () => {
    create
      .mockResolvedValueOnce(session('sess_a'))
      .mockResolvedValueOnce(session('sess_b'));
    use.mockImplementation(async (id: string) => session(id));
    const { composio } = service(ON);

    await composio.tools('user_a');
    await composio.tools('user_b');
    await composio.tools('user_b');

    expect(use).toHaveBeenCalledWith('sess_b');
    expect(use).not.toHaveBeenCalledWith('sess_a');
  });

  it('replaces a session Composio no longer has', async () => {
    const { db, composio } = service(ON);
    await db.composioSession.create({
      data: { userId: 'user_123', sessionId: 'sess_old' },
    });
    use.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    create.mockResolvedValue(session('sess_new'));

    await composio.tools('user_123');
    expect(db.composioSession.rows).toMatchObject([
      { userId: 'user_123', sessionId: 'sess_new' },
    ]);
  });

  it('keeps one session when two first messages race', async () => {
    const fake = fakePrisma();
    const { composio } = service(ON, fake);
    create
      .mockResolvedValueOnce(session('sess_1'))
      .mockResolvedValueOnce(session('sess_2'));
    use.mockImplementation(async (id: string) => session(id));
    remove.mockResolvedValue({});

    await Promise.all([composio.tools('user_123'), composio.tools('user_123')]);

    expect(fake.db.composioSession.rows).toHaveLength(1);
    expect(remove).toHaveBeenCalledOnce();
  });

  it('works without a database by making a session each time', async () => {
    create.mockResolvedValue(session('sess_1'));
    const { composio } = service({ ...ON, DATABASE_URL: '' });

    await composio.tools('user_123');
    await composio.tools('user_123');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a blank or shared user id before talking to Composio', async () => {
    const { composio } = service(ON);

    await expect(composio.tools('')).rejects.toThrow(/user id/);
    await expect(composio.tools(' default ')).rejects.toThrow(/user id/);
    expect(Composio).not.toHaveBeenCalled();
  });

  it('lets lookups run but makes actions wait for approval', async () => {
    const execute = vi.fn(async () => 'sent');
    const lookup = tool({
      name: 'COMPOSIO_SEARCH_TOOLS',
      description: 'Find tools.',
      parameters: z.object({}),
      execute: async () => 'found',
    });
    const action = tool({
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      description: 'Run app actions.',
      parameters: z.object({ action: z.string() }),
      execute,
    });
    create.mockResolvedValue(session('sess_1', [lookup, action]));
    const { composio } = service(ON);
    const { tools } = await composio.tools('user_123');

    // A real SDK run: the model asks to send an email, and the run pauses for a person.
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue({
      async getResponse() {
        return {
          usage: new Usage(),
          output: [
            {
              type: 'function_call',
              callId: 'call_1',
              name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
              arguments: JSON.stringify({ action: 'GMAIL_SEND_EMAIL' }),
            },
          ],
        };
      },
      getStreamedResponse() {
        throw new Error('Unused stream');
      },
    } as Model);
    const openai = new OpenaiService(
      new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
      fakePrisma().prisma,
    );
    const helper = new Agent({ name: 'Helper', tools: tools as Tool[] });
    const result = await openai.runAgent('Email the tutor.', helper);

    expect(result.interruptions).toHaveLength(1);
    expect(result.interruptions[0]?.name).toBe('COMPOSIO_MULTI_EXECUTE_TOOL');
    expect(execute).not.toHaveBeenCalled();
    expect(
      await (
        tools[0] as unknown as { needsApproval: () => Promise<boolean> }
      ).needsApproval(),
    ).toBe(false);
    await openai.onModuleDestroy();
  });
});
