import { ConfigService } from '@nestjs/config';
import {
  Agent,
  run,
  setTracingDisabled,
  tool,
  Usage,
  type Model,
} from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  actionConfig,
  AgentContext,
  AttachmentStore,
  ChatKitService,
  clientTool,
  clientToolStopBehavior,
  CustomStreamError,
  diffWidget,
  InvalidRequestError,
  MemoryStore,
  parseRequest,
  serialize,
  simpleToAgentInput,
  streamAgentResponse,
  streamWidget,
  type Action,
  type Attachment,
  type AttachmentCreateParams,
  type ThreadItem,
  type ThreadMetadata,
  type ThreadStreamEvent,
  type UserMessageItem,
  type WidgetItem,
  type WidgetRoot,
} from '@/lib/chatkit/chatkit.service.js';
import { ChatKitAuth } from '@/config/chatkit/index.js';

setTracingDisabled(true);

const SECRET = 's'.repeat(32);
const now = () => new Date().toISOString();

// A model that streams raw Responses events for one assistant message, like the real API.
function streamingModel(text: string, messageId = 'msg_model'): Model {
  const message = {
    type: 'message' as const,
    id: messageId,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text }],
  };
  const raw = (event: Record<string, unknown>) => ({
    type: 'model' as const,
    event,
  });
  return {
    async getResponse() {
      return { usage: new Usage(), output: [message] };
    },
    async *getStreamedResponse() {
      yield { type: 'response_started' as const };
      yield raw({
        type: 'response.output_item.added',
        item: { ...message, content: [] },
      });
      yield raw({
        type: 'response.content_part.added',
        item_id: messageId,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      for (const delta of [text.slice(0, 3), text.slice(3)]) {
        yield { type: 'output_text_delta' as const, delta };
        yield raw({
          type: 'response.output_text.delta',
          item_id: messageId,
          content_index: 0,
          delta,
        });
      }
      yield raw({
        type: 'response.output_text.done',
        item_id: messageId,
        content_index: 0,
        text,
      });
      yield raw({ type: 'response.output_item.done', item: message });
      yield {
        type: 'response_done' as const,
        response: { id: 'resp_1', usage: new Usage(), output: [message] },
      };
    },
  };
}

type Context = { userId: string };

// Replies with fixed events, or with a real Agents SDK run when given an agent.
class TestServer extends ChatKitService<Context> {
  responses: ((thread: ThreadMetadata) => AsyncIterable<ThreadStreamEvent>)[] =
    [];
  received: (UserMessageItem | undefined)[] = [];
  actions: { action: Action; sender?: WidgetItem }[] = [];

  async *respond(thread: ThreadMetadata, input: UserMessageItem | undefined) {
    this.received.push(input);
    if (input && !thread.title) thread.title = 'Tutoring prices';
    const next = this.responses.shift();
    if (next) yield* next(thread);
  }

  async *action(
    _thread: ThreadMetadata,
    action: Action,
    sender: WidgetItem | undefined,
  ): AsyncGenerator<ThreadStreamEvent> {
    this.actions.push({ action, ...(sender && { sender }) });
    yield { type: 'progress_update', text: 'Working…' };
  }
}

class TestFiles extends AttachmentStore<Context> {
  deleted: string[] = [];
  deleteAttachment(id: string) {
    this.deleted.push(id);
    return Promise.resolve();
  }
  createAttachment(input: AttachmentCreateParams): Promise<Attachment> {
    return Promise.resolve({
      type: 'file',
      id: 'atc_1',
      name: input.name,
      mime_type: input.mime_type,
      upload_descriptor: {
        url: 'https://upload.example/atc_1',
        method: 'POST',
      },
      metadata: { secret: 'internal' },
    });
  }
}

const context: Context = { userId: 'guardian-7' };
const message = (text: string) => ({
  content: [{ type: 'input_text' as const, text }],
  attachments: [] as string[],
  inference_options: {},
});

async function events(server: TestServer, body: unknown, signal?: AbortSignal) {
  const result = await server.process(JSON.stringify(body), context, signal);
  if (!result.streaming) throw new Error('Expected a stream.');
  const out: ThreadStreamEvent[] = [];
  for await (const line of result.stream) {
    expect(line.startsWith('data: ') && line.endsWith('\n\n')).toBe(true);
    out.push(JSON.parse(line.slice(6)) as ThreadStreamEvent);
  }
  return out;
}

async function json(server: TestServer, body: unknown) {
  const result = await server.process(JSON.stringify(body), context);
  if (result.streaming) throw new Error('Expected JSON.');
  return JSON.parse(result.json) as Record<string, unknown>;
}

function assistantReply(text: string) {
  return async function* (
    thread: ThreadMetadata,
  ): AsyncGenerator<ThreadStreamEvent> {
    const item: ThreadItem = {
      type: 'assistant_message',
      id: 'msg_reply',
      thread_id: thread.id,
      created_at: now(),
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    yield { type: 'thread.item.added', item: { ...item, content: [] } };
    yield { type: 'thread.item.done', item };
  };
}

async function newThread(server: TestServer, text = 'How much is tutoring?') {
  const created = await events(server, {
    type: 'threads.create',
    params: { input: message(text) },
  });
  const thread = created.find((event) => event.type === 'thread.created');
  if (thread?.type !== 'thread.created') throw new Error('No thread.');
  return { id: thread.thread.id, events: created };
}

describe('ChatKitService protocol', () => {
  it('creates a thread, saves the message and reply, and sends the new title', async () => {
    const server = new TestServer(new MemoryStore());
    server.responses.push(assistantReply('From $89 a month.'));
    const { id, events: sent } = await newThread(server);

    expect(sent.map((event) => event.type)).toEqual([
      'thread.created',
      'thread.item.done',
      'stream_options',
      'thread.item.added',
      // Like the Python server, a thread change is sent after the event that follows it.
      'thread.updated',
      'thread.item.done',
    ]);
    expect(sent[2]).toEqual({
      type: 'stream_options',
      stream_options: { allow_cancel: true },
    });
    const thread = await json(server, {
      type: 'threads.get_by_id',
      params: { thread_id: id },
    });
    expect(thread.title).toBe('Tutoring prices');
    expect(thread).not.toHaveProperty('metadata');
    const items = (thread.items as { data: ThreadItem[] }).data;
    expect(items.map((item) => item.type)).toEqual([
      'user_message',
      'assistant_message',
    ]);
  });

  it('hides hidden context from the client but keeps it for the model', async () => {
    const store = new MemoryStore<Context>();
    const server = new TestServer(store);
    server.responses.push(async function* (thread) {
      yield {
        type: 'thread.item.done',
        item: {
          type: 'hidden_context_item',
          id: 'hid_1',
          thread_id: thread.id,
          created_at: now(),
          content: 'The Guardian is on the /weloveyou page.',
        },
      };
    });
    const { id, events: sent } = await newThread(server);

    expect(JSON.stringify(sent)).not.toContain('weloveyou');
    const listed = await json(server, {
      type: 'items.list',
      params: { thread_id: id, order: 'asc' },
    });
    expect((listed.data as ThreadItem[]).map((item) => item.type)).toEqual([
      'user_message',
    ]);
    const saved = await store.loadThreadItems(id, null, 20, 'asc', context);
    expect(saved.data.map((item) => item.type)).toContain(
      'hidden_context_item',
    );
  });

  it('lists, renames, and deletes threads with paging', async () => {
    const server = new TestServer(new MemoryStore());
    const first = await newThread(server, 'One');
    const second = await newThread(server, 'Two');

    const page = await json(server, {
      type: 'threads.list',
      params: { limit: 1, order: 'desc' },
    });
    expect((page.data as ThreadMetadata[]).map((thread) => thread.id)).toEqual([
      second.id,
    ]);
    expect(page.has_more).toBe(true);
    const next = await json(server, {
      type: 'threads.list',
      params: { limit: 1, order: 'desc', after: page.after },
    });
    expect((next.data as ThreadMetadata[])[0].id).toBe(first.id);

    const renamed = await json(server, {
      type: 'threads.update',
      params: { thread_id: first.id, title: 'Math help' },
    });
    expect(renamed.title).toBe('Math help');
    expect(
      await json(server, {
        type: 'threads.delete',
        params: { thread_id: first.id },
      }),
    ).toEqual({});
    await expect(
      json(server, {
        type: 'threads.get_by_id',
        params: { thread_id: first.id },
      }),
    ).rejects.toThrow('Thread not found.');
  });

  it('creates and deletes attachments without sending their metadata', async () => {
    const files = new TestFiles();
    const server = new TestServer(new MemoryStore(), files);
    const created = await json(server, {
      type: 'attachments.create',
      params: { name: 'report.pdf', size: 1200, mime_type: 'application/pdf' },
    });
    expect(created).toMatchObject({
      id: 'atc_1',
      upload_descriptor: { method: 'POST' },
    });
    expect(created).not.toHaveProperty('metadata');
    expect(
      await json(server, {
        type: 'attachments.delete',
        params: { attachment_id: 'atc_1' },
      }),
    ).toEqual({});
    expect(files.deleted).toEqual(['atc_1']);
  });

  it('records feedback and transcribes dictation through the overrides', async () => {
    const server = new TestServer(new MemoryStore());
    const feedback = vi.spyOn(server, 'addFeedback');
    const transcribe = vi
      .spyOn(server, 'transcribe')
      .mockResolvedValue({ text: 'Hello' });
    expect(
      await json(server, {
        type: 'items.feedback',
        params: { thread_id: 'thr_1', item_ids: ['msg_1'], kind: 'positive' },
      }),
    ).toEqual({});
    expect(feedback).toHaveBeenCalledWith(
      'thr_1',
      ['msg_1'],
      'positive',
      context,
    );
    expect(
      await json(server, {
        type: 'input.transcribe',
        params: {
          audio_base64: Buffer.from('audio').toString('base64'),
          mime_type: 'audio/webm;codecs=opus',
        },
      }),
    ).toEqual({ text: 'Hello' });
    expect(transcribe.mock.calls[0][0].data.toString()).toBe('audio');
  });

  it('completes a client tool call with its output, then responds again', async () => {
    const store = new MemoryStore<Context>();
    const server = new TestServer(store);
    const { id } = await newThread(server);
    await store.addThreadItem(
      id,
      {
        type: 'client_tool_call',
        id: 'tc_1',
        thread_id: id,
        created_at: now(),
        status: 'pending',
        call_id: 'call_1',
        name: 'read_page',
        arguments: {},
      },
      context,
    );
    server.responses.push(assistantReply('Got it.'));
    await events(server, {
      type: 'threads.add_client_tool_output',
      params: { thread_id: id, result: { url: '/pricing' } },
    });

    expect(await store.loadItem(id, 'tc_1', context)).toMatchObject({
      status: 'completed',
      output: { url: '/pricing' },
    });
    expect(server.received.at(-1)).toBeUndefined();
  });

  it('records structured input answers and responds', async () => {
    const store = new MemoryStore<Context>();
    const server = new TestServer(store);
    const { id } = await newThread(server);
    await store.addThreadItem(
      id,
      {
        type: 'structured_input',
        id: 'si_1',
        thread_id: id,
        created_at: now(),
        status: 'pending',
        inputs: [
          {
            type: 'multiple_choice',
            id: 'grade',
            question: 'Which grade?',
            options: [{ value: 'Grade 7' }, { value: 'Grade 8' }],
          },
          { type: 'freeform', id: 'goal', question: 'What is the goal?' },
        ],
      },
      context,
    );
    const sent = await events(server, {
      type: 'threads.add_structured_input',
      params: {
        thread_id: id,
        item_id: 'si_1',
        input: { answers: { grade: { values: ['Grade 7', 'Grade 8'] } } },
      },
    });

    expect(sent.map((event) => event.type)).toContain('thread.item.replaced');
    expect(await store.loadItem(id, 'si_1', context)).toMatchObject({
      status: 'answered',
      inputs: [
        { answer: { values: ['Grade 7'], skipped: false } },
        { answer: { values: [], skipped: true } },
      ],
    });
  });

  it('retries after a user message by removing the reply that followed it', async () => {
    const store = new MemoryStore<Context>();
    const server = new TestServer(store);
    server.responses.push(assistantReply('First answer.'));
    const { id } = await newThread(server);
    const userItem = (await store.loadThreadItems(id, null, 20, 'asc', context))
      .data[0];
    server.responses.push(assistantReply('Second answer.'));
    await events(server, {
      type: 'threads.retry_after_item',
      params: { thread_id: id, item_id: userItem.id },
    });

    const items = await store.loadThreadItems(id, null, 20, 'asc', context);
    expect(items.data.map((item) => item.type)).toEqual([
      'user_message',
      'assistant_message',
    ]);
    expect(items.data[1]).toMatchObject({
      content: [{ text: 'Second answer.' }],
    });
    expect(server.received.at(-1)?.id).toBe(userItem.id);
  });

  it('passes widget actions to action, and rejects a sender that is not a widget', async () => {
    const store = new MemoryStore<Context>();
    const server = new TestServer(store);
    const { id } = await newThread(server);
    const widget: WidgetItem = {
      type: 'widget',
      id: 'wd_1',
      thread_id: id,
      created_at: now(),
      widget: { type: 'Card', children: [] } as unknown as WidgetRoot,
    };
    await store.addThreadItem(id, widget, context);
    const action = { type: 'plan.pick', payload: { plan: '3x' } };
    const sent = await events(server, {
      type: 'threads.custom_action',
      params: { thread_id: id, item_id: 'wd_1', action },
    });
    expect(sent.at(-1)).toEqual({ type: 'progress_update', text: 'Working…' });
    expect(server.actions[0]).toMatchObject({ action, sender: { id: 'wd_1' } });

    const userItem = (await store.loadThreadItems(id, null, 1, 'asc', context))
      .data[0];
    const refused = await events(server, {
      type: 'threads.custom_action',
      params: { thread_id: id, item_id: userItem.id, action },
    });
    expect(refused).toEqual([
      { type: 'error', code: 'stream.error', allow_retry: false },
    ]);
  });

  it('turns failures into error events the client can show', async () => {
    const server = new TestServer(new MemoryStore());
    server.responses.push(async function* () {
      yield* [];
      throw new CustomStreamError('Your plan has no messages left.', true);
    });
    const custom = await newThread(server);
    expect(custom.events.at(-2)).toEqual({
      type: 'error',
      code: 'custom',
      message: 'Your plan has no messages left.',
      allow_retry: true,
    });

    server.responses.push(async function* () {
      yield* [];
      throw new Error('Database password is hunter2');
    });
    const failed = await newThread(server);
    const error = failed.events.find((event) => event.type === 'error');
    expect(error).toEqual({
      type: 'error',
      code: 'stream.error',
      allow_retry: true,
    });
    expect(JSON.stringify(failed.events)).not.toContain('hunter2');
  });

  it('keeps streamed text and notes the stop when the user cancels', async () => {
    const store = new MemoryStore<Context>();
    const server = new TestServer(store);
    const stop = new AbortController();
    server.responses.push(async function* (thread) {
      yield {
        type: 'thread.item.added',
        item: {
          type: 'assistant_message',
          id: 'msg_partial',
          thread_id: thread.id,
          created_at: now(),
          content: [],
        },
      };
      yield {
        type: 'thread.item.updated',
        item_id: 'msg_partial',
        update: {
          type: 'assistant_message.content_part.text_delta',
          content_index: 0,
          delta: 'Plans start at',
        },
      };
      stop.abort();
      yield { type: 'progress_update', text: 'never sent' };
    });
    const created = await events(
      server,
      { type: 'threads.create', params: { input: message('Prices?') } },
      stop.signal,
    );
    const threadId = (created[0] as { thread: { id: string } }).thread.id;

    const items = await store.loadThreadItems(
      threadId,
      null,
      20,
      'asc',
      context,
    );
    expect(items.data.map((item) => item.type)).toEqual([
      'user_message',
      'assistant_message',
      'sdk_hidden_context',
    ]);
    expect(items.data[1]).toMatchObject({
      content: [{ text: 'Plans start at' }],
    });
  });

  it('refuses requests that are not ChatKit requests', () => {
    expect(() => parseRequest('not json')).toThrow(InvalidRequestError);
    expect(() => parseRequest('{"type":"threads.hack","params":{}}')).toThrow(
      InvalidRequestError,
    );
    expect(() => parseRequest('{"type":"threads.list"}')).toThrow(
      InvalidRequestError,
    );
  });

  it('drops nulls and attachment metadata when serializing', () => {
    expect(
      JSON.parse(
        serialize({
          after: null,
          attachments: [
            {
              type: 'file',
              id: 'a',
              name: 'x',
              mime_type: 'text/plain',
              metadata: { s: 1 },
            },
          ],
        }),
      ),
    ).toEqual({
      attachments: [
        { type: 'file', id: 'a', name: 'x', mime_type: 'text/plain' },
      ],
    });
  });
});

describe('ChatKit Agents SDK bridge', () => {
  const thread: ThreadMetadata = {
    id: 'thr_1',
    created_at: now(),
    status: { type: 'active' },
    metadata: {},
  };

  it('streams a real SDK run as assistant message events', async () => {
    const store = new MemoryStore<Context>();
    await store.saveThread(thread, context);
    const agentContext = new AgentContext({
      thread,
      store,
      requestContext: context,
    });
    const agent = new Agent({
      name: 'MsSuzie',
      model: streamingModel('Hello there'),
    });
    const result = await run(agent, 'Hi', {
      stream: true,
      context: agentContext,
    });
    const sent: ThreadStreamEvent[] = [];
    for await (const event of streamAgentResponse(agentContext, result))
      sent.push(event);

    expect(sent.map((event) => event.type)).toEqual([
      'thread.item.added',
      'thread.item.updated',
      'thread.item.updated',
      'thread.item.updated',
      'thread.item.updated',
      'thread.item.done',
    ]);
    expect(sent.at(-1)).toMatchObject({
      type: 'thread.item.done',
      item: {
        type: 'assistant_message',
        id: 'msg_model',
        content: [{ text: 'Hello there' }],
      },
    });
    const deltas = sent
      .filter((event) => event.type === 'thread.item.updated')
      .map((event) =>
        event.type === 'thread.item.updated' && 'delta' in event.update
          ? event.update.delta
          : '',
      )
      .join('');
    expect(deltas).toBe('Hello there');
  });

  it('streams widgets and progress from a tool, in order', async () => {
    const store = new MemoryStore<Context>();
    await store.saveThread(thread, context);
    const agentContext = new AgentContext({
      thread,
      store,
      requestContext: context,
    });
    let calls = 0;
    const model: Model = {
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
                    name: 'show_plans',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      { type: 'output_text', text: 'Here are the plans.' },
                    ],
                  },
                ],
        };
      },
      async *getStreamedResponse(request) {
        const response = await this.getResponse(request);
        yield {
          type: 'response_done' as const,
          response: { ...response, id: `r${calls}` },
        } as never;
      },
    };
    const showPlans = tool({
      name: 'show_plans',
      description: 'Show the plans.',
      parameters: z.object({}),
      execute: async (_input, runContext) => {
        const ctx = runContext?.context as AgentContext<Context>;
        ctx.streamProgress('Loading plans…');
        await ctx.streamWidget(
          {
            type: 'Card',
            children: [{ type: 'Text', value: '$89 a month' }],
          } as WidgetRoot,
          'Plans',
        );
        return 'shown';
      },
    });
    const result = await run(
      new Agent({ name: 'MsSuzie', model, tools: [showPlans] }),
      'Plans?',
      {
        stream: true,
        context: agentContext,
      },
    );
    const sent: ThreadStreamEvent[] = [];
    for await (const event of streamAgentResponse(agentContext, result))
      sent.push(event);

    expect(sent.map((event) => event.type)).toEqual([
      'progress_update',
      'thread.item.done',
      'thread.item.done',
    ]);
    expect(sent[1]).toMatchObject({
      item: { type: 'widget', copy_text: 'Plans', thread_id: 'thr_1' },
    });
    expect(sent[2]).toMatchObject({
      item: {
        type: 'assistant_message',
        content: [{ text: 'Here are the plans.' }],
      },
    });
  });

  it('stops at a client tool and asks the browser to run it', async () => {
    const store = new MemoryStore<Context>();
    await store.saveThread(thread, context);
    const agentContext = new AgentContext({
      thread,
      store,
      requestContext: context,
    });
    const model: Model = {
      async getResponse() {
        return {
          usage: new Usage(),
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              callId: 'call_page',
              name: 'read_page',
              arguments: '{"selector":"main"}',
            },
          ],
        };
      },
      async *getStreamedResponse(request) {
        yield {
          type: 'response_done' as const,
          response: { ...(await this.getResponse(request)), id: 'r1' },
        } as never;
      },
    };
    const readPage = clientTool({
      name: 'read_page',
      description: 'Read the current page.',
      parameters: { properties: { selector: { type: 'string' } } },
    });
    const agent = new Agent({
      name: 'MsSuzie',
      model,
      tools: [readPage],
      toolUseBehavior: clientToolStopBehavior(['read_page']),
    });
    const result = await run(agent, 'What page am I on?', {
      stream: true,
      context: agentContext,
    });
    const sent: ThreadStreamEvent[] = [];
    for await (const event of streamAgentResponse(agentContext, result))
      sent.push(event);

    expect(sent.at(-1)).toMatchObject({
      type: 'thread.item.done',
      item: {
        type: 'client_tool_call',
        status: 'pending',
        call_id: 'call_page',
        name: 'read_page',
        arguments: { selector: 'main' },
      },
    });
  });

  it('saves only the thread id when a paused run is written to JSON', () => {
    const agentContext = new AgentContext({
      thread,
      store: new MemoryStore(),
      requestContext: context,
    });
    expect(JSON.parse(JSON.stringify(agentContext))).toEqual({
      thread_id: 'thr_1',
    });
  });

  it('turns thread items back into model input', async () => {
    const base = { thread_id: 'thr_1', created_at: now() };
    const input = await simpleToAgentInput([
      {
        ...base,
        type: 'user_message',
        id: 'm1',
        content: [
          { type: 'input_text', text: 'Help with ' },
          {
            type: 'input_tag',
            id: 't1',
            text: 'Algebra 1',
            data: { subject: 'algebra' },
          },
        ],
        attachments: [],
        quoted_text: 'multi-step word problems',
        inference_options: {},
      },
      {
        ...base,
        type: 'client_tool_call',
        id: 'tc1',
        status: 'pending',
        call_id: 'c1',
        name: 'read_page',
        arguments: {},
      },
      {
        ...base,
        type: 'assistant_message',
        id: 'a1',
        content: [{ type: 'output_text', text: 'Sure.', annotations: [] }],
      },
    ]);
    const text = JSON.stringify(input);
    expect(text).toContain('Help with @Algebra 1');
    expect(text).not.toContain('multi-step word problems');
    expect(text).toContain('@-mentions');
    expect(text).not.toContain('read_page');
    expect(input.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'completed',
    });
  });
});

