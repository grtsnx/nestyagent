import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';

const runFile = promisify(execFile);

export type RemoteMachineProvider =
  'local' | 'aws' | 'digitalocean' | 'databricks' | 'oci';

export type RemoteMachineEnv = {
  provider: RemoteMachineProvider;
  awsImageArn?: string;
  awsExecutionRole?: string;
  awsSecretArn?: string;
  awsRegion?: string;
  digitalOceanToken?: string;
  databricksHost?: string;
  databricksToken?: string;
  ociProjectId?: string;
  ociToken?: string;
  ociCreateUrl?: string;
};

export type MachineRequest = {
  sessionId: string;
  environmentId: string;
  remoteUrl: string;
  executorKey: string;
};

type CommandResult = { stdout: string };

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

//1. local starts codex on this Mac. The other providers create a machine that starts codex itself.
//2. The id prefix says which provider created the machine, so delete still works if the setting changes.
export class RemoteMachines {
  private readonly local = new Map<string, ChildProcess>();

  constructor(
    private readonly env: RemoteMachineEnv,
    private readonly startLocal: (request: MachineRequest) => ChildProcess,
    private readonly run: CommandRunner = (command, args) =>
      runFile(command, args, { timeout: 120_000, maxBuffer: 1_000_000 }),
    private readonly request: FetchLike = defaultFetch,
  ) {}

  async create(request: MachineRequest) {
    switch (this.env.provider) {
      case 'local':
        return this.createLocal(request);
      case 'aws':
        return this.createAws(request);
      case 'digitalocean':
        return this.createDigitalOcean(request);
      case 'databricks':
        return this.createDatabricks(request);
      case 'oci':
        return this.createOci(request);
    }
  }

  async release(machineId: string) {
    const separator = machineId.indexOf(':');
    const provider = machineId.slice(0, separator);
    const id = machineId.slice(separator + 1);
    if (provider === 'local') return this.releaseLocal(id);
    if (provider === 'aws') return this.releaseAws(id);
    if (provider === 'digitalocean') return this.releaseDigitalOcean(id);
    if (provider === 'databricks') return this.releaseDatabricks(id);
    if (provider === 'oci') return this.releaseOci(id);
    throw new Error(`Unknown remote machine ${provider}.`);
  }

  private createLocal(request: MachineRequest) {
    const child = this.startLocal(request);
    const pid = child.pid;
    if (!pid) throw new Error('The local executor did not start.');
    this.local.set(String(pid), child);
    return `local:${pid}`;
  }

  private releaseLocal(pid: string) {
    const child = this.local.get(pid);
    if (child) child.kill();
    else process.kill(Number(pid));
    this.local.delete(pid);
  }

  private async createAws(request: MachineRequest) {
    const image = required(this.env.awsImageArn, 'AWS_MICROVM_IMAGE_ARN');
    const secretArn = required(this.env.awsSecretArn, 'AWS_MICROVM_SECRET_ARN');
    const args = awsRunArgs({
      image,
      region: this.env.awsRegion,
      executionRole: this.env.awsExecutionRole,
      payload: JSON.stringify({
        environmentId: request.environmentId,
        remoteUrl: request.remoteUrl,
        secretArn,
      }),
    });
    const result = await this.run('aws', args);
    const body = JSON.parse(result.stdout) as { microvmId?: string };
    if (!body.microvmId) throw new Error('AWS did not return a MicroVM id.');
    return `aws:${body.microvmId}`;
  }

  private async releaseAws(id: string) {
    await this.run('aws', awsTerminateArgs(id, this.env.awsRegion));
  }

