import { ConfigService } from '@nestjs/config';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
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
} from '@/lib/langfuse/langfuse.service.js';

const trace = {
  type: 'trace' as const,
  traceId: 'trace_1',
  name: 'agent-turn',
  groupId: 'chat-c-42',
  metadata: { agent: 'Menu helper', model: 'gpt-6-astra', request_id: 'req-1' },
};

describe('LangfuseService', () => {
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
      input: 12,
      output: 4,
      cache_read_input_tokens: 3,
    });
    expect(generation?.parentSpanId).toBe('agent');
    expect(planned[3]?.parentSpanId).toBe('agent');
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

function note() {
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
