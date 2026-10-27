import { ConfigService } from '@nestjs/config';
import {
  Agent,
  getHandoff,
  handoff,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  RunState,
  RunToolApprovalItem,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '@openai/agents';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { SandboxService } from '@/lib/sandbox/sandbox.service.js';

function service() {
  return new OpenaiService({
    getOrThrow: () => 'sk-test',
  } as unknown as ConfigService);
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

    expect(check.runInParallel).toBeUndefined();
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
    expect(openai.saveRun(result)).toBe('saved-run');
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
});
