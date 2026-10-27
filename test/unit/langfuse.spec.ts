import { ConfigService } from '@nestjs/config';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import {
  Agent,
  handoff,
  OpenAIProvider,
  RunState,
  setTraceProcessors,
  setTracingDisabled,
  Usage,
  tool,
  type Model,
} from '@openai/agents';
import { z } from 'zod';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import {
  LangfuseService,
  planObservations,
  type AgentTraceItem,
  type TurnNote,
} from '@/lib/langfuse/langfuse.service.js';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { fakePrisma } from './fake-prisma.js';

const trace = {
  type: 'trace' as const,
  traceId: 'trace_1',
  name: 'agent-turn',
  groupId: 'chat-c-42',
  metadata: { agent: 'Menu helper', model: 'gpt-6-astra', request_id: 'req-1' },
};

describe('LangfuseService', () => {
  it.each([false, true])(
    'automatically publishes a failed restored approval trace (stream: %s)',
    async (stream) => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      setLangfuseTracerProvider(provider);
      const service = new LangfuseService(
        new ConfigService({ NODE_ENV: 'development', LANGFUSE_ENABLED: true }),
      );
      const openai = new OpenaiService(
        new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
        fakePrisma().prisma,
        service,
      );
      let calls = 0;
      const getModel = vi
        .spyOn(OpenAIProvider.prototype, 'getModel')
        .mockImplementation(async () => ({
          async getResponse() {
            if (calls++ > 0) throw new Error('Resumed model failure');
            return {
              usage: answer('').usage,
              output: [
                {
                  type: 'function_call' as const,
                  callId: 'approval-1',
                  name: 'approve_order',
                  arguments: '{}',
                },
              ],
            };
          },
          async *getStreamedResponse() {
            yield { type: 'response_started' as const };
            throw new Error('Resumed model failure');
          },
        }));
      setTraceProcessors([service]);
      setTracingDisabled(false);
      try {
        const agent = new Agent({
          name: 'Order helper',
          model: 'gpt-order',
          tools: [
            tool({
              name: 'approve_order',
              description: 'This tool approves the requested order.',
              parameters: z.object({}),
              needsApproval: true,
              execute: async () => 'Approved',
            }),
          ],
        });
        const paused = await openai.runAgent('Approve my order.', agent);
        expect(paused.interruptions).toHaveLength(1);
        await service.forceFlush();
        exporter.reset();
        const restored = await RunState.fromString(
          agent,
          paused.state.toString(),
        );
        openai.approve({ state: restored });
        if (stream) {
          const streamed = await openai.resumeAgent(agent, restored, {
            stream: true,
          });
          await expect(streamed.completed).rejects.toThrow(
            'Resumed model failure',
          );
        } else {
          await expect(openai.resumeAgent(agent, restored)).rejects.toThrow(
            'Resumed model failure',
          );
        }

        // The trace must publish by its normal lifecycle, without shutdown or manual flushing.
        await vi.waitFor(
          () =>
            expect(
              exporter
                .getFinishedSpans()
                .some(
                  (span) =>
                    span.attributes['langfuse.observation.level'] === 'ERROR',
                ),
            ).toBe(true),
          { timeout: 300 },
        );
        expect(
          exporter
            .getFinishedSpans()
            .find((span) => span.name === 'generate-response')?.attributes[
            'langfuse.observation.model.name'
          ],
        ).toBe('gpt-order');
        expect(service).toMatchObject({
          notes: new Map(),
          pending: new Map(),
          timers: new Map(),
        });
      } finally {
        getModel.mockRestore();
        await openai.onModuleDestroy();
        setTracingDisabled(true);
        setTraceProcessors([]);
        await provider.shutdown();
        setLangfuseTracerProvider(null);
      }
    },
  );

  it.each([false, true])(
    'exports the actual model and exclusive token usage after a real SDK handoff (custom model: %s)',
    async (custom) => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      setLangfuseTracerProvider(provider);
      const service = new LangfuseService(
        new ConfigService({ NODE_ENV: 'development', LANGFUSE_ENABLED: true }),
      );
      const openai = new OpenaiService(
        new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
        fakePrisma().prisma,
        service,
      );
      const getModel = vi
        .spyOn(OpenAIProvider.prototype, 'getModel')
        .mockImplementation(async (model) => ({
          async getResponse() {
            if (model === 'gpt-front')
              return {
                usage: answer('').usage,
                output: [
                  {
                    type: 'function_call' as const,
                    callId: 'handoff-1',
                    name: 'transfer_to_specialist',
                    arguments: '{}',
                  },
                ],
              };
            return answer('Specialist answer');
          },
          getStreamedResponse() {
            throw new Error('Unused stream');
          },
        }));
      setTraceProcessors([service]);
      setTracingDisabled(false);
      try {
        let customCalls = 0;
        const customModel: Model = {
          async getResponse() {
            return customCalls++ === 0
              ? {
                  usage: answer('').usage,
                  output: [
                    {
                      type: 'function_call',
                      callId: 'lookup-1',
                      name: 'lookup_order',
                      arguments: '{}',
                    },
                  ],
                }
              : answer('Specialist answer');
          },
          getStreamedResponse() {
            throw new Error('Unused stream');
          },
        };
        const specialist = new Agent({
          name: 'Specialist',
          model: custom ? customModel : 'gpt-specialist',
          tools: [
            tool({
              name: 'lookup_order',
              description: 'This tool returns the requested order.',
              parameters: z.object({}),
              execute: async () => 'Found',
            }),
          ],
        });
        const front = new Agent({
          name: 'Front desk',
          model: 'gpt-front',
          handoffs: [
            handoff(specialist, { toolNameOverride: 'transfer_to_specialist' }),
          ],
        });
        await openai.runAgent('Ask the specialist.', front);
        await service.forceFlush();

        const spans = exporter.getFinishedSpans();
        const generations = spans.filter(
          (item) =>
            item.attributes['langfuse.observation.type'] === 'generation',
        );
        expect(
          generations.map(
            (item) => item.attributes['langfuse.observation.model.name'],
          ),
        ).toEqual(
          custom
            ? ['gpt-front', undefined, undefined]
            : ['gpt-front', 'gpt-specialist'],
        );
        expect(
          new Set(spans.map((item) => item.spanContext().traceId)).size,
        ).toBe(1);
        for (const generation of generations) {
          expect(
            JSON.parse(
              generation.attributes[
                'langfuse.observation.usage_details'
              ] as string,
            ),
          ).toEqual({ input: 9, output: 4, input_cached_tokens: 3 });
        }
        expect(
          spans.find((item) => item.name === 'run-agent')?.attributes[
            'langfuse.observation.output'
          ],
        ).toBe('Specialist answer');
      } finally {
        getModel.mockRestore();
        await openai.onModuleDestroy();
        setTracingDisabled(true);
        setTraceProcessors([]);
        await provider.shutdown();
        setLangfuseTracerProvider(null);
      }
    },
  );

  it.each(['concurrent', 'sequential'])(
    'keeps %s runs in one workflow with separate input, output, and model',
    async (mode) => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      setLangfuseTracerProvider(provider);
      const service = new LangfuseService(
        new ConfigService({ NODE_ENV: 'development', LANGFUSE_ENABLED: true }),
      );
      const openai = new OpenaiService(
        new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
        fakePrisma().prisma,
        service,
      );
      const getModel = vi
        .spyOn(OpenAIProvider.prototype, 'getModel')
        .mockImplementation(async (name) => ({
          async getResponse() {
            return answer(`${name?.replace('-model', '')} answer`);
          },
          getStreamedResponse() {
            throw new Error('Unused stream');
          },
        }));
      setTraceProcessors([service]);
      setTracingDisabled(false);
      try {
        await openai.traceWorkflow('compare-agents', async () => {
          await openai.span('prepare-agents', async () => undefined);
          const run = (name: string) =>
            openai.runAgent(
              `${name} question`,
              new Agent({ name, model: `${name}-model` }),
              { groupId: 'shared-session' },
            );
          const names = ['first', 'second'];
          if (mode === 'concurrent') await Promise.all(names.map(run));
          else for (const name of names) await run(name);
        });
        await service.forceFlush();

        const spans = exporter.getFinishedSpans();
        expect(
          new Set(spans.map((item) => item.spanContext().traceId)).size,
        ).toBe(1);
        const root = spans.find((item) => item.name === 'compare-agents');
        expect(root).toBeDefined();
        expect(root?.attributes['langfuse.trace.name']).toBe('compare-agents');
        expect(root?.attributes['session.id']).toBe('shared-session');
        for (const name of ['first', 'second']) {
          const task = spans.find(
            (item) =>
              item.name === 'run-agent' &&
              item.attributes['langfuse.observation.metadata.agent'] ===
                JSON.stringify(name),
          );
          expect(task?.attributes['langfuse.observation.input']).toBe(
            `${name} question`,
          );
          expect(task?.attributes['langfuse.observation.output']).toBe(
            `${name} answer`,
          );
          expect(task?.parentSpanContext?.spanId).toBe(
            root?.spanContext().spanId,
          );
          expect(
            task?.attributes['langfuse.trace.metadata.agent'],
          ).toBeUndefined();
          const generation = spans.find(
            (item) =>
              item.attributes['langfuse.observation.model.name'] ===
              `${name}-model`,
          );
          const agent = spans.find((item) => item.name === name);
          expect(agent?.parentSpanContext?.spanId).toBe(
            task?.spanContext().spanId,
          );
          expect(generation?.parentSpanContext?.spanId).toBe(
            agent?.spanContext().spanId,
          );
          expect(generation?.attributes['langfuse.observation.input']).toBe(
            `${name} question`,
          );
        }
        const count = spans.length;
        await service.forceFlush();
        expect(exporter.getFinishedSpans()).toHaveLength(count);
      } finally {
        getModel.mockRestore();
        await openai.onModuleDestroy();
        setTracingDisabled(true);
        setTraceProcessors([]);
        await provider.shutdown();
        setLangfuseTracerProvider(null);
      }
    },
  );

  it('keeps the real duration and parent of each step', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    setLangfuseTracerProvider(provider);
    const service = new LangfuseService(new ConfigService({}));
    try {
      await service.onSpanEnd({
        ...span('span_task', null, { type: 'task', name: 'run' }),
        startedAt: '2026-10-27T09:00:00.000Z',
        endedAt: '2026-10-27T09:00:03.000Z',
      } as never);
      await service.onSpanEnd({
        ...span('span_tool', 'span_task', {
          type: 'function',
          name: 'checkOven',
          input: '',
          output: '',
        }),
        startedAt: '2026-10-27T09:00:01.000Z',
        endedAt: '2026-10-27T09:00:01.250Z',
      } as never);
      await service.onTraceEnd(trace as never);
      await service.forceFlush();

      const spans = exporter.getFinishedSpans();
      const tool = spans.find((item) => item.name === 'checkOven');
      const task = spans.find((item) => item.name === 'run-agent');
      const millis = (time: [number, number]) =>
        time[0] * 1_000 + time[1] / 1e6;
      expect(millis(tool!.endTime) - millis(tool!.startTime)).toBe(250);
      expect(millis(task!.endTime) - millis(task!.startTime)).toBe(3_000);
      expect(tool!.parentSpanContext?.spanId).toBe(task!.spanContext().spanId);
    } finally {
      await provider.shutdown();
      setLangfuseTracerProvider(null);
    }
  });
});

