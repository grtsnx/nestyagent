import { vi } from 'vitest';
import {
  ChatKitService,
  CHAT_PAUSED,
  ConflictError,
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
// What an operator reads before deciding: the current operation's id and attempt.
async function reviewed(server: Server) {
  const operation = await server.loadOperation(thread.id, undefined);
  if (!operation) throw new Error('Expected an operation.');
  return { operationId: operation.id, attempt: operation.attempt ?? 0 };
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
        ...(await reviewed(server)),
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
  it('never forgets an accepted retry id, however many follow', async () => {
    const { server } = await fixture();
    await send(server, 'threads.add_user_message', {
      thread_id: thread.id,
      input: { content: [{ type: 'input_text', text: 'first' }] },
    });
    const first = (
      await server.store.loadThreadItems(thread.id, null, 1, 'asc', undefined)
    ).data[0];
    const params = { thread_id: thread.id, item_id: first.id };
    for (let index = 0; index < 60; index++)
      await send(server, 'threads.retry_after_item', params, {
        operation_id: `request-${index}`,
      });
    const calls = server.calls;
    // The first id is older than any fixed window. Replaying it must not run again.
    await send(server, 'threads.retry_after_item', params, {
      operation_id: 'request-0',
    });
    expect(server.calls).toBe(calls);
    expect(
      await server.store.loadOperationReceipt(
        thread.id,
        'request:request-0',
        undefined,
      ),
    ).toMatchObject({ status: 'completed' });
    // Receipts are stored apart, so the thread itself stays small.
    expect(
      (await server.store.loadThread(thread.id, undefined)).metadata,
    ).not.toHaveProperty('_chatkit_retry_receipts');
  });

  it('applies a recovery decision only to the operation it reviewed', async () => {
    const { store, server } = await fixture();
    await call(store);
    server.failure = new Error('Unknown external outcome.');
    await send(server, 'threads.add_client_tool_output', {
      thread_id: thread.id,
      result: 'a',
    });
    const a = await reviewed(server);
    const note = 'Checked operation A.';
    await server.recoverOperation(
      thread.id,
      { ...a, decision: 'cancel', note },
      undefined,
    );
    // Repeating the same decision finds A already settled.
    await expect(
      server.recoverOperation(
        thread.id,
        { ...a, decision: 'cancel', note },
        undefined,
      ),
    ).rejects.toThrow(ConflictError);

    // Operation B starts and is interrupted too.
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
    await send(
      server,
      'threads.add_client_tool_output',
      { thread_id: thread.id, result: 'b' },
      { client_tool_call_id: 'call_2' },
    );
    const b = await server.loadOperation(thread.id, undefined);
    expect(b).toMatchObject({ status: 'recovery_required' });
    expect(b?.id).not.toBe(a.operationId);

    // A delayed "retry A" must not make B retryable.
    await expect(
      server.recoverOperation(
        thread.id,
        { ...a, decision: 'retry', note },
        undefined,
      ),
    ).rejects.toThrow(ConflictError);
    expect(await server.loadOperation(thread.id, undefined)).toEqual(b);
  });

  it('refuses a decision made for an earlier attempt of the same operation', async () => {
    const { store, server } = await fixture();
    await call(store);
    server.failure = new Error('Unknown external outcome.');
    const params = { thread_id: thread.id, result: 'value' };
    await send(server, 'threads.add_client_tool_output', params);
    const first = await reviewed(server);
    expect(first.attempt).toBe(1);
    const retry = {
      ...first,
      decision: 'retry' as const,
      note: 'Checked attempt 1: nothing happened.',
    };
    await server.recoverOperation(thread.id, retry, undefined);
    // The resend is attempt 2, and it is interrupted again.
    await send(server, 'threads.add_client_tool_output', params);
    const second = await server.loadOperation(thread.id, undefined);
    expect(second).toMatchObject({
      id: first.operationId,
      attempt: 2,
      status: 'recovery_required',
    });
    // The duplicate of the attempt-1 decision arrives late and must not retry attempt 2.
    await expect(
      server.recoverOperation(thread.id, retry, undefined),
    ).rejects.toThrow(ConflictError);
    expect(await server.loadOperation(thread.id, undefined)).toEqual(second);
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
      {
        ...(await reviewed(server)),
        decision: 'retry',
        note: 'Reconciled the incomplete attempt.',
      },
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
    expect(
      await send(server, 'threads.add_client_tool_output', params),
    ).toEqual([
      {
        type: 'error',
        code: 'custom',
        message: CHAT_PAUSED,
        allow_retry: false,
      },
    ]);
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
    expect(
      await send(server, 'threads.add_user_message', {
        thread_id: thread.id,
        input: { content: [{ type: 'input_text', text: 'new message' }] },
      }),
    ).toEqual([
      {
        type: 'error',
        code: 'custom',
        message: CHAT_PAUSED,
        allow_retry: false,
      },
    ]);
    expect(
      (await store.loadThreadItems(thread.id, null, 10, 'asc')).data,
    ).toHaveLength(0);
    await server.recoverOperation(
      thread.id,
      {
        ...(await reviewed(server)),
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
    expect(
      await send(server, 'threads.add_client_tool_output', params),
    ).toEqual([
      {
        type: 'error',
        code: 'custom',
        message: CHAT_PAUSED,
        allow_retry: false,
      },
    ]);
    expect(await store.loadItem(thread.id, 'tool_1')).toMatchObject({
      status: 'completed',
      output: 'value',
    });
    server.failure = undefined;
    await server.recoverOperation(
      thread.id,
      {
        ...(await reviewed(server)),
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
