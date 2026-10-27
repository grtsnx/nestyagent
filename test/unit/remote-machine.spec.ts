import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { Manifest, type SandboxClient } from '@openai/agents/sandbox';
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local';
import type { Session } from '@openai/agents';
import { APIError } from 'openai';
import type { OpenaiService } from '@/lib/openai/openai.service.js';
import { fakePrisma } from './fake-prisma.js';
import {
  awsRunArgs,
  awsTerminateArgs,
  databricksExecutorScript,
  digitalOceanManifest,
  executorEnvironment,
  SandboxService,
} from '@/lib/sandbox/sandbox.service.js';

function sandboxService(
  settings: Record<string, string>,
  api: Record<string, unknown> = {},
  prisma = fakePrisma().prisma,
  openaiMethods: Record<string, unknown> = {},
) {
  const config = {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => {
      if (settings[key] === undefined) throw new Error(`${key} missing`);
      return settings[key];
    },
  } as unknown as ConfigService;
  const openai = {
    client: () => api,
    ...openaiMethods,
  } as unknown as OpenaiService;
  return new SandboxService(config, openai, prisma);
}

// A self-hosted session that waits for its machine.
function hostedApi(status = 'idle') {
  return {
    webhooks: { unwrap: async (body: string) => JSON.parse(body) },
    beta: {
      agents: {
        sessions: {
          retrieve: async () => ({
            id: 'sess_1',
            status,
            environment: {
              type: 'self_hosted',
              id: 'env_1',
              remote_url: 'wss://example.com',
            },
            required_actions: [{ type: 'environment_connection' }],
          }),
        },
      },
    },
  };
}

