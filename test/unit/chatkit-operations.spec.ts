import { vi } from 'vitest';
import {
  ChatKitService,
  CustomStreamError,
  MemoryStore,
  StreamError,
  type ThreadMetadata,
  type ThreadStreamEvent,
} from '@/lib/chatkit/chatkit.service.js';

const thread: ThreadMetadata = {
  id: 'thr_operations',
  created_at: new Date().toISOString(),
  status: { type: 'active' },
  metadata: {},
};
class Server extends ChatKitService<undefined> {
  calls = 0;
  failure?: Error;
  async *respond(): AsyncGenerator<ThreadStreamEvent> {
    this.calls++;
    if (this.failure) throw this.failure;
    yield { type: 'progress_update', text: 'continued' };
  }
}
async function send(
  server: Server,
  type: string,
  params: unknown,
  metadata?: Record<string, unknown>,
) {
  const result = await server.process(
    JSON.stringify({ type, params, metadata }),
    undefined,
  );
  if (!result.streaming) throw new Error('Expected stream.');
  const events = [];
  for await (const event of result.stream)
    events.push(JSON.parse(event.slice(6)));
  return events;
}
async function fixture() {
  const store = new MemoryStore<undefined>();
  await store.saveThread(thread);
  const server = new Server(store);
  return { store, server };
}
async function call(store: MemoryStore<undefined>) {
  await store.saveItem(thread.id, {
    id: 'tool_1',
    thread_id: thread.id,
    created_at: thread.created_at,
    type: 'client_tool_call',
    name: 'browser',
    call_id: 'call_1',
    arguments: {},
    status: 'pending',
  });
}
describe('ChatKit durable operations', () => {
  it('settles pending browser calls when an interrupted operation is cancelled', async () => {
    const { store, server } = await fixture();
    await call(store);
    vi.spyOn(server, 'respond').mockImplementationOnce(async function* () {
      yield {
        type: 'thread.item.done',
        item: {
          id: 'tool_2',
          thread_id: thread.id,
          created_at: thread.created_at,
          type: 'client_tool_call',
          name: 'browser',
          call_id: 'call_2',
          arguments: {},
          status: 'pending',
        },
      };
      throw new Error('Continuation failed after browser dispatch.');
    });
    await send(server, 'threads.add_client_tool_output', {
      thread_id: thread.id,
      result: 'first',
    });
    await server.recoverOperation(
      thread.id,
      {
        decision: 'cancel',
        note: 'Reconciled and abandoned the browser action.',
      },
      undefined,
    );
    expect(await store.loadItem(thread.id, 'tool_2')).toMatchObject({
      status: 'completed',
      output: { error: 'The operation was cancelled after reconciliation.' },
    });
    await expect(
      send(
        server,
        'threads.add_client_tool_output',
        { thread_id: thread.id, result: 'late' },
        { client_tool_call_id: 'call_2' },
      ),
    ).rejects.toThrow();
    await send(server, 'threads.add_user_message', {
      thread_id: thread.id,
      input: { content: [{ type: 'input_text', text: 'continue' }] },
    });
    expect(server.calls).toBe(1);
  });
  it('rejects a delayed unidentified result after a newer tool has completed', async () => {
    const { store, server } = await fixture();
    await call(store);
    const first = { thread_id: thread.id, result: 'first result' };
    await send(server, 'threads.add_client_tool_output', first);
    for (const index of [2, 3]) {
      await store.saveItem(thread.id, {
        id: `tool_${index}`,
        thread_id: thread.id,
        created_at: thread.created_at,
        type: 'client_tool_call',
        name: 'browser',
        call_id: `call_${index}`,
        arguments: {},
        status: 'pending',
      });
      if (index === 2)
        await send(
          server,
          'threads.add_client_tool_output',
          { thread_id: thread.id, result: 'second result' },
          { client_tool_call_id: 'call_2' },
        );
    }
    await expect(
      send(server, 'threads.add_client_tool_output', first),
    ).rejects.toThrow(/client_tool_call_id/);
    expect(await store.loadItem(thread.id, 'tool_3')).toMatchObject({
      status: 'pending',
    });
    expect(server.calls).toBe(2);
  });
  it('retains completed retry receipts across new user turns', async () => {
    const { server } = await fixture();
    await send(server, 'threads.add_user_message', {
      thread_id: thread.id,
      input: { content: [{ type: 'input_text', text: 'first' }] },
    });
    const first = (
      await server.store.loadThreadItems(thread.id, null, 1, 'asc', undefined)
    ).data[0];
    const params = { thread_id: thread.id, item_id: first.id };
    await send(server, 'threads.retry_after_item', params, {
      operation_id: 'request-1',
    });
    await send(server, 'threads.add_user_message', {
      thread_id: thread.id,
      input: { content: [{ type: 'input_text', text: 'second' }] },
    });
    await send(server, 'threads.retry_after_item', params, {
      operation_id: 'request-1',
    });
    expect(server.calls).toBe(3);
    expect(
      (
        await server.store.loadThreadItems(
          thread.id,
          null,
          10,
          'asc',
          undefined,
        )
      ).data,
    ).toHaveLength(2);
  });
  it('atomically removes partial retry output after authorized reconciliation', async () => {
    const { store, server } = await fixture();
    await store.saveItem(thread.id, {
      id: 'user',
      thread_id: thread.id,
      created_at: thread.created_at,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'hello' }],
      attachments: [],
      inference_options: {},
    });
    server.failure = new Error('Unknown outcome.');
    const params = { thread_id: thread.id, item_id: 'user' };
    await send(server, 'threads.retry_after_item', params);
    await store.saveItem(thread.id, {
      id: 'partial',
      thread_id: thread.id,
      created_at: thread.created_at,
      type: 'assistant_message',
      content: [
        { type: 'output_text', text: 'incomplete result', annotations: [] },
      ],
    });
    await server.recoverOperation(
      thread.id,
      { decision: 'retry', note: 'Reconciled the incomplete attempt.' },
      undefined,
    );
    server.failure = undefined;
    await send(server, 'threads.retry_after_item', params);
    expect(
      (await store.loadThreadItems(thread.id, null, 10, 'asc')).data.map(
        (item) => item.id,
      ),
    ).toEqual(['user']);
  });
  it('does not interpret a generic stream error as proof that effects are safe to repeat', async () => {
    const { store, server } = await fixture();
    await call(store);
    server.failure = new StreamError('stream.error');
    const params = { thread_id: thread.id, result: 'accepted' };
    expect(
      await send(server, 'threads.add_client_tool_output', params),
    ).toContainEqual(
      expect.objectContaining({ type: 'error', allow_retry: false }),
    );
    await expect(
      send(server, 'threads.add_client_tool_output', params),
    ).rejects.toThrow(/reconcil/i);
    expect(server.calls).toBe(1);
  });
  it('does not apply a duplicate completed result to the next browser tool', async () => {
    const { store, server } = await fixture();
    await call(store);
    const params = { thread_id: thread.id, result: 'same output' };
    await send(server, 'threads.add_client_tool_output', params);
    await store.saveItem(thread.id, {
      id: 'tool_2',
      thread_id: thread.id,
      created_at: thread.created_at,
      type: 'client_tool_call',
      name: 'browser',
      call_id: 'call_2',
      arguments: {},
      status: 'pending',
    });
    await send(server, 'threads.add_client_tool_output', params);
    expect(await store.loadItem(thread.id, 'tool_2')).toMatchObject({
      status: 'pending',
    });
    expect(server.calls).toBe(1);
    await send(server, 'threads.add_client_tool_output', params, {
      client_tool_call_id: 'call_2',
    });
    expect(await store.loadItem(thread.id, 'tool_2')).toMatchObject({
      status: 'completed',
    });
    expect(server.calls).toBe(2);
  });
  it('deduplicates a completed retry unless a fresh operation identity is supplied', async () => {
    const { store, server } = await fixture();
    await store.saveItem(thread.id, {
      id: 'user',
      thread_id: thread.id,
      created_at: thread.created_at,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'hello' }],
      attachments: [],
      inference_options: {},
    });
    const params = { thread_id: thread.id, item_id: 'user' };
    await send(server, 'threads.retry_after_item', params);
    await send(server, 'threads.retry_after_item', params);
    expect(server.calls).toBe(1);
    await send(server, 'threads.retry_after_item', params, {
      operation_id: 'fresh-retry',
    });
    expect(server.calls).toBe(2);
  });
  it('rolls back client output when its continuation marker cannot be saved', async () => {
    const { store, server } = await fixture();
    await call(store);
    vi.spyOn(store, 'saveThread').mockRejectedValueOnce(
      new Error('Marker unavailable.'),
    );
    await expect(
      send(server, 'threads.add_client_tool_output', {
        thread_id: thread.id,
        result: 'value',
      }),
    ).rejects.toThrow('Marker unavailable.');
    expect(await store.loadItem(thread.id, 'tool_1')).toMatchObject({
      status: 'pending',
    });
    expect(server.calls).toBe(0);
  });
  it('blocks a running operation after reconstruction until an operator reconciles it', async () => {
    const { store } = await fixture();
    await store.saveThread({
      ...thread,
      metadata: {
        _chatkit_operation: {
          id: 'crashed',
          kind: 'client_output',
          itemId: 'tool_1',
          status: 'running',
          resultHash: 'unused',
        },
      },
    });
    const server = new Server(store);
    await expect(
      send(server, 'threads.add_user_message', {
        thread_id: thread.id,
        input: { content: [{ type: 'input_text', text: 'new message' }] },
      }),
    ).rejects.toThrow(/reconcil/i);
    expect(
      (await store.loadThreadItems(thread.id, null, 10, 'asc')).data,
    ).toHaveLength(0);
    await server.recoverOperation(
      thread.id,
      {
        decision: 'cancel',
        note: 'Inspected the remote action and retained its outcome.',
      },
      undefined,
    );
    await send(server, 'threads.add_user_message', {
      thread_id: thread.id,
      input: { content: [{ type: 'input_text', text: 'new message' }] },
    });
    expect(server.calls).toBe(1);
  });
  it('retries an accepted client result after an explicitly retryable continuation error', async () => {
    const { store, server } = await fixture();
    await call(store);
    server.failure = new CustomStreamError(
      'Temporary failure before dispatch.',
      true,
    );
    const params = { thread_id: thread.id, result: { value: null } };
    expect(
      await send(server, 'threads.add_client_tool_output', params),
    ).toContainEqual(
      expect.objectContaining({ type: 'error', allow_retry: true }),
    );
    server.failure = undefined;
    expect(
      await send(server, 'threads.add_client_tool_output', params),
    ).toContainEqual({ type: 'progress_update', text: 'continued' });
    await send(server, 'threads.add_client_tool_output', params);
    expect(server.calls).toBe(2);
  });
  it('requires reconciliation after an ambiguous failure and preserves the accepted result', async () => {
    const { store, server } = await fixture();
    await call(store);
    server.failure = new Error('Unknown external outcome.');
    const params = { thread_id: thread.id, result: 'value' };
    expect(
      await send(server, 'threads.add_client_tool_output', params),
    ).toContainEqual(
      expect.objectContaining({ type: 'error', allow_retry: false }),
    );
    await expect(
      send(server, 'threads.add_client_tool_output', params),
    ).rejects.toThrow(/reconcil/i);
    expect(await store.loadItem(thread.id, 'tool_1')).toMatchObject({
      status: 'completed',
      output: 'value',
    });
    server.failure = undefined;
    await server.recoverOperation(
      thread.id,
      {
        decision: 'retry',
        note: 'Verified that no external side effect occurred.',
      },
      undefined,
    );
    await send(server, 'threads.add_client_tool_output', params);
    expect(server.calls).toBe(2);
  });
  it('rolls back every suffix deletion when a retry fails midway', async () => {
    const { store, server } = await fixture();
    await store.saveItem(thread.id, {
      id: 'user',
      thread_id: thread.id,
      created_at: thread.created_at,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'hello' }],
      attachments: [],
      inference_options: {},
    });
    for (const id of ['answer_1', 'answer_2'])
      await store.saveItem(thread.id, {
        id,
        thread_id: thread.id,
        created_at: thread.created_at,
        type: 'assistant_message',
        content: [{ type: 'output_text', text: id, annotations: [] }],
      });
    const remove = store.deleteThreadItem.bind(store);
    vi.spyOn(store, 'deleteThreadItem')
      .mockImplementationOnce(remove)
      .mockRejectedValueOnce(new Error('Write unavailable.'));
    await expect(
      send(server, 'threads.retry_after_item', {
        thread_id: thread.id,
        item_id: 'user',
      }),
    ).rejects.toThrow('Write unavailable.');
    expect(
      (await store.loadThreadItems(thread.id, null, 10, 'asc')).data.map(
        (item) => item.id,
      ),
    ).toEqual(['user', 'answer_1', 'answer_2']);
    expect(server.calls).toBe(0);
  });
});