describe('ChatKit widgets', () => {
  const base = { id: 'w', type: 'Card' };

  it('streams text growth as deltas and other changes as a replace', () => {
    const before = {
      ...base,
      children: [{ type: 'Text', id: 't1', value: 'Hi', streaming: true }],
    };
    const grown = {
      ...base,
      children: [
        { type: 'Text', id: 't1', value: 'Hi there', streaming: true },
      ],
    };
    expect(diffWidget(before as never, grown as never)).toEqual([
      {
        type: 'widget.streaming_text.value_delta',
        component_id: 't1',
        delta: ' there',
        done: false,
      },
    ]);
    const changed = {
      ...base,
      children: [{ type: 'Title', id: 't2', value: 'New' }],
    };
    expect(diffWidget(before as never, changed as never)).toEqual([
      { type: 'widget.root.updated', widget: changed },
    ]);
  });

  it('sends one widget as done, and a changing widget as added, updates, then done', async () => {
    const thread = { id: 'thr_1' } as ThreadMetadata;
    const single: ThreadStreamEvent[] = [];
    for await (const event of streamWidget(thread, base as never))
      single.push(event);
    expect(single.map((event) => event.type)).toEqual(['thread.item.done']);

    async function* growing() {
      yield {
        ...base,
        children: [{ type: 'Markdown', id: 'm', value: 'A', streaming: true }],
      } as never;
      yield {
        ...base,
        children: [
          { type: 'Markdown', id: 'm', value: 'AB', streaming: false },
        ],
      } as never;
    }
    const streamed: ThreadStreamEvent[] = [];
    for await (const event of streamWidget(thread, growing()))
      streamed.push(event);
    expect(streamed.map((event) => event.type)).toEqual([
      'thread.item.added',
      'thread.item.updated',
      'thread.item.done',
    ]);
  });

  it('builds action configs with the documented defaults', () => {
    expect(actionConfig('plan.pick', { plan: '3x' })).toEqual({
      type: 'plan.pick',
      payload: { plan: '3x' },
      handler: 'server',
      loadingBehavior: 'auto',
      streaming: true,
    });
  });
});