// DigitalOcean answers a create with do_1 and a delete with an empty 200.
function digitalOcean() {
  const fetchMock = vi.fn(
    async (_url: URL | string, init?: RequestInit) =>
      new Response(
        init?.method === 'DELETE' ? null : JSON.stringify({ id: 'do_1' }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const remoteSettings = {
  OPENAI_WEBHOOK_SECRET: 'whsec',
  OPENAI_EXECUTOR_API_KEY: 'executor-secret',
  REMOTE_MACHINE_PROVIDER: 'digitalocean',
  DIGITALOCEAN_TOKEN: 'do-token',
};

const connectEvent = JSON.stringify({
  type: 'agent.session.action_required',
  data: { id: 'sess_1', required_action: { type: 'environment_connection' } },
});
const failedEvent = JSON.stringify({
  type: 'agent.session.failed',
  data: { id: 'sess_1' },
});

describe('remote machine commands', () => {
  it('builds the AWS MicroVM run and terminate commands', () => {
    expect(
      awsRunArgs({
        image: 'arn:aws:lambda:us-east-1:123:microvm-image:codex',
        payload: '{"environmentId":"env_1"}',
        region: 'us-east-1',
        executionRole: 'arn:aws:iam::123:role/microvm',
      }),
    ).toEqual([
      'lambda-microvms',
      'run-microvm',
      '--image-identifier',
      'arn:aws:lambda:us-east-1:123:microvm-image:codex',
      '--run-hook-payload',
      '{"environmentId":"env_1"}',
      '--output',
      'json',
      '--execution-role-arn',
      'arn:aws:iam::123:role/microvm',
      '--region',
      'us-east-1',
    ]);

    expect(awsTerminateArgs('mvm-1', 'us-east-1')).toEqual([
      'lambda-microvms',
      'terminate-microvm',
      '--microvm-identifier',
      'mvm-1',
      '--region',
      'us-east-1',
    ]);
  });

  it('keeps the executor key out of the Databricks shell script', () => {
    const script = databricksExecutorScript({
      sessionId: 'sess_1',
      environmentId: 'env_1',
      remoteUrl: 'https://api.openai.com/v1/agents/api',
      executorKey: 'executor-secret',
    });

    expect(script).toContain('codex exec-server');
    expect(script).not.toContain('executor-secret');
  });

  it('puts the Codex connection values in the DigitalOcean manifest', () => {
    const manifest = digitalOceanManifest({
      sessionId: 'sess_1',
      environmentId: 'env_1',
      remoteUrl: 'https://api.openai.com/v1/agents/api',
      executorKey: 'executor-secret',
    });

    expect(manifest).toContain('agent: codex-agentapi');
    expect(manifest).toContain('CODEX_ENVIRONMENT_ID: "env_1"');
    expect(manifest).toContain('CODEX_API_KEY: "executor-secret"');
  });

  it('quotes DigitalOcean values so a key cannot break the YAML', () => {
    const manifest = digitalOceanManifest({
      sessionId: 'sess_1',
      environmentId: 'env_1',
      remoteUrl: 'https://api.openai.com/v1/agents/api',
      executorKey: 'key: with\nnewline',
    });

    expect(manifest).toContain('CODEX_API_KEY: "key: with\\nnewline"');
  });
});

describe('self-hosted machines', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('ignores a delayed failure event after the session has recovered', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'ready',
        machineId: 'digitalocean:do_1',
        status: 'ready',
      },
    });
    const service = sandboxService(remoteSettings, hostedApi('idle'), prisma);
    await service.handleHostedWebhook(failedEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'ready',
      desiredState: 'active',
      machineId: 'digitalocean:do_1',
    });
    expect(db.hostedWebhook.rows[0]).toMatchObject({ status: 'completed' });
  });

  it('abandons failed-session cleanup retries when the session recovers', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'ready',
        machineId: 'digitalocean:do_1',
        status: 'ready',
      },
    });
    let currentStatus = 'failed';
    const api = hostedApi();
    const retrieve = api.beta.agents.sessions.retrieve;
    api.beta.agents.sessions.retrieve = async () => ({
      ...(await retrieve()),
      status: currentStatus,
    });
    const service = sandboxService(remoteSettings, api, prisma);
    await service.handleHostedWebhook(failedEvent, {});
    await service.processHostedWebhooks();
    currentStatus = 'idle';
    db.hostedWebhook.rows[0].availableAt = new Date(0);
    await service.processHostedWebhooks();
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'ready',
      desiredState: 'active',
      machineId: 'digitalocean:do_1',
    });
  });

  it.each([
    ['digitalocean:do_1', new Date(), 'pending'],
    ['digitalocean:do_1', new Date(0), 'reconciliation'],
    ['local:missing-owner:123', new Date(), 'reconciliation'],
  ] as const)(
    'keeps unresolved reconnect work for %s created at %s as %s',
    async (machineId, claimedAt, status) => {
      const fetchMock = digitalOcean();
      const { db, prisma } = fakePrisma();
      await db.remoteMachine.create({
        data: {
          sessionId: 'sess_1',
          environmentId: 'env_1',
          claimToken: 'ready',
          machineId,
          claimedAt,
          status: 'ready',
        },
      });
      const service = sandboxService(remoteSettings, hostedApi('idle'), prisma);
      await service.handleHostedWebhook(connectEvent, {});
      await service.processHostedWebhooks();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.hostedWebhook.rows[0]).toMatchObject({ status });
      expect(db.remoteMachine.rows[0]).toMatchObject({
        machineId,
        desiredState: 'active',
        status: status === 'pending' ? 'ready' : 'reconciliation',
      });
    },
  );

  it('requires reconciliation when an exited local executor is asked to reconnect', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'exited',
        provider: 'local',
        status: 'deleted',
        desiredState: 'deleted',
        machineId: null,
      },
    });
    const service = sandboxService(remoteSettings, hostedApi('idle'), prisma);
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.hostedWebhook.rows[0]).toMatchObject({
      status: 'reconciliation',
    });
    expect(db.remoteMachine.rows[0]).toMatchObject({
      desiredState: 'active',
      status: 'reconciliation',
      lastError: 'executor_connection_missing',
    });
  });

  it('completes reconnect work once the session no longer needs a connection', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'ready',
        machineId: 'digitalocean:do_1',
        claimedAt: new Date(0),
        status: 'ready',
      },
    });
    const api = hostedApi();
    const retrieve = api.beta.agents.sessions.retrieve;
    api.beta.agents.sessions.retrieve = async () => ({
      ...(await retrieve()),
      required_actions: [],
    });
    const service = sandboxService(remoteSettings, api, prisma);
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.hostedWebhook.rows[0]).toMatchObject({ status: 'completed' });
    expect(db.remoteMachine.rows[0]).toMatchObject({ status: 'ready' });
  });

  it('does not treat historical session failures as permanent expiry tombstones', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi('idle'), prisma);
    await service.handleHostedWebhook(failedEvent, {});
    await service.processHostedWebhooks();
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows[0]).toMatchObject({ status: 'ready' });
  });

  it('cleans up a failed session that no longer exists', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'ready',
        machineId: 'digitalocean:do_1',
        status: 'ready',
      },
    });
    const api = hostedApi();
    api.beta.agents.sessions.retrieve = vi
      .fn()
      .mockRejectedValue(
        new APIError(404, {}, 'Session missing', new Headers()),
      );
    const service = sandboxService(remoteSettings, api, prisma);
    await service.handleHostedWebhook(failedEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
    expect(db.remoteMachine.rows[0]).toMatchObject({ status: 'deleted' });
  });

  it.each(['idle', 'failed'])(
    'checks live failure status after provisioning when the session is %s',
    async (status) => {
      const { db, prisma } = fakePrisma();
      const api = hostedApi();
      let currentStatus = 'idle';
      const retrieve = api.beta.agents.sessions.retrieve;
      api.beta.agents.sessions.retrieve = async () => ({
        ...(await retrieve()),
        status: currentStatus,
      });
      const service = sandboxService(remoteSettings, api, prisma);
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          currentStatus = status;
          await service.handleHostedWebhook(failedEvent, {});
          return new Response(JSON.stringify({ id: 'do_1' }));
        }
        return new Response(null);
      });
      vi.stubGlobal('fetch', fetchMock);
      await service.handleHostedWebhook(connectEvent, {});
      await service.processHostedWebhooks();
      await service.processHostedWebhooks();
      expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(
        status === 'failed' ? ['POST', 'DELETE'] : ['POST'],
      );
      expect(db.remoteMachine.rows[0]).toMatchObject({
        status: status === 'failed' ? 'deleted' : 'ready',
      });
    },
  );

  it('acknowledges a verified webhook before making provider requests', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(connectEvent, { 'webhook-id': 'evt_1' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.hostedWebhook.rows).toMatchObject([
      { id: 'evt_1', resourceId: 'sess_1', status: 'pending' },
    ]);
  });

  it('does not acknowledge an event when its durable insert fails', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    db.hostedWebhook.create = async () => {
      throw new Error('database unavailable');
    };
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await expect(service.handleHostedWebhook(connectEvent, {})).rejects.toThrow(
      'database unavailable',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deduplicates deliveries and creates one machine across workers', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const first = sandboxService(remoteSettings, hostedApi(), prisma);
    const second = sandboxService(remoteSettings, hostedApi(), prisma);
    await Promise.all([
      first.handleHostedWebhook(connectEvent, { 'webhook-id': 'evt_1' }),
      second.handleHostedWebhook(connectEvent, { 'webhook-id': 'evt_1' }),
    ]);
    await Promise.all([
      first.processHostedWebhooks(),
      second.processHostedWebhooks(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.hostedWebhook.rows).toMatchObject([{ status: 'completed' }]);
    expect(db.remoteMachine.rows).toMatchObject([
      {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        machineId: 'digitalocean:do_1',
        status: 'ready',
      },
    ]);
  });

  it('retries a transient session lookup failure on a later worker', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const api = hostedApi();
    const retrieve = api.beta.agents.sessions.retrieve;
    api.beta.agents.sessions.retrieve = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(retrieve);
    const first = sandboxService(remoteSettings, api, prisma);
    await first.handleHostedWebhook(connectEvent, {});
    await first.processHostedWebhooks();
    expect(db.hostedWebhook.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    db.hostedWebhook.rows[0].availableAt = new Date(0);
    await sandboxService(remoteSettings, api, prisma).processHostedWebhooks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.hostedWebhook.rows[0]).toMatchObject({ status: 'completed' });
  });

  it('recovers a processing event after its worker lease expires', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(connectEvent, {});
    Object.assign(db.hostedWebhook.rows[0], {
      status: 'processing',
      leaseToken: 'crashed',
      leaseExpiresAt: new Date(0),
    });
    await service.processHostedWebhooks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.hostedWebhook.rows[0]).toMatchObject({
      status: 'completed',
      leaseToken: null,
    });
  });

  it('retains an ambiguous create for reconciliation instead of creating again', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection lost after create');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    await service.handleHostedWebhook(connectEvent, { 'webhook-id': 'retry' });
    await service.processHostedWebhooks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'reconciliation',
      machineId: null,
    });
    expect(
      db.hostedWebhook.rows.every((row) => row.status === 'reconciliation'),
    ).toBe(true);
    const successfulFetch = digitalOcean();
    await service.reconcileRemoteMachine('sess_1', { absent: true });
    await service.processHostedWebhooks();
    expect(successfulFetch).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows[0]).toMatchObject({ status: 'ready' });
  });

  it.each([0, 11 * 60_000])(
    'does not blindly reuse a crashed create claim aged %i ms',
    async (age) => {
      const fetchMock = digitalOcean();
      const { db, prisma } = fakePrisma();
      await db.remoteMachine.create({
        data: {
          sessionId: 'sess_1',
          environmentId: 'env_1',
          claimToken: 'crashed',
          status: 'creating',
          claimedAt: new Date(Date.now() - age),
        },
      });
      const service = sandboxService(remoteSettings, hostedApi(), prisma);
      await service.handleHostedWebhook(connectEvent, {});
      await service.processHostedWebhooks();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.remoteMachine.rows[0]).toMatchObject({
        status: 'reconciliation',
      });
      expect(db.hostedWebhook.rows[0]).toMatchObject({
        status: 'reconciliation',
      });
    },
  );

  it('deletes a machine when expiry arrives while its provider is creating it', async () => {
    let finishCreate!: () => void;
    let announceCreate!: () => void;
    const creating = new Promise<void>((resolve) => {
      announceCreate = resolve;
    });
    const created = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        announceCreate();
        await created;
        return new Response(JSON.stringify({ id: 'do_1' }));
      }
      return new Response(null);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { db, prisma } = fakePrisma();
    const first = sandboxService(remoteSettings, hostedApi(), prisma);
    const second = sandboxService(remoteSettings, hostedApi(), prisma);
    await first.handleHostedWebhook(connectEvent, {});
    const processing = first.processHostedWebhooks();
    await creating;
    await second.handleHostedWebhook(
      JSON.stringify({
        type: 'agent.environment.expired',
        data: { id: 'env_1' },
      }),
      {},
    );
    await second.processHostedWebhooks();
    finishCreate();
    await processing;
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
      'POST',
      'DELETE',
    ]);
    expect(db.remoteMachine.rows[0]).toMatchObject({
      desiredState: 'deleted',
      status: 'deleted',
      machineId: null,
    });
  });

  it('retains terminal events received before a connection event', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(
      JSON.stringify({
        type: 'agent.environment.expired',
        data: { id: 'env_1' },
      }),
      {},
    );
    await service.processHostedWebhooks();
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      db.hostedWebhook.rows.every((row) => row.status === 'completed'),
    ).toBe(true);
  });

  it('retains the machine and retries cleanup failures', async () => {
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'done',
        machineId: 'digitalocean:do_1',
        status: 'ready',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(
      JSON.stringify({
        type: 'agent.environment.expired',
        data: { id: 'env_1' },
      }),
      {},
    );
    await service.processHostedWebhooks();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      machineId: 'digitalocean:do_1',
      desiredState: 'deleted',
    });
    expect(db.hostedWebhook.rows[0]).toMatchObject({ status: 'pending' });
    digitalOcean();
    db.hostedWebhook.rows[0].availableAt = new Date(0);
    await service.processHostedWebhooks();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'deleted',
      machineId: null,
    });
  });

  it('keeps tracking a local process owned by another replica', async () => {
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'done',
        machineId: 'local:another-owner:123',
        status: 'ready',
      },
    });
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(
      JSON.stringify({
        type: 'agent.environment.expired',
        data: { id: 'env_1' },
      }),
      {},
    );
    await service.processHostedWebhooks();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      machineId: 'local:another-owner:123',
      status: 'reconciliation',
    });
    expect(db.hostedWebhook.rows[0]).toMatchObject({
      status: 'reconciliation',
    });
  });

  it('preserves a known machine id when the first registration write fails', async () => {
    digitalOcean();
    const { db, prisma } = fakePrisma();
    const updateMany = db.remoteMachine.updateMany.bind(db.remoteMachine);
    let failed = false;
    db.remoteMachine.updateMany = async (args) => {
      if (args.data.status === 'ready' && !failed) {
        failed = true;
        throw new Error('database connection reset');
      }
      return await updateMany(args);
    };
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      machineId: 'digitalocean:do_1',
      status: 'reconciliation',
      desiredState: 'deleted',
    });
    expect(db.hostedWebhook.rows[0]).toMatchObject({
      status: 'reconciliation',
    });
    await service.reconcileRemoteMachine('sess_1', {
      machineId: 'digitalocean:do_1',
    });
    await service.processHostedWebhooks();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'deleted',
      machineId: null,
    });
  });

  it('requeues reconciliation atomically with the operator decision', async () => {
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'old',
        status: 'reconciliation',
      },
    });
    db.hostedWebhook.updateMany = async () => {
      throw new Error('database unavailable');
    };
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await expect(
      service.reconcileRemoteMachine('sess_1', { absent: true }),
    ).rejects.toThrow('database unavailable');
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'reconciliation',
    });
  });

  it('preserves Databricks identity when starting the created sandbox fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) =>
        init?.body?.toString().includes('execution_timeout')
          ? new Response(null, { status: 503 })
          : new Response(JSON.stringify({ name: 'sandboxes/openai-sess1' })),
      ),
    );
    const { db, prisma } = fakePrisma();
    const service = sandboxService(
      {
        ...remoteSettings,
        REMOTE_MACHINE_PROVIDER: 'databricks',
        DATABRICKS_HOST: 'https://workspace.example.com',
        DATABRICKS_TOKEN: 'token',
      },
      hostedApi(),
      prisma,
    );
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'reconciliation',
      machineId: 'databricks:sandboxes/openai-sess1',
    });
  });

  it('does not start a second executor when Databricks reports an existing sandbox', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.body?.toString().includes('execution_timeout')
        ? new Response(JSON.stringify({}))
        : new Response(null, { status: 409 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { db, prisma } = fakePrisma();
    const service = sandboxService(
      {
        ...remoteSettings,
        REMOTE_MACHINE_PROVIDER: 'databricks',
        DATABRICKS_HOST: 'https://workspace.example.com',
        DATABRICKS_TOKEN: 'token',
      },
      hostedApi(),
      prisma,
    );
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'reconciliation',
      machineId: 'databricks:sandboxes/openai-sess1',
    });
  });

  it('cancels provider work during shutdown and retains its uncertain outcome', async () => {
    let started!: () => void;
    const creating = new Promise<void>((resolve) => {
      started = resolve;
    });
    let providerAbort: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init: RequestInit) => {
        providerAbort = init.signal as AbortSignal;
        started();
        return new Promise((_resolve, reject) => {
          providerAbort!.addEventListener(
            'abort',
            () => reject(providerAbort!.reason),
            { once: true },
          );
        });
      }),
    );
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(connectEvent, {});
    const processing = service.processHostedWebhooks();
    await creating;
    await service.onModuleDestroy();
    await processing;
    expect(providerAbort?.aborted).toBe(true);
    expect(db.remoteMachine.rows[0]).toMatchObject({
      status: 'reconciliation',
    });
    expect(db.hostedWebhook.rows[0]).toMatchObject({
      status: 'reconciliation',
    });
  });

  it('keeps a late provider success in reconciliation after losing its execution lock', async () => {
    const lock = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        lock.abort(new Error('database lock lost'));
        return new Response(JSON.stringify({ id: 'do_1' }));
      }),
    );
    const { db, prisma } = fakePrisma();
    prisma.withLock = async (_key, work) => await work(lock.signal);
    const service = sandboxService(remoteSettings, hostedApi(), prisma);
    await service.handleHostedWebhook(connectEvent, {});
    await service.processHostedWebhooks();
    expect(db.remoteMachine.rows[0]).toMatchObject({
      machineId: 'digitalocean:do_1',
      status: 'reconciliation',
    });
    expect(db.hostedWebhook.rows[0]).toMatchObject({
      status: 'reconciliation',
    });
  });

  it('rejects a local executor in production before spawning', () => {
    const service = sandboxService({ NODE_ENV: 'production' });
    expect(() =>
      service.startHostedExecutor({
        environmentId: 'env_1',
        remoteUrl: 'wss://example.com',
      }),
    ).toThrow(/production/);
  });

  it('gives the executor its key and none of the app secrets', () => {
    vi.stubEnv('OPENAI_API_KEY', 'app-secret');
    vi.stubEnv('PATH', '/usr/bin');
    const env = executorEnvironment({ CODEX_API_KEY: 'executor-secret' });
    expect(env).toEqual(
      expect.objectContaining({
        PATH: '/usr/bin',
        CODEX_API_KEY: 'executor-secret',
      }),
    );
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });
});

