import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { ChildProcess } from 'node:child_process';
import type { ConfigService } from '@nestjs/config';
import type { OpenaiService } from '@/lib/openai/openai.service.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxService } from '@/lib/sandbox/sandbox.service.js';
import { fakePrisma } from './fake-prisma.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn,
}));

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn((_signal?: string) => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
      return true;
    }),
  });
  return child;
}

function service(api: object = {}) {
  return new SandboxService(
    {
      get: () => undefined,
      getOrThrow: () => 'executor-key',
    } as unknown as ConfigService,
    { client: () => api } as unknown as OpenaiService,
    fakePrisma().prisma,
  );
}

const session = {
  sessionId: 'sess_1',
  environmentId: 'env_1',
  remoteUrl: 'wss://example.com',
};

describe('local executor lifecycle', () => {
  beforeEach(() =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('tracks direct executors and stops them during module shutdown', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child as unknown as ChildProcess);
    const sandbox = service();
    sandbox.startHostedExecutor(session);
    await sandbox.onModuleDestroy();
    expect(child.kill).toHaveBeenCalled();
    expect(child.listenerCount('error')).toBeGreaterThan(0);
  });

  it('aborts connection waiting immediately when the executor fails to spawn', async () => {
    const child = childProcess();
    spawn.mockImplementation(() => {
      child.pid = undefined;
      child.kill.mockReturnValue(false);
      queueMicrotask(() =>
        child.emit('error', new Error('executor spawn failed')),
      );
      return child;
    });
    const stream = vi.fn(
      async (_id: string, { signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
          });
          yield { type: 'agent.session.environment.connected' };
        },
      }),
    );
    const sandbox = service({
      beta: { agents: { sessions: { events: { stream } } } },
    });
    await expect(sandbox.connectHostedSession(session, 30)).rejects.toThrow(
      'executor spawn failed',
    );
    await sandbox.onModuleDestroy();
  });
});
