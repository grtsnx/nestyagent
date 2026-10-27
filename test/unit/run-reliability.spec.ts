import { ConfigService } from '@nestjs/config';
import {
  Agent,
  OpenAIProvider,
  RunState,
  Usage,
  handoff,
  setTracingDisabled,
  tool,
  type Model,
} from '@openai/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { fakePrisma } from './fake-prisma.js';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());

const answer = (usage = new Usage()) => ({
  usage,
  output: [
    {
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'completed' as const,
      content: [{ type: 'output_text' as const, text: 'Done.' }],
    },
  ],
});
const call = (callId = 'order', usage = new Usage()) => ({
  usage,
  output: [
    {
      type: 'function_call' as const,
      callId,
      name: 'confirm_order',
      arguments: '{}',
    },
  ],
});
const model = (getResponse: Model['getResponse']): Model => ({
  getResponse,
  getStreamedResponse() {
    throw new Error('Unused stream.');
  },
});
const approval = (execute = async () => 'confirmed') =>
  tool({
    name: 'confirm_order',
    description: 'Confirm order.',
    parameters: z.object({}),
    needsApproval: true,
    execute,
  });
function fixture() {
  const { db, prisma } = fakePrisma();
  return {
    db,
    prisma,
    openai: new OpenaiService(
      new ConfigService({ DATABASE_URL: 'test-double' }),
      prisma,
    ),
  };
}

