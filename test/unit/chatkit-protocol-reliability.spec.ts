import {
  Agent,
  OpenAIChatCompletionsModel,
  run,
  setTracingDisabled,
  tool,
  Usage,
  type Model,
} from '@openai/agents';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  AgentContext,
  ChatKitService,
  clientTool,
  clientToolStopBehavior,
  diffWidget,
  InvalidRequestError,
  MemoryStore,
  parseRequest,
  serialize,
  streamAgentResponse,
  type ThreadMetadata,
  type ThreadStreamEvent,
  type UserMessageItem,
  type WidgetRoot,
} from '@/lib/chatkit/chatkit.service.js';
import { scriptedModel } from './chatkit-model.js';

setTracingDisabled(true);
const thread: ThreadMetadata = {
  id: 'thr_protocol',
  created_at: new Date().toISOString(),
  status: { type: 'active' },
  metadata: {},
};
const input = {
  content: [{ type: 'input_text', text: 'Hello' }],
  attachments: [],
  inference_options: {},
};
const request = (type: string, params: unknown) =>
  JSON.stringify({ type, params });
async function context() {
  const store = new MemoryStore();
  await store.saveThread(thread, {});
  return new AgentContext({ thread, store, requestContext: {} });
}
async function collect(events: AsyncIterable<ThreadStreamEvent>) {
  const result: ThreadStreamEvent[] = [];
  for await (const event of events) result.push(structuredClone(event));
  return result;
}

describe('ChatKit request contracts', () => {
  it.each([
    ['items.list', {}],
    ['threads.delete', {}],
    ['attachments.delete', []],
    ['threads.get_by_id', { thread_id: { not: 'anything' } }],
    ['threads.update', { thread_id: 'thr_1', title: 1 }],
    [
      'threads.add_user_message',
      {
        thread_id: 'thr_1',
        input: { content: [{ type: 'input_text', text: {} }] },
      },
    ],
    ['threads.create', { input: { ...input, attachments: [''] } }],
    [
      'threads.create',
      { input: { ...input, inference_options: { tool_choice: { id: {} } } } },
    ],
    ['threads.add_client_tool_output', { thread_id: 'thr_1' }],
    [
      'threads.add_structured_input',
      { thread_id: 'thr_1', item_id: 'item_1', input: { status: 'pending' } },
    ],
    [
      'threads.add_structured_input',
      {
        thread_id: 'thr_1',
        item_id: 'item_1',
        input: { answers: { q: { values: [1] } } },
      },
    ],
    ['threads.custom_action', { thread_id: 'thr_1', action: { type: [] } }],
    [
      'threads.sync_custom_action',
      { thread_id: 'thr_1', item_id: false, action: { type: 'change' } },
    ],
    ['threads.retry_after_item', { thread_id: 'thr_1', item_id: ' ' }],
    [
      'items.feedback',
      { thread_id: 'thr_1', item_ids: ['item_1'], kind: 'bad' },
    ],
    ['attachments.create', { name: 'x', mime_type: 'text/plain', size: -1 }],
    [
      'input.transcribe',
      { audio_base64: 'not base64!', mime_type: 'audio/wav' },
    ],
    ['threads.list', { limit: 101 }],
    ['items.list', { thread_id: 'thr_1', limit: 0 }],
    ['threads.list', { order: 'anything' }],
    ['threads.list', { after: { not: 'x' } }],
  ])('rejects malformed %s before routing', (type, params) => {
    expect(() => parseRequest(request(type, params))).toThrow(
      InvalidRequestError,
    );
  });

  it('validates message bounds and normalizes optional input fields', () => {
    expect(() =>
      parseRequest(
        request('threads.create', {
          input: {
            ...input,
            content: [{ type: 'input_text', text: 'x'.repeat(1_048_577) }],
          },
        }),
      ),
    ).toThrow(InvalidRequestError);
    expect(
      parseRequest(
        request('threads.create', { input: { content: input.content } }),
      ),
    ).toMatchObject({ params: { input } });
    expect(
      parseRequest(
        request('threads.add_client_tool_output', {
          thread_id: 'thr_1',
          result: null,
        }),
      ),
    ).toMatchObject({ params: { result: null } });
  });

  it('rejects excessively nested opaque JSON without overflowing schema recursion', () => {
    let value: unknown = null;
    for (let depth = 0; depth < 100; depth++) value = { nested: value };
    expect(() =>
      parseRequest(
        request('threads.add_client_tool_output', {
          thread_id: 'thr_1',
          result: value,
        }),
      ),
    ).toThrow(InvalidRequestError);
  });
});