function answer(text: string) {
  return {
    usage: new Usage({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      inputTokensDetails: [{ cached_tokens: 3 }],
    }),
    output: [
      {
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'completed' as const,
        content: [{ type: 'output_text' as const, text }],
      },
    ],
  };
}

describe('LangfuseService shutdown', () => {
  it('stops cleanly when Langfuse is unreachable', async () => {
    const service = new LangfuseService(new ConfigService({}));
    const flush = vi
      .spyOn(service, 'forceFlush')
      .mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    flush.mockRestore();
  });
});

describe('planObservations', () => {
  it('records one agent turn with a generation, a tool, and the chat session', () => {
    const items: AgentTraceItem[] = [
      trace,
      span('task', null, {
        type: 'task',
        name: 'agent-turn',
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          requests: 1,
          total_tokens: 16,
        },
      }),
      span('agent', 'task', { type: 'agent', name: 'Menu helper' }),
      span('turn', 'agent', {
        type: 'turn',
        turn: 1,
        agent_name: 'Menu helper',
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cached_input_tokens: 3,
          cache_write_input_tokens: 0,
        },
      }),
      span('tool', 'agent', {
        type: 'function',
        name: 'bakery_hours',
        input: '',
        output: '',
      }),
    ];

    const planned = planObservations(items, note());

    expect(planned.map((item) => [item.name, item.asType])).toEqual([
      ['run-agent', 'span'],
      ['Menu helper', 'agent'],
      ['generate-response', 'generation'],
      ['bakery_hours', 'tool'],
    ]);
    const root = planned[0];
    expect(root?.input).toBe('Where is my order?');
    expect(root?.output).toBe('It ships tomorrow.');
    expect(root?.sessionId).toBe('chat-c-42');
    expect(root?.userId).toBe('user-7');
    expect(root?.tags).toEqual(['agent']);
    expect(root?.metadata).toMatchObject({
      agent: 'Menu helper',
      request_id: 'req-1',
    });
    const generation = planned[2];
    expect(generation?.model).toBe('gpt-6-astra');
    expect(generation?.usageDetails).toEqual({
      input: 9,
      output: 4,
      input_cached_tokens: 3,
    });
    expect(generation?.parentSpanId).toBe('agent');
    expect(planned[3]?.parentSpanId).toBe('agent');
  });

  it('uses each run note and the actual model after a handoff', () => {
    const notes = note();
    notes.set('first-task', {
      ...notes.get('trace_1')!,
      input: 'First question',
      output: 'First answer',
    });
    notes.set('second-task', {
      ...notes.get('trace_1')!,
      input: 'Second question',
      output: 'Second answer',
      model: 'gpt-second',
    });
    notes.set('handoff-turn', { model: 'gpt-handoff' });
    notes.set('unknown-turn', { model: undefined });
    const planned = planObservations(
      [
        trace,
        span('first-task', null, { type: 'task', name: 'first' }),
        span('first-turn', 'first-task', {
          type: 'turn',
          turn: 1,
          agent_name: 'Menu helper',
        }),
        span('handoff-turn', 'first-task', {
          type: 'turn',
          turn: 2,
          agent_name: 'Handoff helper',
        }),
        span('unknown-turn', 'first-task', {
          type: 'turn',
          turn: 3,
          agent_name: 'Custom model helper',
        }),
        span('second-task', null, { type: 'task', name: 'second' }),
        span('second-turn', 'second-task', {
          type: 'turn',
          turn: 1,
          agent_name: 'Menu helper',
        }),
      ],
      notes,
    );

    expect(planned.find((item) => item.spanId === 'first-task')).toMatchObject({
      input: 'First question',
      output: 'First answer',
    });
    expect(planned.find((item) => item.spanId === 'second-task')).toMatchObject(
      { input: 'Second question', output: 'Second answer' },
    );
    expect(planned.find((item) => item.spanId === 'second-turn')).toMatchObject(
      { input: 'Second question', model: 'gpt-second' },
    );
    expect(
      planned.find((item) => item.spanId === 'handoff-turn'),
    ).toMatchObject({ model: 'gpt-handoff' });
    expect(
      planned.find((item) => item.spanId === 'unknown-turn')?.model,
    ).toBeUndefined();
  });

  it('types guardrails, handoffs, and mcp listings without copying audio or secrets', () => {
    const planned = planObservations(
      [
        trace,
        span('guard', null, {
          type: 'guardrail',
          name: 'Math homework',
          triggered: true,
        }),
        span('move', null, {
          type: 'handoff',
          from_agent: 'Front desk',
          to_agent: 'Order helper',
        }),
        span('mcp', null, {
          type: 'mcp_tools',
          server: 'git',
          result: ['search'],
        }),
        span('audio', null, {
          type: 'transcription',
          input: { data: 'raw-pcm', format: 'pcm' },
          output: 'hello',
        }),
      ],
      note(),
    );

    expect(planned.map((item) => [item.name, item.asType])).toEqual([
      ['Math homework', 'guardrail'],
      ['handoff', 'chain'],
      ['list-mcp-tools', 'tool'],
      ['transcribe-audio', 'span'],
    ]);
    expect(planned[1]?.metadata).toMatchObject({
      from_agent: 'Front desk',
      to_agent: 'Order helper',
    });
    expect(JSON.stringify(planned[3])).not.toContain('raw-pcm');
  });

  it('marks a failed step as an error and keeps a caller span name', () => {
    const planned = planObservations(
      [
        trace,
        {
          ...span('claim', null, {
            type: 'custom',
            name: 'claim-approval',
            data: { run: 'paused' },
          }),
          error: { message: 'Error in agent run' },
        },
      ],
      note(),
    );

    expect(planned[0]).toMatchObject({
      name: 'claim-approval',
      asType: 'span',
      level: 'ERROR',
      statusMessage: 'Error in agent run',
      metadata: { run: 'paused' },
    });
  });
});

function note(): Map<string, TurnNote> {
  return new Map([
    [
      'trace_1',
      {
        input: 'Where is my order?',
        output: 'It ships tomorrow.',
        sessionId: 'chat-c-42',
        userId: 'user-7',
        requestId: 'req-1',
        model: 'gpt-6-astra',
        agent: 'Menu helper',
      },
    ],
  ]);
}

function span(
  spanId: string,
  parentId: string | null,
  spanData: AgentTraceItem & { type: 'trace.span' } extends never
    ? never
    : Extract<AgentTraceItem, { type: 'trace.span' }>['spanData'],
): Extract<AgentTraceItem, { type: 'trace.span' }> {
  return {
    type: 'trace.span',
    traceId: 'trace_1',
    spanId,
    parentId,
    spanData,
    error: null,
    startedAt: '2026-10-27T09:00:00.000Z',
    endedAt: '2026-10-27T09:00:02.500Z',
  };
}