describe('ChatKit auth', () => {
  const auth = (secret?: string) =>
    new ChatKitAuth(
      new ConfigService(secret ? { CHATKIT_SECRET: secret } : {}),
    );

  it('issues tokens that verify only with the same secret and before they expire', () => {
    const { token } = auth(SECRET).issueToken('guardian-7', 120);
    expect(auth(SECRET).verifyToken(token)).toBe('guardian-7');
    expect(auth('x'.repeat(32)).verifyToken(token)).toBeUndefined();
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'guardian-8', aud: 'chatkit', exp: 9e9 }),
    ).toString('base64url');
    expect(
      auth(SECRET).verifyToken(`${header}.${forged}.${signature}`),
    ).toBeUndefined();

    vi.useFakeTimers({ now: Date.now() + 121_000 });
    try {
      expect(auth(SECRET).verifyToken(token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs file links for one attachment and one owner', () => {
    const signer = auth(SECRET);
    const signature = signer.signAttachment('atc_1', 'guardian-7');
    expect(signer.verifyAttachment('atc_1', 'guardian-7', signature)).toBe(
      true,
    );
    expect(signer.verifyAttachment('atc_2', 'guardian-7', signature)).toBe(
      false,
    );
    expect(signer.verifyAttachment('atc_1', 'guardian-8', signature)).toBe(
      false,
    );
  });

  it('stays off without CHATKIT_SECRET', () => {
    expect(auth().enabled).toBe(false);
    expect(() => auth().issueToken('guardian-7')).toThrow(/CHATKIT_SECRET/);
  });
});