describe('sandbox workspaces', () => {
  function fakeClient() {
    const create = vi.fn(async (args: { manifest: Manifest }) => ({
      state: { manifest: args.manifest },
    }));
    const serializeSessionState = vi.fn(async () => ({ saved: true }));
    return {
      client: {
        backendId: 'fake',
        create,
        serializeSessionState,
      } as unknown as SandboxClient,
      create,
      serializeSessionState,
    };
  }

  it('keeps every manifest field when it adds the password', async () => {
    const fake = fakeClient();
    const service = sandboxService({ ACCOUNT_PASSWORD: 'shared' });

    await service.openSandbox(
      new Manifest({
        root: '/srv/app',
        extraPathGrants: [{ path: '/opt/tools', readOnly: true }],
        remoteMountCommandAllowlist: ['rclone'],
      }),
      { client: fake.client },
    );

    const manifest = fake.create.mock.calls[0][0].manifest;
    expect(manifest.root).toBe('/srv/app');
    expect(manifest.extraPathGrants).toHaveLength(1);
    expect(manifest.remoteMountCommandAllowlist).toEqual(['rclone']);
    expect(manifest.environment.ACCOUNT_PASSWORD).toMatchObject({
      value: 'shared',
      ephemeral: true,
    });
  });

  it('saves with the client that opened the workspace', async () => {
    const fake = fakeClient();
    const service = sandboxService({});
    const workspace = await service.openSandbox(new Manifest(), {
      client: fake.client,
    });

    await expect(
      service.saveSandbox(workspace, { client: fake.client }),
    ).resolves.toEqual({ saved: true });
    expect(fake.serializeSessionState).toHaveBeenCalledWith(workspace.state);
  });

  it('passes cancellation, turn limits, context and chat through the shared runner', async () => {
    const fake = fakeClient();
    const runAgent = vi.fn(async (..._args: unknown[]) => ({
      finalOutput: 'done',
    }));
    const service = sandboxService({}, {}, fakePrisma().prisma, { runAgent });
    const agent = service.createSandboxAgent('sandbox', 'Do the work.');
    const workspace = await service.openSandbox(new Manifest(), {
      client: fake.client,
    });
    const signal = new AbortController().signal;
    const context = { accountId: 'account' };
    const chat = {} as Session;
    await service.runSandbox([{ role: 'user', content: 'hello' }], agent, {
      workspace,
      chat,
      context,
      signal,
      maxTurns: 3,
    });
    expect(runAgent.mock.calls[0][2]).toMatchObject({
      signal,
      maxTurns: 3,
      context,
      session: chat,
      sandbox: { session: workspace },
    });
    await service.runSandboxOnce('hello', agent, {
      client: fake.client,
      chat,
      signal,
      context,
      maxTurns: 4,
    });
    expect(runAgent.mock.calls[1][2]).toMatchObject({
      signal,
      maxTurns: 4,
      context,
      session: chat,
      sandbox: { client: fake.client },
    });
  });

  it('defaults production workspaces to a pinned Docker image', async () => {
    const runAgent = vi.fn(async (..._args: unknown[]) => ({
      finalOutput: 'done',
    }));
    const service = sandboxService(
      { NODE_ENV: 'production' },
      {},
      fakePrisma().prisma,
      { runAgent },
    );
    await service.runSandboxOnce(
      'hello',
      service.createSandboxAgent('sandbox', 'Do the work.'),
    );
    const options = runAgent.mock.calls[0][2] as {
      sandbox: { client: unknown };
    };
    expect(options.sandbox.client).toBeInstanceOf(DockerSandboxClient);
    expect(options.sandbox.client).toMatchObject({
      options: { image: 'node:24-bookworm-slim' },
    });
  });

  it('rejects explicit Unix workspaces in production, including custom Unix clients', async () => {
    const service = sandboxService({ NODE_ENV: 'production' });
    await expect(
      service.openSandbox(new Manifest(), { computer: 'unix' }),
    ).rejects.toThrow(/production/);
    await expect(
      service.openSandbox(new Manifest(), {
        client: new UnixLocalSandboxClient(),
      }),
    ).rejects.toThrow(/production/);
  });
});
