import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { Manifest, type SandboxClient } from '@openai/agents/sandbox';
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
) {
  const config = {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => {
      if (settings[key] === undefined) throw new Error(`${key} missing`);
      return settings[key];
    },
  } as unknown as ConfigService;
  const openai = { client: () => api } as unknown as OpenaiService;
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
  });

  it('creates one machine per session and records it', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi(), prisma);

    await service.handleHostedWebhook(connectEvent, {});
    await service.handleHostedWebhook(connectEvent, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows).toMatchObject([
      {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        machineId: 'digitalocean:do_1',
      },
    ]);
  });

  it('creates one machine when two servers get the webhook at once', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    const first = sandboxService(remoteSettings, hostedApi(), prisma);
    const second = sandboxService(remoteSettings, hostedApi(), prisma);

    await Promise.all([
      first.handleHostedWebhook(connectEvent, {}),
      second.handleHostedWebhook(connectEvent, {}),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows).toHaveLength(1);
  });

  it('removes the claim when the machine cannot be created', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    const { db, prisma } = fakePrisma();
    const service = sandboxService(remoteSettings, hostedApi(), prisma);

    await expect(service.handleHostedWebhook(connectEvent, {})).rejects.toThrow(
      /status 500/,
    );
    expect(db.remoteMachine.rows).toEqual([]);
  });

  it('deletes the machine when its id cannot be recorded', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    db.remoteMachine.updateMany = async () => {
      throw new Error('database write failed');
    };
    const service = sandboxService(remoteSettings, hostedApi(), prisma);

    await expect(service.handleHostedWebhook(connectEvent, {})).rejects.toThrow(
      'database write failed',
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  });

  it('takes over a claim left by a crashed create', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: {
        sessionId: 'sess_1',
        environmentId: 'env_1',
        claimToken: 'crashed',
        claimedAt: new Date(Date.now() - 11 * 60_000),
      },
    });
    const service = sandboxService(remoteSettings, hostedApi(), prisma);

    await service.handleHostedWebhook(connectEvent, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.remoteMachine.rows[0]).toMatchObject({
      machineId: 'digitalocean:do_1',
    });
  });

  it('leaves a fresh claim alone', async () => {
    const fetchMock = digitalOcean();
    const { db, prisma } = fakePrisma();
    await db.remoteMachine.create({
      data: { sessionId: 'sess_1', environmentId: 'env_1', claimToken: 'busy' },
    });
    const service = sandboxService(remoteSettings, hostedApi(), prisma);

    await service.handleHostedWebhook(connectEvent, {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes the machine when its environment expires or its session fails', async () => {
    for (const [event, status] of [
      [{ type: 'agent.environment.expired', data: { id: 'env_1' } }, 'idle'],
      [{ type: 'agent.session.failed', data: { id: 'sess_1' } }, 'failed'],
    ] as const) {
      const fetchMock = digitalOcean();
      const { db, prisma } = fakePrisma();
      await db.remoteMachine.create({
        data: {
          sessionId: 'sess_1',
          environmentId: 'env_1',
          claimToken: 'done',
          machineId: 'digitalocean:do_1',
        },
      });
      const service = sandboxService(remoteSettings, hostedApi(status), prisma);

      await service.handleHostedWebhook(JSON.stringify(event), {});

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.digitalocean.com/v2/agents/sessions/do_1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(db.remoteMachine.rows).toEqual([]);
    }
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
    vi.unstubAllEnvs();
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
});