  private async createDigitalOcean(request: MachineRequest) {
    const token = required(this.env.digitalOceanToken, 'DIGITALOCEAN_TOKEN');
    required(request.executorKey, 'OPENAI_EXECUTOR_API_KEY');
    const manifest = digitalOceanManifest(request);
    const url = new URL('https://api.digitalocean.com/v2/agents/sessions');
    url.searchParams.set('openai_session_id', request.sessionId);
    const response = await this.request(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-yaml',
      },
      body: manifest,
    });
    const body = await readJson(response);
    const id = readId(body);
    if (!id) throw new Error('DigitalOcean did not return a session id.');
    return `digitalocean:${id}`;
  }

  private async releaseDigitalOcean(id: string) {
    const token = required(this.env.digitalOceanToken, 'DIGITALOCEAN_TOKEN');
    const response = await this.request(
      `https://api.digitalocean.com/v2/agents/sessions/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `DigitalOcean delete failed with status ${response.status}.`,
      );
    }
  }

  private async createDatabricks(request: MachineRequest) {
    const host = databricksHost(this.env.databricksHost);
    const token = required(this.env.databricksToken, 'DATABRICKS_TOKEN');
    required(request.executorKey, 'OPENAI_EXECUTOR_API_KEY');
    const sandboxId = databricksSandboxId(request.sessionId);
    const created = await this.request(
      `${host}/api/2.0/sandboxes?sandbox_id=${encodeURIComponent(sandboxId)}`,
      {
        method: 'POST',
        headers: databricksHeaders(token),
        body: JSON.stringify({
          spec: { compute: { inactivity_timeout: '900s' } },
        }),
      },
    );
    const body = await readJson(created);
    const name =
      typeof body === 'object' &&
      body &&
      'name' in body &&
      typeof body.name === 'string'
        ? body.name
        : `sandboxes/${sandboxId}`;
    await this.request(`${host}/api/2.0/sandbox-exec/${name}/exec-sync`, {
      method: 'POST',
      headers: databricksHeaders(token),
      body: JSON.stringify({
        cmd: '/bin/bash',
        args: ['-lc', databricksExecutorScript(request)],
        envs: { CODEX_API_KEY: request.executorKey, RUST_LOG: 'info' },
        execution_timeout: '120s',
      }),
    });
    return `databricks:${name}`;
  }

  private async releaseDatabricks(name: string) {
    const host = databricksHost(this.env.databricksHost);
    const token = required(this.env.databricksToken, 'DATABRICKS_TOKEN');
    const response = await this.request(`${host}/api/2.0/${name}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Databricks delete failed with status ${response.status}.`,
      );
    }
  }

  private async createOci(request: MachineRequest) {
    const endpoint = required(this.env.ociCreateUrl, 'OCI_SANDBOX_CREATE_URL');
    const projectId = required(this.env.ociProjectId, 'OCI_SANDBOX_PROJECT_ID');
    const token = required(this.env.ociToken, 'OCI_SANDBOX_TOKEN');
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        displayName: `openai-${request.sessionId}`,
        freeformTags: {
          environmentId: request.environmentId,
          remoteUrl: request.remoteUrl,
        },
      }),
    });
    const body = await readJson(response);
    const id = readId(body);
    if (!id) throw new Error('OCI did not return a sandbox id.');
    return `oci:${id}`;
  }

  private async releaseOci(id: string) {
    const endpoint = required(this.env.ociCreateUrl, 'OCI_SANDBOX_CREATE_URL');
    const token = required(this.env.ociToken, 'OCI_SANDBOX_TOKEN');
    const response = await this.request(
      `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`OCI delete failed with status ${response.status}.`);
    }
  }
}

export function awsRunArgs(input: {
  image: string;
  payload: string;
  region?: string;
  executionRole?: string;
}) {
  return [
    'lambda-microvms',
    'run-microvm',
    '--image-identifier',
    input.image,
    '--run-hook-payload',
    input.payload,
    '--output',
    'json',
    ...(input.executionRole
      ? ['--execution-role-arn', input.executionRole]
      : []),
    ...(input.region ? ['--region', input.region] : []),
  ];
}

export function awsTerminateArgs(id: string, region?: string) {
  return [
    'lambda-microvms',
    'terminate-microvm',
    '--microvm-identifier',
    id,
    ...(region ? ['--region', region] : []),
  ];
}

export function digitalOceanManifest(request: MachineRequest) {
  return [
    'agent: codex-agentapi',
    'egress:',
    '  - api.openai.com',
    '  - codex-cloud-environments.chatgpt.com',
    'env:',
    `  CODEX_ENVIRONMENT_ID: ${request.environmentId}`,
    'secrets:',
    `  CODEX_API_KEY: ${request.executorKey}`,
    '',
  ].join('\n');
}

export function databricksExecutorScript(request: MachineRequest) {
  const remote = shellQuote(request.remoteUrl);
  const environment = shellQuote(request.environmentId);
  return [
    'cx=$(mktemp -d -p /home/sandbox-agent)',
    'rm -f /home/sandbox-agent/codex-exec-server.log',
    'CODEX_HOME=$cx setsid nohup codex exec-server',
    `--remote ${remote}`,
    `--environment-id ${environment}`,
    '>/home/sandbox-agent/codex-exec-server.log 2>&1 & echo pid=$!',
  ].join(' ');
}

export function databricksSandboxId(sessionId: string) {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  return `openai-${cleaned || 'session'}`;
}

function databricksHost(host: string | undefined) {
  const value = required(host, 'DATABRICKS_HOST');
  const url = new URL(value);
  if (url.protocol !== 'https:')
    throw new Error('DATABRICKS_HOST must be https.');
  return url.origin;
}

function databricksHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required for this remote machine.`);
  return value;
}

async function readJson(response: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}) {
  if (!response.ok) {
    throw new Error(
      `Remote machine request failed with status ${response.status}.`,
    );
  }
  return await response.json();
}

function readId(body: unknown) {
  if (!body || typeof body !== 'object') return;
  const record = body as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  if (typeof record.session_id === 'string') return record.session_id;
  const session = record.session;
  if (session && typeof session === 'object' && 'id' in session) {
    const id = session.id;
    if (typeof id === 'string') return id;
  }
  return;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>,
  };
}