describe('runtime reliability with the real SDK', () => {
  it('creates one runnable checkpoint for concurrent saves of the same state', async () => {
    const { db, openai } = fixture();
    const execute = vi.fn(async () => 'confirmed');
    const agent = new Agent({
      name: 'Orders',
      model: model(async (r) =>
        Array.isArray(r.input) &&
        r.input.some((i) => i.type === 'function_call_result')
          ? answer()
          : call(),
      ),
      tools: [approval(execute)],
    });
    const paused = await openai.runAgent('Confirm.', agent);
    const ids = await Promise.all([
      openai.saveRun(paused),
      openai.saveRun(paused),
    ]);
    expect(new Set(ids).size).toBe(1);
    const state = await openai.loadRun(agent, ids[0]);
    openai.approve({ state });
    await openai.resumeAgent(agent, state);
    expect(db.pausedRun.rows).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reuses its checkpoint identity after an ambiguous database commit', async () => {
    const { db, prisma, openai } = fixture();
    const agent = new Agent({
      name: 'Orders',
      model: model(async () => call()),
      tools: [approval()],
    });
    const paused = await openai.runAgent('Confirm.', agent);
    const transact = prisma.transaction.bind(prisma);
    vi.spyOn(prisma, 'transaction').mockImplementationOnce(async (work) => {
      await transact(work);
      throw new Error('Commit acknowledgement lost.');
    });
    await expect(openai.saveRun(paused)).rejects.toThrow('acknowledgement');
    const id = await openai.saveRun(paused);
    expect(db.pausedRun.rows).toHaveLength(1);
    expect(db.pausedRun.rows[0].id).toBe(id);
  });

  it.each(['caller', 'lease', 'shutdown'] as const)(
    'cancels a nested guardrail when the %s signal ends',
    async (source) => {
      const { prisma, openai } = fixture();
      const caller = new AbortController();
      const lease = new AbortController();
      let started!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let received: AbortSignal | undefined;
      const checker = new Agent({
        name: 'Checker',
        model: model(async (request) => {
          received = request.signal;
          started();
          await Promise.race([
            gate,
            new Promise<void>((_, reject) =>
              request.signal?.addEventListener(
                'abort',
                () => reject(request.signal!.reason),
                { once: true },
              ),
            ),
          ]);
          return answer();
        }),
      });
      const main = new Agent({
        name: 'Main',
        model: model(async () => answer()),
        inputGuardrails: [
          openai.agentInputGuardrail('Check', checker, () => false),
        ],
      });
      vi.spyOn(prisma, 'withLock').mockImplementation(
        async (_keys, work) => await work(lease.signal),
      );
      const pending = openai
        .runAgent('Hi.', main, {
          session: openai.createSession(`signal-${source}`),
          signal: caller.signal,
        })
        .then(
          () => 'resolved',
          () => 'rejected',
        );
      await entered;
      if (source === 'caller') caller.abort();
      if (source === 'lease') lease.abort();
      if (source === 'shutdown') await openai.onModuleDestroy();
      try {
        expect(received?.aborted).toBe(true);
        expect(
          await Promise.race([
            pending,
            new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
          ]),
        ).toBe('rejected');
      } finally {
        release();
        await pending;
      }
    },
  );

  it('cancels from saved data alone, even after the paused tool was removed', async () => {
    const { db, openai } = fixture();
    const execute = vi.fn(async () => 'confirmed');
    const respond = vi.fn<Model['getResponse']>(async () => call());
    const agent = new Agent({
      name: 'Orders',
      model: model(respond),
      tools: [approval(execute)],
    });
    const session = openai.createSession('cancel-updated');
    const paused = await openai.runAgent('Confirm.', agent, { session });
    const id = await openai.saveRun(paused);
    // An update removed the tool. Restoring the run would fail with "Tool not found".
    const updated = new Agent({ name: 'Orders', model: model(respond) });
    const restore = vi.spyOn(RunState, 'fromString');
    await expect(openai.cancelRun(updated, id)).resolves.toEqual({
      id,
      status: 'cancelled',
    });
    // Nothing is rebuilt, so no model, tool, or agent callback can run.
    expect(restore).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(await session.getItems()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call' }),
      ]),
    );
    expect(db.pausedRun.rows[0]).toMatchObject({
      status: 'completed',
      recoveryNote: 'cancelled',
    });
  });

  it('cancels atomically without invoking the model or tools again, then admits the next turn', async () => {
    const { db, openai } = fixture();
    const execute = vi.fn(async () => 'confirmed');
    let calls = 0;
    const respond = vi.fn<Model['getResponse']>(async () =>
      call(`order-${++calls}`),
    );
    const agent = new Agent({
      name: 'Orders',
      model: model(respond),
      tools: [approval(execute)],
    });
    const session = openai.createSession('cancel');
    const paused = await openai.runAgent('Confirm.', agent, { session });
    const id = await openai.saveRun(paused);
    const stale = await openai.loadRun(agent, id);
    const receipt = await openai.cancelRun(agent, id);
    expect(receipt).toEqual({ id, status: 'cancelled' });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(await session.getItems()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call' }),
      ]),
    );
    expect(db.pausedRun.rows[0].status).toBe('completed');
    openai.approve({ state: stale });
    await expect(openai.resumeAgent(agent, stale)).rejects.toThrow('stale');
    respond.mockImplementation(async () => answer());
    await expect(
      openai.runAgent('New question.', agent, { session }),
    ).resolves.toBeDefined();
  });

  it.each(['live', 'restored'] as const)(
    'records only new usage after resuming a %s approval',
    async (kind) => {
      const { db, openai } = fixture();
      let calls = 0;
      const agent = new Agent({
        name: 'Orders',
        model: model(async () => {
          const usage = new Usage({
            requests: 1,
            inputTokens: ++calls === 1 ? 10 : 20,
            outputTokens: 1,
            inputTokensDetails: [{ cached_tokens: calls === 1 ? 4 : 8 }],
          });
          return calls === 1 ? call('order', usage) : answer(usage);
        }),
        tools: [approval()],
      });
      const paused = await openai.runAgent('Confirm.', agent, {
        session: openai.createSession('usage'),
      });
      const state =
        kind === 'live'
          ? paused.state
          : await openai.loadRun(agent, await openai.saveRun(paused));
      openai.approve({ state });
      await openai.resumeAgent(agent, state);
      expect(db.agentRun.rows).toMatchObject([
        { requests: 1, inputTokens: 10, outputTokens: 1, cachedTokens: 4 },
        { requests: 1, inputTokens: 20, outputTokens: 1, cachedTokens: 8 },
      ]);
    },
  );

  it.each([false, true])(
    'retains consumed usage when an output guardrail rejects the answer (stream=%s)',
    async (stream) => {
      const { db, openai } = fixture();
      const response = () =>
        answer(new Usage({ requests: 1, inputTokens: 17, outputTokens: 3 }));
      const agent = new Agent({
        name: 'Blocked',
        model: {
          getResponse: async () => response(),
          async *getStreamedResponse() {
            yield { type: 'response_started' };
            yield {
              type: 'response_done',
              response: { ...response(), id: 'response' },
            };
          },
        },
        outputGuardrails: [
          {
            name: 'Check',
            execute: async () => ({
              tripwireTriggered: true,
              outputInfo: 'private answer',
            }),
          },
        ],
      });
      if (stream) {
        const result = await openai.runAgent('Question.', agent, {
          stream: true,
        });
        const completed = result.completed.catch(() => {});
        await expect(
          (async () => {
            for await (const _ of result) {
              /* Drain the real SDK stream. */
            }
          })(),
        ).rejects.toThrow();
        await completed;
      } else
        await expect(openai.runAgent('Question.', agent)).rejects.toThrow();
      expect(db.agentRun.rows).toMatchObject([
        { status: 'failed', requests: 1, inputTokens: 17, outputTokens: 3 },
      ]);
    },
  );

  it.each(['fresh', 'live', 'restored'] as const)(
    'retains only invocation usage after a plain model error (%s)',
    async (kind) => {
      const { db, openai } = fixture();
      let calls = 0;
      const failure = new Error('Second model request failed.');
      const agent = new Agent({
        name: 'Lookup',
        model: model(async () => {
          calls++;
          if (kind !== 'fresh' && calls === 1)
            return call(
              'approval',
              new Usage({
                requests: 1,
                inputTokens: 5,
                outputTokens: 1,
                inputTokensDetails: [{ cached_tokens: 2 }],
              }),
            );
          if (calls === (kind === 'fresh' ? 1 : 2))
            return {
              usage: new Usage({
                requests: 1,
                inputTokens: 10,
                outputTokens: 2,
                inputTokensDetails: [{ cached_tokens: 3 }],
              }),
              output: [
                {
                  type: 'function_call' as const,
                  callId: 'lookup',
                  name: 'lookup',
                  arguments: '{}',
                },
              ],
            };
          throw failure;
        }),
        tools: [
          approval(),
          tool({
            name: 'lookup',
            description: 'Read an order.',
            parameters: z.object({}),
            execute: async () => 'found',
          }),
        ],
      });
      if (kind === 'fresh')
        await expect(openai.runAgent('Lookup.', agent)).rejects.toBe(failure);
      else {
        const paused = await openai.runAgent('Lookup.', agent, {
          session: openai.createSession(`failed-${kind}`),
        });
        const state =
          kind === 'live'
            ? paused.state
            : await openai.loadRun(agent, await openai.saveRun(paused));
        openai.approve({ state });
        await expect(openai.resumeAgent(agent, state)).rejects.toBe(failure);
        expect(db.agentRun.rows[0]).toMatchObject({
          requests: 1,
          inputTokens: 5,
          outputTokens: 1,
          cachedTokens: 2,
        });
      }
      expect(db.agentRun.rows.at(-1)).toMatchObject({
        status: 'failed',
        requests: 1,
        inputTokens: 10,
        outputTokens: 2,
        cachedTokens: 3,
      });
    },
  );

  it('counts a nested guardrail once before a plain model failure', async () => {
    const { db, openai } = fixture();
    const checker = new Agent({
      name: 'Checker',
      model: model(async () =>
        answer(new Usage({ requests: 1, inputTokens: 7, outputTokens: 1 })),
      ),
    });
    const failure = new Error('Main model failed.');
    const agent = new Agent({
      name: 'Main',
      model: model(async () => {
        throw failure;
      }),
      inputGuardrails: [
        openai.agentInputGuardrail('Check', checker, () => false),
      ],
    });
    await expect(openai.runAgent('Question.', agent)).rejects.toBe(failure);
    expect(db.agentRun.rows).toMatchObject([
      { status: 'failed', requests: 1, inputTokens: 7, outputTokens: 1 },
    ]);
  });

  it('records stable error categories without any guardrail or exception payload', async () => {
    const { db, openai } = fixture();
    const agent = new Agent({
      name: 'Blocked',
      model: model(async () => answer()),
      inputGuardrails: [
        openai.inputGuardrail('Check', async () => ({
          tripwireTriggered: true,
          outputInfo: {
            email: 'private@example.test',
            message: 'customer message',
          },
        })),
      ],
    });
    await expect(openai.runAgent('Question.', agent)).rejects.toThrow();
    expect(db.agentRun.rows[0].error).toBe('input_guardrail');
    expect(JSON.stringify(db.agentRun.rows)).not.toContain('private');
    const throwing = new Agent({
      name: 'Failing',
      model: model(async () => {
        throw new Error('private@example.test');
      }),
    });
    await expect(openai.runAgent('Question.', throwing)).rejects.toThrow();
    expect(db.agentRun.rows.at(-1)?.error).toBe('run_failed');
  });

  it('records the actual chat rather than a trace grouping label', async () => {
    const { db, openai } = fixture();
    const agent = new Agent({
      name: 'Helper',
      model: model(async () => answer()),
    });
    await openai.runAgent('Question.', agent, {
      session: openai.createSession('actual-chat'),
      groupId: 'shared-workflow',
    });
    await openai.runAgent('Question.', agent, { groupId: 'shared-workflow' });
    expect(db.agentRun.rows[0].chatId).toBe('actual-chat');
    expect(db.agentRun.rows[1].chatId).toBeUndefined();
  });

  it('labels mixed-model usage without attributing it to the starting model', async () => {
    const { db, openai } = fixture();
    let calls = 0;
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockImplementation(
      async () =>
        model(async () => {
          const usage = new Usage({
            requests: 1,
            inputTokens: 10,
            outputTokens: 1,
          });
          return ++calls === 1
            ? {
                usage,
                output: [
                  {
                    type: 'function_call',
                    callId: 'handoff',
                    name: 'transfer_to_specialist',
                    arguments: '{}',
                  },
                ],
              }
            : answer(usage);
        }),
    );
    const specialist = new Agent({
      name: 'Specialist',
      model: 'gpt-5.6-terra',
    });
    const main = new Agent({
      name: 'Main',
      model: 'gpt-6-astra',
      handoffs: [
        handoff(specialist, { toolNameOverride: 'transfer_to_specialist' }),
      ],
    });
    await openai.runAgent('Ask the specialist.', main);
    expect(db.agentRun.rows[0]).toMatchObject({
      model: 'mixed',
      inputTokens: 20,
      requests: 2,
    });
  });

  it('labels custom model usage as unknown', async () => {
    const { db, openai } = fixture();
    await openai.runAgent(
      'Question.',
      new Agent({ name: 'Custom', model: model(async () => answer()) }),
    );
    expect(db.agentRun.rows[0].model).toBe('unknown');
  });

  it('rolls cancellation back if history settlement fails', async () => {
    const { db, openai } = fixture();
    const agent = new Agent({
      name: 'Orders',
      model: model(async () => call()),
      tools: [approval()],
    });
    const session = openai.createSession('cancel-rollback');
    const paused = await openai.runAgent('Confirm.', agent, { session });
    const id = await openai.saveRun(paused);
    const before = await session.getItems();
    vi.spyOn(db.chatItem, 'create').mockRejectedValueOnce(
      new Error('Write failed.'),
    );
    await expect(openai.cancelRun(agent, id)).rejects.toThrow('Write failed');
    expect(db.pausedRun.rows[0].status).toBe('waiting');
    expect(await session.getItems()).toEqual(before);
    await openai.cancelRun(agent, id);
    await expect(openai.cancelRun(agent, id)).resolves.toEqual({
      id,
      status: 'cancelled',
    });
  });

  it('preserves completed actions when cancelling an unrelated pending approval', async () => {
    const { db, openai } = fixture();
    let calls = 0;
    const ran = vi.fn(async () => 'completed action');
    const agent = new Agent({
      name: 'Orders',
      model: model(async () =>
        ++calls === 1
          ? {
              usage: new Usage(),
              output: [
                {
                  type: 'function_call',
                  callId: 'done',
                  name: 'read_order',
                  arguments: '{}',
                },
              ],
            }
          : call(),
      ),
      tools: [
        approval(),
        tool({
          name: 'read_order',
          description: 'Read order.',
          parameters: z.object({}),
          execute: ran,
        }),
      ],
    });
    const session = openai.createSession('cancel-preserve');
    const paused = await openai.runAgent('Confirm.', agent, { session });
    await openai.cancelRun(agent, await openai.saveRun(paused));
    const history = await session.getItems();
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', callId: 'done' }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'done',
        }),
      ]),
    );
    expect(history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ callId: 'order' })]),
    );
    expect(ran).toHaveBeenCalledTimes(1);
    expect(db.pausedRun.rows[0].status).toBe('completed');
  });
});
