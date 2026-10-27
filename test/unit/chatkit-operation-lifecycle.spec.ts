import { describe, expect, it } from 'vitest';
import {
  ChatKitService,
  CustomStreamError,
  MemoryStore,
  type ThreadMetadata,
  type ThreadStreamEvent,
} from '@/lib/chatkit/chatkit.service.js';

const thread = (id: string): ThreadMetadata => ({
  id,
  created_at: new Date().toISOString(),
  status: { type: 'active' },
  metadata: {},
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('MemoryStore transaction isolation', () => {
  it('does not roll back another transaction that commits to an unrelated thread', async () => {
    const store = new MemoryStore();
    await store.saveThread(thread('A'));
    const entered = gate();
    const finish = gate();
    const failed = store
      .transaction('A', {}, async (tx) => {
        await tx.saveThread({ ...thread('A'), title: 'uncommitted' }, {});
        entered.release();
        await finish.promise;
        throw new Error('rollback A');
      })
      .catch((error) => error);
    await entered.promise;
    const successful = store.transaction('B', {}, async (tx) => {
      await tx.saveThread(thread('B'), {});
    });
    await Promise.resolve();
    finish.release();
    await Promise.all([failed, successful]);
    await expect(store.loadThread('B')).resolves.toMatchObject({ id: 'B' });
    await expect(store.loadThread('A')).resolves.not.toHaveProperty('title');
  });

  it('serializes overlapping writes and permits nested transaction composition', async () => {
    const store = new MemoryStore();
    await store.saveThread(thread('A'));
    const entered = gate();
    const finish = gate();
    const first = store
      .transaction('A', {}, async (tx) => {
        await tx.transaction('A', {}, async (inner) => {
          await inner.saveThread({ ...thread('A'), title: 'rollback' }, {});
        });
        entered.release();
        await finish.promise;
        throw new Error('rollback');
      })
      .catch((error) => error);
    await entered.promise;
    const second = store.transaction('A', {}, async (tx) => {
      await tx.saveThread({ ...thread('A'), title: 'committed second' }, {});
    });
    await Promise.resolve();
    finish.release();
    await Promise.all([first, second]);
    await expect(store.loadThread('A')).resolves.toMatchObject({
      title: 'committed second',
    });
  });

  it('restores only transaction mutations across thread, item, and attachment keys', async () => {
    const store = new MemoryStore();
    await store.saveThread(thread('A'));
    const item = {
      type: 'sdk_hidden_context' as const,
      id: 'item',
      thread_id: 'A',
      created_at: thread('A').created_at,
      content: 'original',
    };
    await store.saveItem('A', item);
    await store.saveAttachment({
      type: 'file',
      id: 'file',
      name: 'original',
      mime_type: 'text/plain',
    });
    await expect(
      store.transaction('A', {}, async (tx) => {
        await tx.deleteThreadItem('A', 'item', {});
        await tx.saveAttachment(
          {
            type: 'file',
            id: 'file',
            name: 'changed',
            mime_type: 'text/plain',
          },
          {},
        );
        await tx.saveThread(thread('new'), {});
        throw new Error('rollback all touched keys');
      }),
    ).rejects.toThrow('rollback all touched keys');
    await expect(store.loadItem('A', 'item')).resolves.toEqual(item);
    await expect(store.loadAttachment('file')).resolves.toHaveProperty(
      'name',
      'original',
    );
    await expect(store.loadThread('new')).rejects.toThrow();
  });
});

describe('ChatKit operation stream lifecycle', () => {
  class Server extends ChatKitService<unknown> {
    calls = 0;
    closed = 0;
    failure?: Error;
    async *respond(): AsyncGenerator<ThreadStreamEvent> {
      this.calls++;
      try {
        if (this.failure) throw this.failure;
        yield { type: 'progress_update', text: 'executing' };
      } finally {
        this.closed++;
      }
    }
  }
  async function fixture() {
    const store = new MemoryStore();
    const current = thread('T');
    await store.saveThread(current);
    await store.saveItem('T', {
      type: 'client_tool_call',
      id: 'browser',
      call_id: 'call',
      thread_id: 'T',
      created_at: current.created_at,
      name: 'browser',
      arguments: {},
      status: 'pending',
    });
    const server = new Server(store);
    const open = async () => {
      const result = await server.process(
        JSON.stringify({
          type: 'threads.add_client_tool_output',
          params: { thread_id: 'T', result: 'accepted' },
        }),
        {},
      );
      if (!result.streaming) throw new Error('Expected stream.');
      return result.stream[Symbol.asyncIterator]();
    };
    const status = async () =>
      (
        (await store.loadThread('T')).metadata._chatkit_operation as {
          status: string;
        }
      ).status;
    return { store, server, open, status };
  }

  it('leaves accepted output pending when the iterator closes before dispatch', async () => {
    const f = await fixture();
    const first = await f.open();
    expect((await first.next()).value).toContain('stream_options');
    await first.return?.(undefined);
    expect(f.server.calls).toBe(0);
    expect(await f.status()).toBe('pending');
    const retry = await f.open();
    while (!(await retry.next()).done) {
      /* drain */
    }
    expect(f.server.calls).toBe(1);
    expect(await f.status()).toBe('completed');
  });

  it('requires reconciliation when the iterator closes after dispatch', async () => {
    const f = await fixture();
    const stream = await f.open();
    await stream.next();
    expect((await stream.next()).value).toContain('executing');
    await stream.return?.(undefined);
    expect(f.server.closed).toBe(1);
    expect(await f.status()).toBe('recovery_required');
    await expect((await f.open()).next()).rejects.toThrow(/reconcil/i);
  });

  it('does not override an explicitly safe retry decision during iterator shutdown', async () => {
    const f = await fixture();
    f.server.failure = new CustomStreamError('No effect was dispatched.', true);
    const stream = await f.open();
    await stream.next();
    expect((await stream.next()).value).toContain('"allow_retry":true');
    await stream.return?.(undefined);
    expect(await f.status()).toBe('pending');
  });
});