describe('ChatKit outbound events', () => {
  it('never discloses hidden added, replaced, or done items', async () => {
    const ctx = await context();
    class Server extends ChatKitService<unknown> {
      async *respond(
        _thread: ThreadMetadata,
        _input: UserMessageItem | undefined,
      ): AsyncGenerator<ThreadStreamEvent> {
        const item = {
          type: 'sdk_hidden_context' as const,
          id: 'hidden_1',
          thread_id: thread.id,
          created_at: thread.created_at,
          content: 'PRIVATE',
        };
        yield { type: 'thread.item.added', item };
        yield { type: 'thread.item.done', item };
        yield {
          type: 'thread.item.replaced',
          item: { ...item, content: 'PRIVATE replacement' },
        };
      }
    }
    const result = await new Server(ctx.store).process(
      request('threads.add_user_message', { thread_id: thread.id, input }),
      {},
    );
    if (!result.streaming) throw new Error('Expected streaming.');
    let wire = '';
    for await (const event of result.stream) wire += event;
    expect(wire).not.toContain('PRIVATE');
    expect(await ctx.store.loadItem(thread.id, 'hidden_1', {})).toMatchObject({
      content: 'PRIVATE replacement',
    });
  });

  it('preserves nulls and attachment-looking data inside arbitrary payloads', () => {
    const payload = {
      value: null,
      nested: {
        type: 'file',
        id: 'business-id',
        mime_type: 'business/type',
        metadata: { value: null },
      },
      attachments: [{ metadata: { value: null } }],
    };
    const parsed = JSON.parse(
      serialize({
        type: 'client_effect',
        name: 'clear',
        data: payload,
        payload,
        arguments: payload,
        output: payload,
        after: null,
      }),
    );
    expect(parsed).toEqual({
      type: 'client_effect',
      name: 'clear',
      data: payload,
      payload,
      arguments: payload,
      output: payload,
    });
    expect(
      JSON.parse(
        serialize({
          data: [
            {
              type: 'file',
              id: 'a',
              mime_type: 'text/plain',
              metadata: { private: true },
            },
          ],
          has_more: false,
        }),
      ),
    ).toEqual({
      data: [{ type: 'file', id: 'a', mime_type: 'text/plain' }],
      has_more: false,
    });
  });

  it('replaces widgets when growing text has no addressable id', () => {
    const before = {
      type: 'Card',
      children: [{ type: 'Text', value: 'Hello' }],
    } as WidgetRoot;
    const after = {
      type: 'Card',
      children: [{ type: 'Text', value: 'Hello world' }],
    } as WidgetRoot;
    expect(diffWidget(before, after)).toEqual([
      { type: 'widget.root.updated', widget: after },
    ]);
  });

  it('retains delta updates with ids, but replaces changed styling', () => {
    const before = {
      type: 'Card',
      children: [{ type: 'Text', id: 'text', value: 'Hello' }],
    } as WidgetRoot;
    const after = {
      type: 'Card',
      children: [{ type: 'Text', id: 'text', value: 'Hello world' }],
    } as WidgetRoot;
    expect(diffWidget(before, after)).toEqual([
      {
        type: 'widget.streaming_text.value_delta',
        component_id: 'text',
        delta: ' world',
        done: true,
      },
    ]);
    const styled = {
      type: 'Card',
      children: [{ ...after.children[0], color: 'red' }],
    } as WidgetRoot;
    expect(diffWidget(before, styled)).toEqual([
      { type: 'widget.root.updated', widget: styled },
    ]);
  });

  it('snapshots workflow events before subsequent mutations', async () => {
    const ctx = await context();
    ctx.addWorkflowTask({ type: 'custom', title: 'A' });
    ctx.addWorkflowTask({ type: 'custom', title: 'B' });
    ctx.endWorkflow({ title: 'Complete' });
    const events = await collect(
      streamAgentResponse(ctx, (async function* () {})()),
    );
    const added = events.find((e) => e.type === 'thread.item.added');
    expect(added).toMatchObject({
      item: { workflow: { tasks: [{ type: 'custom', title: 'A' }] } },
    });
    const done = events.find((e) => e.type === 'thread.item.done');
    expect(done).toMatchObject({
      item: {
        workflow: {
          tasks: [
            { type: 'custom', title: 'A' },
            { type: 'custom', title: 'B' },
          ],
        },
      },
    });
    expect(ctx.workflowItem).toBeUndefined();
  });
});

