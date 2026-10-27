import { ConfigService } from '@nestjs/config';
import Client, { Auth, createFetchTransport } from '@composio/client';
import { ToolRouterSession } from '@composio/core';
import { OpenAIAgentsProvider } from '@composio/openai-agents';
import { RunContext, setTracingDisabled, tool } from '@openai/agents';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ComposioActionError,
  ComposioService,
} from '@/lib/composio/composio.service.js';
import { fakePrisma } from './fake-prisma.js';

vi.hoisted(() => vi.stubEnv('TELEMETRY_DISABLED', 'true'));
setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.unstubAllEnvs());

// Execute and parse with the installed SDKs. Only discovery and HTTP dispatch are replaced.
async function fixture(
  dispatch: (request: Request) => Promise<Response>,
  name = 'COMPOSIO_MULTI_EXECUTE_TOOL',
) {
  const sent = vi.fn(dispatch);
  const client = new Client({
    auth: Auth.none(),
    transport: createFetchTransport({
      fetch: async (input, init) => await sent(new Request(input, init)),
    }),
  });
  const session = new ToolRouterSession(
    client,
    { provider: new OpenAIAgentsProvider() },
    'session-review',
    { type: 'http', url: 'https://example.invalid/mcp' },
  );
  vi.spyOn(session, 'tools').mockResolvedValue([
    tool({
      name,
      description: 'Review tool.',
      parameters: z.object({}),
      execute: async () => 'unused',
    }),
  ]);
  const service = new ComposioService(
    new ConfigService({ NODE_ENV: 'development', COMPOSIO_ENABLED: true }),
    fakePrisma().prisma,
  );
  Object.defineProperty(service, 'client', {
    value: { create: async () => session },
  });
  const { tools } = await service.tools('user-review');
  const action = tools[0];
  if (action.type !== 'function') throw new Error('Expected function tool.');
  return {
    sent,
    invoke: (signal?: AbortSignal) =>
      action.invoke(new RunContext(), '{}', {
        signal,
        toolCall: {
          type: 'function_call',
          name,
          callId: 'call-review',
          arguments: '{}',
        },
      }),
  };
}

function completed(data: Record<string, unknown>) {
  return Response.json({
    result_type: 'completed',
    error: null,
    log_id: 'batch-log',
    data,
  });
}

describe('Composio offline transport contracts', () => {
  it.each(['http500', 'connection'] as const)(
    'dispatches an action only once after a %s failure',
    async (failure) => {
      const { sent, invoke } = await fixture(async () => {
        if (failure === 'connection')
          throw new Error('Socket closed after dispatch.');
        return Response.json(
          { error: 'Failure after dispatch.' },
          { status: 500 },
        );
      });
      await expect(invoke()).rejects.toBeInstanceOf(ComposioActionError);
      expect(sent).toHaveBeenCalledTimes(1);
    },
  );

  it('does not dispatch an already cancelled action', async () => {
    const { sent, invoke } = await fixture(async () => completed({}));
    await expect(invoke(AbortSignal.abort())).rejects.toThrow();
    expect(sent).not.toHaveBeenCalled();
  });

  it('forwards cancellation during dispatch and marks the outcome uncertain', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { sent, invoke } = await fixture(async (request) => {
      entered();
      return await new Promise<Response>((_, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
    });
    const controller = new AbortController();
    const outcome = invoke(controller.signal).catch((error) => error);
    await started;
    controller.abort();
    expect(await outcome).toBeInstanceOf(ComposioActionError);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('requires reconciliation when a hook blocks an already executed action result', async () => {
    const { invoke } = await fixture(async () =>
      Response.json({
        result_type: 'blocked',
        message: 'Result withheld.',
        reason: { type: 'response_blocked', hook_id: 'hook-review' },
        log_id: 'blocked-log',
      }),
    );
    await expect(invoke()).rejects.toMatchObject({
      name: 'ComposioActionError',
      sessionId: 'session-review',
      callId: 'call-review',
      logId: 'blocked-log',
    });
  });

  it('returns a refusal when the hook prevents dispatch', async () => {
    const { invoke } = await fixture(async () =>
      Response.json({
        result_type: 'blocked',
        message: 'Request refused.',
        reason: { type: 'request_blocked', hook_id: 'hook-review' },
        log_id: 'blocked-log',
      }),
    );
    await expect(invoke()).resolves.toMatchObject({
      resultType: 'blocked',
      blockReason: { type: 'request_blocked' },
    });
  });

  it.each([
    { error_count: 1 },
    {
      results: [
        {
          tool_slug: 'APP_SEND',
          response: { successful: true, data: { id: 'sent' } },
        },
        {
          tool_slug: 'APP_WRITE',
          response: { successful: false, data: {}, error: null },
        },
      ],
    },
    {
      results: [
        { tool_slug: 'APP_WRITE', response: { error: 'Unknown outcome.' } },
      ],
    },
    { results: [{ tool_slug: 'APP_WRITE', error: 'Unknown outcome.' }] },
  ])(
    'requires reconciliation for a completed batch with failed child executions (%j)',
    async (data) => {
      const { invoke } = await fixture(async () => completed(data));
      await expect(invoke()).rejects.toMatchObject({
        name: 'ComposioActionError',
        logId: 'batch-log',
      });
    },
  );

  it('accepts an all-success batch without interpreting business data as execution failures', async () => {
    const data = {
      error_count: 0,
      results: [
        {
          tool_slug: 'APP_READ',
          response: {
            successful: true,
            error: null,
            data: {
              error_count: 7,
              successful: false,
              error: 'A business record.',
            },
          },
        },
      ],
    };
    const { invoke } = await fixture(async () => completed(data));
    await expect(invoke()).resolves.toMatchObject({
      resultType: 'completed',
      data,
    });
  });

  it('does not interpret another tool payload as the batch envelope', async () => {
    const data = { error_count: 2, results: [{ error: 'Application data.' }] };
    const { invoke } = await fixture(async () => completed(data), 'APP_READ');
    await expect(invoke()).resolves.toMatchObject({
      resultType: 'completed',
      data,
    });
  });
});
