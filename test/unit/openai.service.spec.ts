import { ConfigService } from '@nestjs/config';
import {
  Agent,
  type AgentInputItem,
  getHandoff,
  handoff,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  Runner,
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
        interruptions: [],
      }) as never;

    const turn = await openai.reply('Where is my birthday cake?', frontDesk, {
      fallback: frontDesk,
    });

    expect(turn.waiting).toBe(false);
    expect(turn.output).toBe('Your cake is ready tomorrow.');
    expect(turn.helper).toBe(orderHelper);
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

    const done = await openai.finish(waiting, 'approve');

    expect(state.approve).toHaveBeenCalledOnce();
    expect(done.waiting).toBe(false);
    expect(done.output).toBe('Order 123 is cancelled.');
  });
});

describe('OpenaiService storage and limits', () => {
  const message = (text: string) =>
    ({ role: 'user', content: text }) as AgentInputItem;

  it('keeps a chat in the database and reopens it by id', async () => {
    const { prisma } = fakePrisma();
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

    await reopened.clearSession();
    expect(await reopened.getItems()).toEqual([]);
    expect(await service(prisma).createSession('other').getItems()).toEqual([]);
  });

  it('gives each new chat its own id', async () => {
    const openai = service();
    const first = await openai.createSession().getSessionId();
    const second = await openai.createSession().getSessionId();

    expect(first).not.toBe(second);
  });

  it('lets a saved run be taken only once', async () => {
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
      'rejected',
    ]);
    expect(fromString).toHaveBeenCalledWith(agent, 'paused');
    expect(db.pausedRun.rows[0]).toMatchObject({ status: 'taken' });
    fromString.mockRestore();
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

  it('passes signal and maxTurns to the run', async () => {
    const run = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue({} as never);
    const signal = new AbortController().signal;
    const agent = new Agent({ name: 'Order helper', instructions: 'Orders.' });

    await service().runAgent('Where is my order?', agent, {
      signal,
      maxTurns: 3,
    });

    expect(run).toHaveBeenCalledWith(
      agent,
      'Where is my order?',
      expect.objectContaining({ signal, maxTurns: 3 }),
    );
    run.mockRestore();
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
