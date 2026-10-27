import { ConfigService } from '@nestjs/config';
import {
  Agent,
  type AgentInputItem,
  getHandoff,
  handoff,
  RunContext,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  Runner,
  RunConfig,
  RunState,
  RunToolApprovalItem,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '@openai/agents';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { SandboxService } from '@/lib/sandbox/sandbox.service.js';
import { fakePrisma } from './fake-prisma.js';

function service(prisma = fakePrisma().prisma) {
  return new OpenaiService(
    { getOrThrow: () => 'sk-test' } as unknown as ConfigService,
    prisma,
  );
}

describe('OpenaiService orchestration', () => {
  it('uses the agent name when the tool name is left out', () => {
    const summarizer = new Agent({
      name: 'Summarizer',
      instructions: 'Summarize the supplied text.',
    });

    const tool = service().asTool(summarizer);

    expect(tool.name).toBe('Summarizer');
  });

  it('uses a tool name and description when they are passed', () => {
    const summarizer = new Agent({
      name: 'Summarizer',
      instructions: 'Summarize the supplied text.',
    });

    const tool = service().asTool(summarizer, {
      toolName: 'summarize_text',
      toolDescription: 'Generate a concise summary of the supplied text.',
    });

    expect(tool.name).toBe('summarize_text');
    expect(tool.description).toBe(
      'Generate a concise summary of the supplied text.',
    );
  });

  it('returns the specialist who answered', () => {
    const triage = new Agent({ name: 'Triage', instructions: 'Route.' });
    const billing = new Agent({ name: 'Billing', instructions: 'Bill.' });

    expect(service().nextAgent({ lastAgent: billing }, triage)).toBe(billing);
  });

  it('returns the fallback when the run has no last agent', () => {
    const triage = new Agent({ name: 'Triage', instructions: 'Route.' });

    expect(service().nextAgent({}, triage)).toBe(triage);
    expect(service().nextAgent({ lastAgent: undefined }, triage)).toBe(triage);
  });

  it('returns the response id that continues the chat on OpenAI', () => {
    expect(
      service().nextResponseId({
        lastResponseId: 'resp_1',
        interruptions: [],
      }),
    ).toBe('resp_1');
  });

  it('returns no response id while a tool is paused', () => {
    expect(
      service().nextResponseId({
        lastResponseId: 'resp_1',
        interruptions: [{}],
      }),
    ).toBeUndefined();
  });

  it('passes a handoff with its own settings to the triage agent', () => {
    const refunds = new Agent({ name: 'Refunds', instructions: 'Refund.' });
    const billing = new Agent({ name: 'Billing', instructions: 'Bill.' });

    const triage = service().createTriageAgent(
      'Triage',
      'Route.',
      [billing, handoff(refunds, { toolNameOverride: 'refund_request' })],
      'Routes billing questions.',
    );

    expect(triage.handoffs).toHaveLength(2);
    expect(getHandoff(triage.handoffs[1]).toolName).toBe('refund_request');
  });

  it('types runs from created agents, with and without stream', () => {
    const openai = service();
    const writer = openai.createAgent('Writer', 'Write.');
    const extractor = openai.createAgent('Extractor', 'Extract.', {
      schema: z.object({ name: z.string() }),
    });
    // The typecheck verifies expectTypeOf. These runs are only typed, never started.
    const plain = () => openai.runAgent('Hi.', writer);
    const typed = () => openai.runAgent('Hi.', extractor);
    const streamed = () => openai.runAgent('Hi.', writer, { stream: true });

    expectTypeOf<
      Awaited<ReturnType<typeof plain>>['finalOutput']
    >().toEqualTypeOf<string | undefined>();
    expectTypeOf<
      Awaited<ReturnType<typeof typed>>['finalOutput']
    >().toEqualTypeOf<{ name: string } | undefined>();
    expectTypeOf<Awaited<ReturnType<typeof streamed>>>().toHaveProperty(
      'completed',
    );
  });

  it('types a resumed run like the run it continues', () => {
    const openai = service();
    const helper = openai.createAgent('Order helper', 'Track orders.');
    // The typecheck verifies these. The runs are only typed, never started.
    const first = () => openai.runAgent('Cancel order 123.', helper);
    const resumed = () =>
      openai.resumeAgent(
        helper,
        {} as Parameters<typeof openai.saveRun>[0]['state'],
      );

    expectTypeOf<Awaited<ReturnType<typeof resumed>>>().toEqualTypeOf<
      Awaited<ReturnType<typeof first>>
    >();
  });

  it('runs a created sandbox agent without a type error', () => {
    const openai = service();
    const sandbox = new SandboxService(
      { getOrThrow: () => 'sk-test' } as unknown as ConfigService,
      openai,
      fakePrisma().prisma,
    );
    const guard = openai.outputGuardrail(
      'Keep the recipe secret',
      async () => ({
        tripwireTriggered: false,
        outputInfo: null,
      }),
    );
    const siteHelper = sandbox.createSandboxAgent('Site helper', 'Build.', {
      outputGuardrails: [guard],
    });

    expectTypeOf(sandbox.runSandboxOnce).toBeCallableWith('Hi.', siteHelper);
    expectTypeOf(sandbox.asTool).toBeCallableWith(siteHelper);
  });

  it('leaves guardrails off until the caller passes them', () => {
    const openai = service();
    const check = openai.inputGuardrail('Math homework', async () => ({
      tripwireTriggered: false,
      outputInfo: null,
    }));
    const replyCheck = openai.outputGuardrail('No secrets', async () => ({
      tripwireTriggered: false,
      outputInfo: null,
    }));
    const blocking = openai.inputGuardrail(
      'Math homework',
      async () => ({ tripwireTriggered: true, outputInfo: null }),
      { runInParallel: false },
    );

    expect(check.runInParallel).toBe(false);
    expect(blocking.runInParallel).toBe(false);

    const plain = new Agent({
      name: 'Support',
      instructions: 'Help customers.',
    });
    const untouched = openai.createAgent('Support', 'Help customers.');
    expect(untouched.inputGuardrails).toEqual([]);
    expect(untouched.outputGuardrails).toEqual([]);

    const guarded = openai.createAgent('Support', 'Help customers.', {
      inputGuardrails: [check],
      outputGuardrails: [replyCheck],
    });
    expect(guarded.inputGuardrails).toEqual([check]);
    expect(guarded.outputGuardrails).toEqual([replyCheck]);

    const triage = openai.createTriageAgent(
      'Triage',
      'Route.',
      [plain],
      'Routes support.',
      { inputGuardrails: [blocking] },
    );
    expect(triage.inputGuardrails).toEqual([blocking]);
  });

  it('builds optional tool guardrails and pauses only when approval is requested', async () => {
    const openai = service();
    const summarizer = new Agent({
      name: 'Summarizer',
      instructions: 'Summarize.',
    });
    const inputCheck = openai.toolInputGuardrail('Order id', async () => ({
      behavior: { type: 'allow' },
    }));
    const outputCheck = openai.toolOutputGuardrail('Result', async () => ({
      behavior: { type: 'allow' },
    }));

    const asks = (tool: { needsApproval: unknown }) =>
      (tool.needsApproval as () => Promise<boolean>)();

    expect(inputCheck).toMatchObject({ name: 'Order id', type: 'tool_input' });
    expect(outputCheck).toMatchObject({ name: 'Result', type: 'tool_output' });
    await expect(asks(openai.asTool(summarizer))).resolves.toBe(false);
    await expect(
      asks(openai.asTool(summarizer, { needsApproval: true })),
    ).resolves.toBe(true);

    const refunds = openai.asTool(summarizer, {
      needsApproval: async (_context, { input }) => input.includes('refund'),
    });
    const decide = refunds.needsApproval as (
      context: unknown,
      input: { input: string },
    ) => Promise<boolean>;
    await expect(decide({}, { input: 'refund order 1' })).resolves.toBe(true);
    await expect(decide({}, { input: 'track order 1' })).resolves.toBe(false);
  });

  it('approves or rejects only the pauses the caller chooses', () => {
    const openai = service();
    const first = { type: 'tool_approval_item' } as RunToolApprovalItem;
    const second = { type: 'tool_approval_item' } as RunToolApprovalItem;
    const state = {
      approve: vi.fn(),
      reject: vi.fn(),
      getInterruptions: () => [first],
      toString: () => 'saved-run',
    };
    const result = {
      state: state as unknown as RunState<unknown, Agent>,
      interruptions: [first, second],
    };

    openai.approve(result, { interruptions: [first], alwaysApprove: true });
    expect(state.approve).toHaveBeenCalledTimes(1);
    expect(state.approve).toHaveBeenCalledWith(first, { alwaysApprove: true });

    openai.reject(result, { message: 'A person declined this.' });
    expect(state.reject).toHaveBeenCalledTimes(2);
    expect(state.reject).toHaveBeenCalledWith(second, {
      message: 'A person declined this.',
    });
  });

  it('uses the state pauses when the result has no interruption list', () => {
    const first = { type: 'tool_approval_item' } as RunToolApprovalItem;
    const state = {
      approve: vi.fn(),
      reject: vi.fn(),
      getInterruptions: () => [first],
      toString: () => 'saved-run',
    };

    service().approve({
      state: state as unknown as RunState<unknown, Agent>,
    });

    expect(state.approve).toHaveBeenCalledWith(first, {});
  });

  it('passes optional guardrails through to a sandbox agent', () => {
    const openai = service();
    const check = openai.inputGuardrail('Math homework', async () => ({
      tripwireTriggered: false,
      outputInfo: null,
    }));
    const sandbox = new SandboxService(
      { getOrThrow: () => 'sk-test' } as unknown as ConfigService,
      openai,
      fakePrisma().prisma,
    );

    const agent = sandbox.createSandboxAgent(
      'Workspace agent',
      'Use the computer.',
      { inputGuardrails: [check] },
    );

    expect(agent.inputGuardrails).toEqual([check]);
    expect(
      sandbox.createSandboxAgent('Workspace agent', 'Use the computer.')
        .inputGuardrails,
    ).toEqual([]);
  });

  it('builds an agent check, tool results, and names the blocking check', () => {
    const openai = service();
    const checker = openai.createAgent('Homework check', 'Check.', {
      schema: z.object({ isMathHomework: z.boolean() }),
    });
    const guardrail = openai.agentInputGuardrail(
      'Math homework',
      checker,
      (output) => output?.isMathHomework === true,
      { runInParallel: false },
    );

    expect(guardrail.name).toBe('Math homework');
    expect(guardrail.runInParallel).toBe(false);
    expect(openai.allowTool()).toEqual({ behavior: { type: 'allow' } });
    expect(openai.rejectTool('Order id is required.')).toEqual({
      behavior: { type: 'rejectContent', message: 'Order id is required.' },
    });
    expect(openai.stopTool()).toEqual({ behavior: { type: 'throwException' } });
    expect(openai.guardrailTripwire(new Error('other'))).toBeUndefined();
    expect(
      openai.guardrailTripwire(
        new InputGuardrailTripwireTriggered('blocked', {} as never),
      ),
    ).toBe('input');
    expect(
      openai.guardrailTripwire(
        new OutputGuardrailTripwireTriggered('blocked', {} as never),
      ),
    ).toBe('output');
    expect(
      openai.guardrailTripwire(
        new ToolInputGuardrailTripwireTriggered('blocked', {} as never),
      ),
    ).toBe('tool-input');
    expect(
      openai.guardrailTripwire(
        new ToolOutputGuardrailTripwireTriggered('blocked', {} as never),
      ),
    ).toBe('tool-output');
  });

  it('answers one message and names the helper for the next one', async () => {
    const openai = service();
    const frontDesk = new Agent({ name: 'Front desk', instructions: 'Greet.' });
    const orderHelper = new Agent({
      name: 'Order helper',
      instructions: 'Orders.',
    });
    openai.runAgent = async () =>
      ({
        finalOutput: 'Your cake is ready tomorrow.',
        lastAgent: orderHelper,
        lastResponseId: 'resp_cake',
        interruptions: [],
      }) as never;

    const turn = await openai.reply('Where is my birthday cake?', frontDesk, {
      fallback: frontDesk,
    });

    expect(turn.waiting).toBe(false);
    expect(turn.output).toBe('Your cake is ready tomorrow.');
    expect(turn.helper).toBe(orderHelper);
    expect(turn.responseId).toBe('resp_cake');
    expect(turn.agent).toBe(frontDesk);
  });

  it('waits on a pause and finishes when the person says yes', async () => {
    const openai = service();
    const orderHelper = new Agent({
      name: 'Order helper',
      instructions: 'Orders.',
    });
    const state = { approve: vi.fn(), reject: vi.fn() };
    openai.runAgent = async () =>
      ({
        finalOutput: undefined,
        lastAgent: orderHelper,
        lastResponseId: 'resp_paused',
        interruptions: [{}],
        state,
      }) as never;
    openai.resumeAgent = async () =>
      ({
        finalOutput: 'Order 123 is cancelled.',
        lastAgent: orderHelper,
        interruptions: [],
      }) as never;

    const waiting = await openai.reply(
      'Cancel it. It is order 123.',
      orderHelper,
    );

    expect(waiting.waiting).toBe(true);
    expect(waiting.output).toBeUndefined();
    expect(waiting.responseId).toBeUndefined();

    const done = await openai.finish(waiting, 'approve');

    expect(state.approve).toHaveBeenCalledOnce();
    expect(done.waiting).toBe(false);
    expect(done.output).toBe('Order 123 is cancelled.');
  });
});

describe('OpenaiService storage and limits', () => {
  it('does not inherit streaming mode when resuming an approval', async () => {
    const openai = service();
    const agent = new Agent({ name: 'Helper' });
    const state = { toString: () => 'checkpoint' } as unknown as RunState<
      unknown,
      Agent
    >;
    const run = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValueOnce({
        state,
        interruptions: [{}],
        completed: Promise.resolve(),
      } as never)
      .mockResolvedValueOnce({
        state,
        interruptions: [],
        completed: Promise.resolve(),
      } as never);
    try {
      const streamed = await openai.runAgent('hello', agent, { stream: true });
      await streamed.completed;
      await openai.resumeAgent(agent, state);
      expect(run.mock.calls[1][2]?.stream).not.toBe(true);
    } finally {
      run.mockRestore();
    }
  });

  it('stops accepting runs after shutdown', async () => {
    const openai = service();
    const run = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue({} as never);
    try {
      await openai.onModuleDestroy();
      await expect(
        openai.runAgent('hello', new Agent({ name: 'Helper' })),
      ).rejects.toThrow(/shutting down/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it('holds the conversation lock until streaming and persistence finish', async () => {
    const { prisma } = fakePrisma();
    const first = service(prisma);
    const second = service(prisma);
    const agent = new Agent({ name: 'Helper' });
    let end!: () => void;
    const completed = new Promise<void>((resolve) => {
      end = resolve;
    });
    const run = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue({ completed } as never);
    try {
      const stream = await first.runAgent('hello', agent, {
        session: first.createSession('shared'),
        stream: true,
      });
      await expect(
        second.runAgent('overlap', agent, {
          session: second.createSession('shared'),
        }),
      ).rejects.toThrow(/already running/);
      end();
      await stream.completed;
      run.mockResolvedValue({} as never);
      await expect(
        second.runAgent('next', agent, {
          session: second.createSession('shared'),
        }),
      ).resolves.toBeDefined();
    } finally {
      end();
      run.mockRestore();
    }
  });

  it('bounds history at a user-turn boundary without orphan tool output', async () => {
    const openai = service();
    const session = openai.createSession('bounded', { maxItems: 3 });
    await session.addItems([
      { role: 'user', content: 'old' },
      { type: 'function_call', callId: 'c1', name: 'lookup', arguments: '{}' },
      {
        type: 'function_call_result',
        callId: 'c1',
        name: 'lookup',
        output: { type: 'text', text: 'done' },
      },
      { role: 'user', content: 'new' },
    ] as AgentInputItem[]);
    expect(await session.getItems()).toEqual([
      { role: 'user', content: 'new' },
    ]);
  });

  it('leaves a paused run on the response id stored in its state', async () => {
    const openai = service();
    const agent = new Agent({ name: 'Helper' });
    const state = new RunState(new RunContext(), 'Cancel it.', agent, 10);
    state._previousResponseId = 'resp_current';
    const run = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      state,
      interruptions: [],
    } as never);
    try {
      await openai.resumeAgent(agent, state, {
        previousResponseId: 'resp_old',
      });
      expect(run.mock.calls[0]?.[2]?.previousResponseId).toBeUndefined();
    } finally {
      run.mockRestore();
    }
  });

  it('continues from the last OpenAI response instead of replaying the chat', async () => {
    const openai = service();
    const agent = new Agent({ name: 'Helper' });
    const run = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      state: { toString: () => 'done' },
      interruptions: [],
    } as never);
    try {
      await openai.runAgent('It was a birthday cake.', agent, {
        previousResponseId: 'resp_1',
      });
      expect(run).toHaveBeenCalledWith(
        agent,
        'It was a birthday cake.',
        expect.objectContaining({ previousResponseId: 'resp_1' }),
      );
    } finally {
      run.mockRestore();
    }
  });

  it('keeps a chat working after one very big tool result', async () => {
    const session = service().createSession('big-file', { maxBytes: 1_000 });
    const bigResult = {
      type: 'function_call_result',
      callId: 'c1',
      name: 'readMenu',
      output: { type: 'text', text: 'x'.repeat(5_000) },
    };
    await session.addItems([
      { role: 'user', content: 'Read the menu.' },
      bigResult,
    ] as AgentInputItem[]);

    // The current turn is bigger than maxBytes, but it is sent whole instead of failing.
    expect(await session.getItems()).toHaveLength(2);
    await session.addItems([
      { role: 'user', content: 'Any cakes?' },
    ] as AgentInputItem[]);
    // The next turn drops the old big turn to fit.
    expect(await session.getItems()).toEqual([
      { role: 'user', content: 'Any cakes?' },
    ]);
  });

  it('sends a current turn longer than maxItems whole', async () => {
    const session = service().createSession('long-turn', { maxItems: 3 });
    const steps = Array.from({ length: 4 }, (_, index) => ({
      type: 'function_call_result',
      callId: `c${index}`,
      name: 'bake',
      output: { type: 'text', text: 'ok' },
    }));
    await session.addItems([
      { role: 'user', content: 'old' },
      { role: 'user', content: 'Bake 4 cakes.' },
      ...steps,
    ] as AgentInputItem[]);

    expect(await session.getItems()).toEqual([
      { role: 'user', content: 'Bake 4 cakes.' },
      ...steps,
    ]);
    // An explicit limit is still exact, as the SDK expects.
    expect(await session.getItems(2)).toEqual(steps.slice(2));
  });

  it('cancels a saved approval so the chat can move on', async () => {
    const openai = service();
    const agent = new Agent({ name: 'Order helper', instructions: 'Orders.' });
    const state = {
      getInterruptions: () => [{ name: 'cancelOrder' }],
      reject: vi.fn(),
      toString: () => 'paused',
    };
    vi.spyOn(RunState, 'fromString').mockResolvedValue(state as never);
    const run = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      state: { toString: () => 'done' },
      interruptions: [],
    } as never);
    try {
      const id = await openai.saveRun({ state: state as never });
      await openai.cancelRun(agent, id);

      expect(state.reject).toHaveBeenCalledWith(
        { name: 'cancelOrder' },
        expect.objectContaining({
          message: 'Not approved. The request was cancelled.',
        }),
      );
      expect(run).toHaveBeenCalledWith(agent, state, expect.anything());
      await expect(openai.loadRun(agent, id)).rejects.toThrow(
        'already taken or does not exist',
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('preserves cancellation and turn limits through reply', async () => {
    const openai = service();
    const agent = new Agent({ name: 'Helper' });
    const signal = new AbortController().signal;
    const run = vi.spyOn(openai, 'runAgent').mockResolvedValue({} as never);
    await openai.reply('hello', agent, { signal, maxTurns: 2 });
    expect(run).toHaveBeenCalledWith(
      'hello',
      agent,
      expect.objectContaining({ signal, maxTurns: 2 }),
    );
  });

  it('keeps the session and execution policy when finishing an approval', async () => {
    const openai = service();
    const agent = new Agent({ name: 'Helper' });
    const session = openai.createSession('chat');
    const signal = new AbortController().signal;
    const state = { approve: vi.fn() };
    vi.spyOn(openai, 'runAgent').mockResolvedValue({
      state,
      interruptions: [{}],
    } as never);
    const resume = vi
      .spyOn(openai, 'resumeAgent')
      .mockResolvedValue({} as never);
    const turn = await openai.reply('hello', agent, {
      session,
      signal,
      maxTurns: 2,
      websocket: true,
    });
    await openai.finish(turn, 'approve');
    expect(resume).toHaveBeenCalledWith(
      agent,
      state,
      expect.objectContaining({
        session,
        signal,
        maxTurns: 2,
        websocket: true,
      }),
    );
  });

  const message = (text: string) =>
    ({ role: 'user', content: text }) as AgentInputItem;

  it('keeps a chat in the database and reopens it by id', async () => {
    const { db, prisma } = fakePrisma();
    const chat = service(prisma).createSession('chat-c-42');
    await chat.addItems([
      message('I ordered a cake.'),
      message('Is it ready?'),
    ]);

    const reopened = service(prisma).createSession('chat-c-42');

    expect(await reopened.getSessionId()).toBe('chat-c-42');
    expect(await reopened.getItems()).toEqual([
      message('I ordered a cake.'),
      message('Is it ready?'),
    ]);
    expect(await reopened.getItems(1)).toEqual([message('Is it ready?')]);
    expect(await reopened.popItem()).toEqual(message('Is it ready?'));
    expect(await reopened.getItems()).toEqual([message('I ordered a cake.')]);

    expect(db.chat.rows).toMatchObject([{ id: 'chat-c-42' }]);
    await reopened.clearSession();
    expect(await reopened.getItems()).toEqual([]);
    expect(db.chat.rows).toEqual([]);
    expect(db.chatItem.rows).toEqual([]);
    expect(await service(prisma).createSession('other').getItems()).toEqual([]);
  });

  it('gives each new chat its own id', async () => {
    const openai = service();
    const first = await openai.createSession().getSessionId();
    const second = await openai.createSession().getSessionId();

    expect(first).not.toBe(second);
  });

  it('loading a saved approval never consumes it before execution', async () => {
    const { db, prisma } = fakePrisma();
    const openai = service(prisma);
    const agent = new Agent({ name: 'Order helper', instructions: 'Orders.' });
    const loaded = { loaded: true } as unknown as RunState<unknown, Agent>;
    const fromString = vi
      .spyOn(RunState, 'fromString')
      .mockResolvedValue(loaded);

    const id = await openai.saveRun({
      state: { toString: () => 'paused' } as unknown as RunState<
        unknown,
        Agent
      >,
    });

    const attempts = await Promise.allSettled([
      openai.loadRun(agent, id),
      openai.loadRun(agent, id),
    ]);

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    expect(fromString).toHaveBeenCalledWith(agent, 'paused');
    expect(db.pausedRun.rows[0]).toMatchObject({ status: 'waiting' });
    fromString.mockRestore();
  });

  it('records ambiguous execution and requires reconciliation before retry', async () => {
    const { db, prisma } = fakePrisma();
    const openai = service(prisma);
    const agent = new Agent({ name: 'Helper' });
    const state = { toString: () => 'checkpoint' } as unknown as RunState<
      unknown,
      Agent
    >;
    const decode = vi.spyOn(RunState, 'fromString').mockResolvedValue(state);
    const run = vi
      .spyOn(Runner.prototype, 'run')
      .mockRejectedValue(new Error('connection lost'));
    try {
      const id = await openai.saveRun({ state });
      const loaded = await openai.loadRun(agent, id);
      await expect(openai.resumeAgent(agent, loaded)).rejects.toThrow(
        'connection lost',
      );
      expect(db.pausedRun.rows[0]).toMatchObject({
        status: 'recovery_required',
        state: 'checkpoint',
      });
      await expect(openai.loadRun(agent, id)).rejects.toThrow(/reconcil/i);
      await openai.recoverRun(agent, id, {
        note: 'Provider confirmed that the idempotent operation may be retried.',
      });
      expect(db.pausedRun.rows[0]).toMatchObject({ status: 'waiting' });
    } finally {
      decode.mockRestore();
      run.mockRestore();
    }
  });

  it('restores persisted chat options and refuses a stale second resume', async () => {
    const { db, prisma } = fakePrisma();
    const openai = service(prisma);
    const agent = new Agent({ name: 'Helper' });
    const makeState = () =>
      ({ toString: () => 'checkpoint' }) as unknown as RunState<unknown, Agent>;
    const decode = vi
      .spyOn(RunState, 'fromString')
      .mockImplementation(async () => makeState());
    const run = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      state: makeState(),
      interruptions: [],
      finalOutput: 'done',
    } as never);
    try {
      const id = await openai.saveRun(
        { state: makeState() },
        { session: openai.createSession('persisted-chat'), maxTurns: 3 },
      );
      const first = await openai.loadRun(agent, id);
      const stale = await openai.loadRun(agent, id);
      await openai.resumeAgent(agent, first);
      expect(run).toHaveBeenCalledWith(
        agent,
        first,
        expect.objectContaining({
          maxTurns: 3,
          session: expect.objectContaining({ chatId: 'persisted-chat' }),
        }),
      );
      expect(db.pausedRun.rows[0]).toMatchObject({ status: 'completed' });
      await expect(openai.resumeAgent(agent, stale)).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      decode.mockRestore();
      run.mockRestore();
    }
  });

  it('keeps a saved run waiting when it does not fit the agent', async () => {
    const { db, prisma } = fakePrisma();
    const openai = service(prisma);
    const agent = new Agent({ name: 'Menu helper', instructions: 'Menu.' });
    const fromString = vi
      .spyOn(RunState, 'fromString')
      .mockRejectedValue(new Error('Wrong agent.'));
    const id = await openai.saveRun({
      state: { toString: () => 'paused' } as unknown as RunState<
        unknown,
        Agent
      >,
    });

    await expect(openai.loadRun(agent, id)).rejects.toThrow('Wrong agent.');
    expect(db.pausedRun.rows[0]).toMatchObject({ status: 'waiting' });
    fromString.mockRestore();
  });

  it('refuses a saved run id that is not a UUID', async () => {
    const { db, prisma } = fakePrisma();
    const transaction = vi.spyOn(db, '$transaction');
    const agent = new Agent({ name: 'Order helper', instructions: 'Orders.' });

    await expect(service(prisma).loadRun(agent, 'order-42')).rejects.toThrow(
      'This paused run was already taken or does not exist.',
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('sends one prompt cache key per chat and keeps the agent settings', async () => {
    const run = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue({} as never);
    const openai = service();
    const agent = new Agent({
      name: 'Menu helper',
      instructions: 'Menu.',
      modelSettings: { providerData: { metadata: { shop: 'sunny' } } },
    });
    try {
      await openai.runAgent('Any cakes?', agent, {
        session: openai.createSession('chat-c-42'),
      });
      await openai.runAgent('Any bread?', agent, {
        promptCacheKey: 'customer-7',
      });
      await openai.runAgent('Hello.', agent);

      const sent = run.mock.contexts.map(
        (runner) =>
          (runner as unknown as { config: RunConfig }).config.modelSettings
            ?.providerData,
      );
      expect(sent).toEqual([
        { metadata: { shop: 'sunny' }, prompt_cache_key: 'chat-c-42' },
        { metadata: { shop: 'sunny' }, prompt_cache_key: 'customer-7' },
        undefined,
      ]);
    } finally {
      run.mockRestore();
    }
  });

  it('passes signal and maxTurns to the run', async () => {
    const run = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue({} as never);
    const controller = new AbortController();
    const signal = controller.signal;
    const agent = new Agent({ name: 'Order helper', instructions: 'Orders.' });

    await service().runAgent('Where is my order?', agent, {
      signal,
      maxTurns: 3,
    });

    expect(run).toHaveBeenCalledWith(
      agent,
      'Where is my order?',
      expect.objectContaining({ signal: expect.any(AbortSignal), maxTurns: 3 }),
    );
    const forwarded = run.mock.calls[0][2]?.signal;
    controller.abort();
    expect(forwarded?.aborted).toBe(true);
    run.mockRestore();
  });

  it('names each turn and groups it by the chat', async () => {
    const openai = service();
    const agent = new Agent({
      name: 'Menu helper',
      instructions: 'Menu.',
      model: 'gpt-6-astra',
    });
    const session = openai.createSession('chat-c-42');
    const run = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      interruptions: [],
      finalOutput: 'Tomorrow.',
    } as never);
    try {
      await openai.runAgent('Where is my order?', agent, {
        session,
        userId: 'user-7',
      });
      expect(run.mock.calls[0]?.[2]).toMatchObject({
        workflowName: 'agent-turn',
        groupId: 'chat-c-42',
        traceMetadata: {
          agent: 'Menu helper',
          user_id: 'user-7',
          model: 'gpt-6-astra',
        },
      });
    } finally {
      run.mockRestore();
    }
  });

  it('attaches hosted and private MCP servers', () => {
    const openai = service();
    const hosted = openai.hostedMcp({
      serverLabel: 'git',
      serverUrl: 'https://example.com/mcp',
    });
    const remote = openai.httpMcp({
      url: 'https://example.com/mcp',
      name: 'files',
    });
    const local = openai.stdioMcp({ command: 'echo', name: 'files' });

    expect(hosted.name).toBe('hosted_mcp');
    expect(remote.name).toBe('files');
    expect(local.name).toBe('files');
    expect(
      openai.createAgent('Files', 'Read files.', { mcpServers: [remote] })
        .mcpServers,
    ).toEqual([remote]);
  });

  it('makes the helper wait for a message check unless told otherwise', () => {
    const openai = service();
    const check = async () => ({ tripwireTriggered: false, outputInfo: null });

    expect(openai.inputGuardrail('Bakery only', check).runInParallel).toBe(
      false,
    );
    expect(
      openai.inputGuardrail('Bakery only', check, { runInParallel: true })
        .runInParallel,
    ).toBe(true);
  });
});