describe('ChatKit real SDK bridge', () => {
  async function calls(
    names: string[],
    clientNames: string[],
    events: ThreadStreamEvent[] = [],
  ) {
    const ctx = await context();
    const output = names.map((name, i) => ({
      type: 'function_call' as const,
      id: `fc_${i}`,
      callId: `call_${i}`,
      name,
      arguments: '{}',
    }));
    const model: Model = {
      async getResponse() {
        return { usage: new Usage(), output };
      },
      async *getStreamedResponse() {
        yield {
          type: 'response_done',
          response: { id: 'resp_1', usage: new Usage(), output },
        };
      },
    };
    const tools = names.map((name) =>
      clientNames.includes(name)
        ? clientTool({
            name,
            description: name,
            parameters: { type: 'object', properties: {} },
          })
        : tool({
            name,
            description: name,
            parameters: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
            execute: () => 'server done',
          }),
    );
    const result = await run(
      new Agent({
        name: 'offline',
        model,
        tools,
        toolUseBehavior: clientToolStopBehavior(clientNames),
      }),
      'Run tools',
      { context: ctx, stream: true },
    );
    for await (const event of streamAgentResponse(ctx, result))
      events.push(event);
    await result.completed;
    return events
      .filter((e) => e.type === 'thread.item.done')
      .map((e) => e.item);
  }

  it('rejects parallel browser calls before exposing any ambiguous dispatch', async () => {
    const events: ThreadStreamEvent[] = [];
    await expect(
      calls(['read_page', 'read_basket'], ['read_page', 'read_basket'], events),
    ).rejects.toMatchObject({ name: 'CustomStreamError', allowRetry: false });
    expect(
      events.filter((e) => 'item' in e && e.item.type === 'client_tool_call'),
    ).toEqual([]);
  });

  it('does not assign a later server tool identity to a client tool', async () => {
    expect(
      await calls(['read_page', 'check_stock'], ['read_page']),
    ).toMatchObject([{ name: 'read_page', id: 'fc_0', call_id: 'call_0' }]);
  });

  it('displays Chat Completions answers through the real model adapter', async () => {
    const chunks = [
      {
        id: 'chatcmpl_offline',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'offline',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Hello offline' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl_offline',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'offline',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];
    const client = new OpenAI({
      apiKey: 'offline',
      maxRetries: 0,
      fetch: async () =>
        new Response(
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
            'data: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    });
    const ctx = await context();
    const result = await run(
      new Agent({
        name: 'offline',
        model: new OpenAIChatCompletionsModel(client, 'offline'),
      }),
      'Hello',
      { context: ctx, stream: true },
    );
    const events = await collect(streamAgentResponse(ctx, result));
    await result.completed;
    expect(result.finalOutput).toBe('Hello offline');
    expect(events.filter((e) => e.type === 'thread.item.done')).toMatchObject([
      {
        item: {
          type: 'assistant_message',
          content: [{ type: 'output_text', text: 'Hello offline' }],
        },
      },
    ]);
  });

  it('does not duplicate messages already delivered by Responses raw events', async () => {
    const ctx = await context();
    const result = await run(
      new Agent({
        name: 'offline',
        model: scriptedModel([{ text: 'Only once' }]),
      }),
      'Hello',
      { context: ctx, stream: true },
    );
    const events = await collect(streamAgentResponse(ctx, result));
    await result.completed;
    expect(events.filter((e) => e.type === 'thread.item.done')).toHaveLength(1);
  });
});
