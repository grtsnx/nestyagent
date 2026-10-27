import { ConfigService } from '@nestjs/config';
import {
  Agent,
  handoff,
  OpenAIProvider,
  setTraceProcessors,
  setTracingDisabled,
  Usage,
  type Model,
  type TracingProcessor,
} from '@openai/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenaiService } from '@/lib/openai/openai.service.js';
import { fakePrisma } from './fake-prisma.js';

setTracingDisabled(true);
afterEach(() => {
  vi.restoreAllMocks();
  setTracingDisabled(true);
});

const answer = (text = 'Done.') => ({
  usage: new Usage(),
  output: [
    {
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'completed' as const,
      content: [{ type: 'output_text' as const, text }],
    },
  ],
});

describe('real SDK request policies', () => {
  it('preserves leading system context when history fits the budget', async () => {
    const openai = new OpenaiService(new ConfigService(), fakePrisma().prisma);
    const session = openai.createSession('system-context');
    await session.addItems([
      { role: 'system', content: 'Keep customer context.' },
      { role: 'user', content: 'Old question.' },
      answer().output[0],
    ]);
    let received: unknown;
    const model: Model = {
      async getResponse(request) {
        received = request.input;
        return answer();
      },
      getStreamedResponse() {
        throw new Error('Unused stream');
      },
    };
    await openai.runAgent(
      'New question.',
      new Agent({ name: 'Helper', model }),
      { session },
    );
    expect(JSON.stringify(received)).toContain('Keep customer context.');
    await openai.onModuleDestroy();
  });
  it('keeps a workflow trace open until a returned stream completes', async () => {
    const ended = vi.fn();
    setTraceProcessors([
      {
        onTraceStart: async () => {},
        onTraceEnd: ended,
        onSpanStart: async () => {},
        onSpanEnd: async () => {},
        shutdown: async () => {},
        forceFlush: async () => {},
      },
    ]);
    setTracingDisabled(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: Model = {
      async getResponse() {
        return answer();
      },
      async *getStreamedResponse() {
        yield { type: 'response_started' as const };
        await gate;
        yield {
          type: 'response_done' as const,
          response: { ...answer(), id: 'response-1' },
        };
      },
    };
    const openai = new OpenaiService(new ConfigService(), fakePrisma().prisma);
    const stream = await openai.traceWorkflow('stream-workflow', () =>
      openai.runAgent('Stream.', new Agent({ name: 'Helper', model }), {
        stream: true,
      }),
    );
    try {
      expect(ended).not.toHaveBeenCalled();
    } finally {
      release();
      for await (const _event of stream) {
        /* Drain the real SDK stream. */
      }
      await stream.completed;
      await openai.onModuleDestroy();
    }
    expect(ended).toHaveBeenCalledTimes(1);
  });
  it.each(['run', 'workflow'])(
    'ends the owned trace when a %s fails',
    async (kind) => {
      const ended = vi.fn();
      const processor: TracingProcessor = {
        onTraceStart: async () => {},
        onTraceEnd: ended,
        onSpanStart: async () => {},
        onSpanEnd: async () => {},
        shutdown: async () => {},
        forceFlush: async () => {},
      };
      setTraceProcessors([processor]);
      setTracingDisabled(false);
      const openai = new OpenaiService(
        new ConfigService(),
        fakePrisma().prisma,
      );
      const model: Model = {
        async getResponse() {
          throw new Error('Injected model failure');
        },
        getStreamedResponse() {
          throw new Error('Unused stream');
        },
      };
      const run = () =>
        openai.runAgent('Fail safely.', new Agent({ name: 'Helper', model }));
      await expect(
        kind === 'workflow' ? openai.traceWorkflow('workflow', run) : run(),
      ).rejects.toThrow('Injected model failure');
      expect(ended).toHaveBeenCalledTimes(1);
      await openai.onModuleDestroy();
    },
  );
  it('keeps the cache key and each specialist provider settings through a handoff', async () => {
    const requests: Array<{ model: string | undefined; settings: unknown }> =
      [];
    vi.spyOn(OpenAIProvider.prototype, 'getModel').mockImplementation(
      async (model) => ({
        async getResponse(request) {
          requests.push({
            model,
            settings: request.modelSettings.providerData,
          });
          return requests.length === 1
            ? {
                usage: new Usage(),
                output: [
                  {
                    type: 'function_call',
                    callId: 'handoff-1',
                    name: 'transfer_to_specialist',
                    arguments: '{}',
                  },
                ],
              }
            : answer();
        },
        getStreamedResponse() {
          throw new Error('Unused stream');
        },
      }),
    );
    const openai = new OpenaiService(
      new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
      fakePrisma().prisma,
    );
    const specialist = new Agent({
      name: 'Specialist',
      model: 'gpt-5.6-terra',
      modelSettings: { providerData: { metadata: { agent: 'specialist' } } },
    });
    const frontDesk = new Agent({
      name: 'Front desk',
      model: 'gpt-6-astra',
      handoffs: [
        handoff(specialist, { toolNameOverride: 'transfer_to_specialist' }),
      ],
      modelSettings: { providerData: { metadata: { agent: 'front' } } },
    });
    await openai.runAgent('Ask the specialist.', frontDesk, {
      promptCacheKey: 'customer-42',
    });
    expect(requests).toEqual([
      {
        model: 'gpt-6-astra',
        settings: {
          metadata: { agent: 'front' },
          prompt_cache_key: 'customer-42',
        },
      },
      {
        model: 'gpt-5.6-terra',
        settings: {
          metadata: { agent: 'specialist' },
          prompt_cache_key: 'customer-42',
        },
      },
    ]);
    await openai.onModuleDestroy();
  });

  it.each([{ maxBytes: 1000 }, { maxItems: 2 }])(
    'drops an oversized completed turn before the new input (%j)',
    async (limits) => {
      const openai = new OpenaiService(
        new ConfigService(),
        fakePrisma().prisma,
      );
      const session = openai.createSession('history-regression', limits);
      await session.addItems([
        { role: 'user', content: 'Old question.' },
        answer('x'.repeat(5000)).output[0],
        answer('Old answer.').output[0],
      ]);
      let received: unknown;
      const model: Model = {
        async getResponse(request) {
          received = request.input;
          return answer();
        },
        getStreamedResponse() {
          throw new Error('Unused stream');
        },
      };
      await openai.runAgent(
        'New question.',
        new Agent({ name: 'Helper', model }),
        { session },
      );
      expect(JSON.stringify(received)).not.toContain('Old question.');
      expect(JSON.stringify(received)).not.toContain('xxxxx');
      expect(JSON.stringify(received)).toContain('New question.');
      expect(await session.getItems(4)).toHaveLength(4);
      await openai.onModuleDestroy();
    },
  );
});
