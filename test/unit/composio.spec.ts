import { ConfigService } from '@nestjs/config';
import {
  Agent,
  OpenAIProvider,
  RunContext,
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
  return {
    sessionId: id,
    tools: vi.fn().mockResolvedValue(tools),
    execute: vi.fn().mockResolvedValue({
      resultType: 'completed',
      data: { ok: true },
      logId: 'log_1',
    }),
    config: { user_id: 'user_123' },
  };
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
    expect(create).toHaveBeenCalledWith(
      'user_123',
      undefined,
      expect.objectContaining({
        maxRetries: 0,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(use.mock.calls[0][0]).toBe('sess_1');
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

    expect(use.mock.calls.map((args) => args[0])).toEqual(['sess_b']);
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
    expect(create).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
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

  it('tries again after a failed creation instead of locking the user out', async () => {
    const { db, composio } = service(ON);
    create
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(session('sess_2'));
    await expect(composio.tools('user_123')).rejects.toThrow('Connection lost');
    await composio.tools('user_123');
    expect(create).toHaveBeenCalledTimes(2);
    expect(db.composioSession.rows).toMatchObject([
      { userId: 'user_123', sessionId: 'sess_2' },
    ]);
  });

  it('deletes a session it could not save, then starts fresh next time', async () => {
    const { db, prisma, composio } = service(ON);
    create
      .mockResolvedValueOnce(session('sess_unsaved'))
      .mockResolvedValueOnce(session('sess_saved'));
    remove.mockResolvedValue({});
    vi.spyOn(prisma, 'transaction').mockRejectedValueOnce(
      new Error('Database down'),
    );
    await expect(composio.tools('user_123')).rejects.toThrow('Database down');
    expect(remove).toHaveBeenCalledWith('sess_unsaved', expect.anything());
    await composio.tools('user_123');
    expect(db.composioSession.rows).toMatchObject([
      { userId: 'user_123', sessionId: 'sess_saved' },
    ]);
  });

  it('reuses a session saved before a lost acknowledgement', async () => {
    const { db, prisma, composio } = service(ON);
    create.mockResolvedValue(session('sess_committed'));
    use.mockResolvedValue(session('sess_committed'));
    remove.mockResolvedValue({});
    const transact = prisma.transaction.bind(prisma);
    vi.spyOn(prisma, 'transaction').mockImplementationOnce(async (work) => {
      await transact(work);
      throw new Error('Connection lost after commit');
    });
    await expect(composio.tools('user_123')).rejects.toThrow();
    // The row was saved, so the next call uses it.
    expect(db.composioSession.rows).toMatchObject([
      { sessionId: 'sess_committed' },
    ]);
    await composio.tools('user_123');
    expect(use).toHaveBeenCalledWith(
      'sess_committed',
      undefined,
      expect.anything(),
    );
  });

  it('cancels an in-flight action and retains safe recovery identities', async () => {
    const action = tool({
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      description: 'Act.',
      parameters: z.object({}),
      execute: async () => 'unused',
    });
    const remote = session('sess_1', [action]);
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    remote.execute.mockImplementation(
      (_name, _input, _options, request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new Error('secret customer payload')),
            { once: true },
          );
          started();
        }),
    );
    create.mockResolvedValue(remote);
    const { composio } = service(ON);
    const { tools } = await composio.tools('user_123');
    if (tools[0].type !== 'function') throw new Error('Expected function');
    const controller = new AbortController();
    const result = tools[0].invoke(new RunContext(), '{}', {
      signal: controller.signal,
      toolCall: {
        type: 'function_call',
        name: action.name,
        callId: 'call_cancel',
        arguments: '{}',
      },
    });
    const rejected = expect(result).rejects.toMatchObject({
      name: 'ComposioActionError',
      sessionId: 'sess_1',
      callId: 'call_cancel',
      message: 'The Composio action needs reconciliation before retry.',
    });
    await executing;
    controller.abort();
    await rejected;
    expect(remote.execute).toHaveBeenCalledOnce();
  });

  it('retains the remote log id for an unsuccessful action result', async () => {
    const action = tool({
      name: 'GMAIL_SEND_EMAIL',
      description: 'Send.',
      parameters: z.object({}),
      execute: async () => 'unused',
    });
    const remote = session('sess_1', [action]);
    remote.execute.mockResolvedValue({
      resultType: 'failed',
      data: { ok: false },
      logId: 'log_failure',
    });
    create.mockResolvedValue(remote);
    const { composio } = service(ON);
    const { tools } = await composio.tools('user_123');
    if (tools[0].type !== 'function') throw new Error('Expected function');
    await expect(tools[0].invoke(new RunContext(), '{}')).rejects.toMatchObject(
      {
        name: 'ComposioActionError',
        sessionId: 'sess_1',
        toolName: action.name,
        logId: 'log_failure',
      },
    );
  });

  it('does not dispatch a tool after cancellation', async () => {
    const action = tool({
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      description: 'Act.',
      parameters: z.object({}),
      execute: async () => 'sent',
    });
    const remote = session('sess_1', [action]);
    create.mockResolvedValue(remote);
    const { composio } = service(ON);
    const { tools } = await composio.tools('user_123');
    if (tools[0].type !== 'function') throw new Error('Expected function');
    await expect(
      tools[0].invoke(new RunContext(), '{}', {
        signal: AbortSignal.abort(new Error('Cancelled')),
      }),
    ).rejects.toThrow('Cancelled');
    expect(remote.execute).not.toHaveBeenCalled();
  });

  it('propagates action failures for reconciliation instead of offering a retry', async () => {
    const action = tool({
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      description: 'Act.',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('Unknown outcome');
      },
    });
    const remote = session('sess_1', [action]);
    remote.execute.mockRejectedValue(new Error('Unknown outcome'));
    create.mockResolvedValue(remote);
    const { composio } = service(ON);
    const { tools } = await composio.tools('user_123');
    if (tools[0].type !== 'function') throw new Error('Expected function');
    const controller = new AbortController();
    await expect(
      tools[0].invoke(new RunContext(), '{}', {
        signal: controller.signal,
        toolCall: {
          type: 'function_call',
          name: action.name,
          callId: 'call_1',
          arguments: '{}',
        },
      }),
    ).rejects.toThrow(/reconcil/i);
    expect(remote.execute).toHaveBeenCalledWith(
      action.name,
      {},
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        maxRetries: 0,
      }),
    );
  });

  it.each(['response_blocked', undefined])(
    'requires reconciliation when a blocked action may have run (%s)',
    async (reason) => {
      const action = tool({
        name: 'GMAIL_SEND_EMAIL',
        description: 'Send.',
        parameters: z.object({}),
        execute: async () => 'unused',
      });
      const remote = session('sess_1', [action]);
      remote.execute.mockResolvedValue({
        resultType: 'blocked',
        data: {},
        error: 'Private result withheld',
        logId: 'log_blocked',
        ...(reason && { blockReason: { type: reason, hookId: 'policy' } }),
      });
      create.mockResolvedValue(remote);
      const { composio } = service(ON);
      const { tools } = await composio.tools('user_123');
      if (tools[0].type !== 'function') throw new Error('Expected function');
      await expect(
        tools[0].invoke(new RunContext(), '{}'),
      ).rejects.toMatchObject({
        name: 'ComposioActionError',
        logId: 'log_blocked',
      });
    },
  );

  it('returns a confirmed pre-execution refusal without claiming the action ran', async () => {
    const action = tool({
      name: 'GMAIL_SEND_EMAIL',
      description: 'Send.',
      parameters: z.object({}),
      execute: async () => 'unused',
    });
    const remote = session('sess_1', [action]);
    const blocked = {
      resultType: 'blocked',
      data: {},
      error: 'Policy denied',
      logId: 'log_blocked',
      blockReason: { type: 'request_blocked', hookId: 'policy' },
    };
    remote.execute.mockResolvedValue(blocked);
    create.mockResolvedValue(remote);
    const { composio } = service(ON);
    const { tools } = await composio.tools('user_123');
    if (tools[0].type !== 'function') throw new Error('Expected function');
    await expect(tools[0].invoke(new RunContext(), '{}')).resolves.toEqual(
      blocked,
    );
  });

  it('gives a failed lookup back to the model so the turn can continue', async () => {
    const lookup = tool({
      name: 'COMPOSIO_SEARCH_TOOLS',
      description: 'Find tools.',
      parameters: z.object({}),
      execute: async () => 'found',
    });
    const execute = vi.fn().mockRejectedValue(new Error('Search timed out'));
    create.mockResolvedValue({ ...session('sess_1', [lookup]), execute });
    const { composio } = service(ON);
    const { tools } = await composio.tools('user_123');

    // The model searches, sees the error, and then answers.
    let calls = 0;
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockResolvedValue({
      async getResponse() {
        calls += 1;
        return {
          usage: new Usage(),
          output:
            calls === 1
              ? [
                  {
                    type: 'function_call',
                    callId: 'call_1',
                    name: 'COMPOSIO_SEARCH_TOOLS',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      {
                        type: 'output_text',
                        text: 'Search failed, try later.',
                      },
                    ],
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
    const result = await openai.runAgent('Find my Gmail tools.', helper);

    expect(execute).toHaveBeenCalledOnce();
    expect(result.finalOutput).toBe('Search failed, try later.');
    await openai.onModuleDestroy();
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
