import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { run, Session } from '@openai/agents';
import OpenAI, { APIError } from 'openai';
import {
  Capabilities,
  Capability,
  Manifest,
  MemoryArgs,
  SandboxAgent,
  SandboxClient,
  SandboxSession,
  SkillsArgs,
  memory,
  skills,
} from '@openai/agents/sandbox';
import {
  DockerSandboxClient,
  DockerSandboxSession,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from '@openai/agents/sandbox/local';

type SandboxComputer =
  | 'unix'
  | 'docker'
  | 'modal'
  | 'vercel'
  | 'cloudflare'
  | 'e2b'
  | 'daytona'
  | 'blaxel';

type OpenSandboxOptions = {
  ports?: number[];
  snapshotDir?: string;
  computer?: SandboxComputer;
  image?: string;
  client?: WorkspaceClient;
  password?: string;
  workerUrl?: string;
};

type WorkspaceClient = {
  create: (args: { manifest: Manifest }) => Promise<SandboxSession>;
  resume?: (state: SandboxSession['state']) => Promise<SandboxSession>;
  serializeSessionState?: (
    state: SandboxSession['state'],
  ) => Promise<Record<string, unknown>>;
  deserializeSessionState?: (
    state: Record<string, unknown>,
  ) => Promise<SandboxSession['state']>;
};

type CreateSandboxAgentOptions = {
  model?: string;
  manifest?: Manifest;
  skills?: SkillsArgs;
  memory?: boolean | MemoryArgs;
  handoffDescription?: string;
};

export type SandboxWorkspace = SandboxSession;

type HostedSessionOptions = {
  model?: string;
  workspaceDirectory?: string;
  capabilityDirectories?: string[];
};

export type HostedSession = {
  sessionId: string;
  environmentId: string;
  remoteUrl: string;
  workspaceDirectory: string;
};

// Follows the current Node release. Pass image when a workspace needs a fixed tag.
const DOCKER_IMAGE = 'node:latest';
const runFile = promisify(execFile);

type RemoteMachineProvider =
  'local' | 'aws' | 'digitalocean' | 'databricks' | 'oci';

type MachineRequest = {
  sessionId: string;
  environmentId: string;
  remoteUrl: string;
  executorKey: string;
};

@Injectable()
export class SandboxService {
  private hostedClient?: OpenAI;
  private readonly machineLocks = new Map<string, Promise<void>>();
  private readonly localExecutors = new Map<string, ChildProcess>();

  constructor(private readonly configService: ConfigService) {}

  // Create a sandbox agent. Leave model out to use the default model.
  // manifest, skills, memory, and handoffDescription are optional.
  createSandboxAgent(
    name: string,
    instructions: string,
    options?: CreateSandboxAgentOptions,
  ) {
    return new SandboxAgent({
      name,
      instructions,
      capabilities: this.capabilities(options),
      ...(options?.model && { model: options.model }),
      ...(options?.manifest && { defaultManifest: options.manifest }),
      ...(options?.handoffDescription && {
        handoffDescription: options.handoffDescription,
      }),
    });
  }

  //1. Shell, filesystem, and compaction are always on.
  //2. Skills and memory are added only when the caller asks for them.
  //3. skills takes one source: text in the call, a folder, or a git repo.
  //4. memory: true reads old lessons and writes new ones. layout separates agents that share a workspace.
  private capabilities(options?: CreateSandboxAgentOptions): Capability[] {
    return [
      ...Capabilities.default(),
      ...(options?.skills ? [skills(options.skills)] : []),
      ...(options?.memory
        ? [memory(options.memory === true ? undefined : options.memory)]
        : []),
    ];
  }

  //1. Open a workspace. Unix is the default computer. Pass computer: 'docker' for a container.
  //2. Pass client for a hosted computer such as Modal, Vercel, Cloudflare, E2B, Daytona, or Blaxel.
  //3. ports are preview ports. snapshotDir is where file snapshots are stored.
  //4. password replaces ACCOUNT_PASSWORD for this workspace. Leave it out to use the shared secret.
  //5. computer can be unix, docker, modal, vercel, cloudflare, e2b, daytona, or blaxel.
  async openSandbox(manifest = new Manifest(), options?: OpenSandboxOptions) {
    const password =
      options?.password !== undefined
        ? options.password.trim() || undefined
        : this.configService.get<string>('ACCOUNT_PASSWORD');
    const nextManifest = new Manifest({
      entries: manifest.entries,
      environment: {
        ...manifest.environment,
        ...(password !== undefined && {
          ACCOUNT_PASSWORD: { value: password, ephemeral: true },
        }),
      },
      users: manifest.users,
      groups: manifest.groups,
    });

    if (options?.client)
      return await options.client.create({ manifest: nextManifest });

    if (options?.computer && isHostedComputer(options.computer)) {
      const client = await this.providerClient(options.computer, options);
      if (!client.create) {
        throw new Error('This computer cannot open a workspace.');
      }
      return await client.create({ manifest: nextManifest });
    }

    const clientOptions = this.clientOptions(options);
    if (options?.computer === 'docker') {
      return await new DockerSandboxClient({
        image: options.image ?? DOCKER_IMAGE,
        ...clientOptions,
      }).create({ manifest: nextManifest });
    }

    return await new UnixLocalSandboxClient(clientOptions).create({
      manifest: nextManifest,
    });
  }

  // Close the workspace. Memory writes its lessons during this close.
  async closeSandbox(workspace: SandboxWorkspace) {
    if (!workspace.close) throw new Error('This workspace cannot be closed.');
    await workspace.close();
  }

  // Copy one workspace file back into this app.
  async readWorkspaceFile(workspace: SandboxWorkspace, path: string) {
    if (!workspace.readFile)
      throw new Error('This workspace cannot read files.');
    const payload = await workspace.readFile({ path });
    return typeof payload === 'string'
      ? payload
      : new TextDecoder().decode(payload);
  }

  // The agent starts the server. This returns the URL for a port opened with the workspace.
  async previewUrl(workspace: SandboxWorkspace, port: number) {
    if (!workspace.resolveExposedPort) {
      throw new Error('This workspace does not expose ports.');
    }
    const endpoint = await workspace.resolveExposedPort(port);
    if (endpoint.url) return endpoint.url;
    const scheme = endpoint.tls ? 'https' : 'http';
    return `${scheme}://${endpoint.host}:${endpoint.port}`;
  }

  // Save the live session so a later process can resume the same files.
  async saveSandbox(workspace: SandboxWorkspace, client?: WorkspaceClient) {
    if (client?.serializeSessionState) {
      return await client.serializeSessionState(workspace.state);
    }
    if (this.isDocker(workspace)) {
      return await new DockerSandboxClient().serializeSessionState(
        workspace.state as DockerSandboxSession['state'],
      );
    }
    return await new UnixLocalSandboxClient().serializeSessionState(
      workspace.state as UnixLocalSandboxSession['state'],
    );
  }

  // Resume a saved session. Pass the same computer, client, and snapshotDir used to open it.
  async resumeSandbox(
    saved: Record<string, unknown>,
    options?: OpenSandboxOptions,
  ) {
    if (options?.client?.resume && options.client.deserializeSessionState) {
      const state = await options.client.deserializeSessionState(saved);
      return await options.client.resume(state);
    }
    if (options?.computer && isHostedComputer(options.computer)) {
      const client = await this.providerClient(options.computer, options);
      if (!client.resume || !client.deserializeSessionState) {
        throw new Error('This computer cannot resume a saved workspace.');
      }
      const state = await client.deserializeSessionState(saved);
      return await client.resume(state);
    }
    if (options?.computer === 'docker') {
      const client = new DockerSandboxClient({
        image: options.image ?? DOCKER_IMAGE,
        ...this.clientOptions(options),
      });
      return await client.resume(await client.deserializeSessionState(saved));
    }

    const client = new UnixLocalSandboxClient(this.clientOptions(options));
    return await client.resume(await client.deserializeSessionState(saved));
  }

  //1. Run a prompt on a sandbox agent inside a workspace.
  //2. Pass the same workspace on the next run to keep the files and the browser.
  //3. chat is optional. Reuse one session to continue the messages.
  async runSandbox(
    prompt: string,
    agent: SandboxAgent,
    options: {
      workspace: SandboxWorkspace;
      chat?: Session;
    },
  ) {
    return await run(agent, prompt, {
      sandbox: { session: options.workspace },
      ...(options.chat && { session: options.chat }),
    });
  }

  // Run once and let the SDK delete the workspace. Use this when the files do not need to survive.
  async runSandboxOnce(
    prompt: string,
    agent: SandboxAgent,
    options?: {
      chat?: Session;
      manifest?: Manifest;
      computer?: SandboxComputer;
      image?: string;
    },
  ) {
    const client =
      options?.computer && isHostedComputer(options.computer)
        ? await this.providerClient(options.computer, options)
        : options?.computer === 'docker'
          ? new DockerSandboxClient({ image: options.image ?? DOCKER_IMAGE })
          : new UnixLocalSandboxClient();

    return await run(agent, prompt, {
      sandbox: {
        client,
        ...(options?.manifest && { manifest: options.manifest }),
      },
      ...(options?.chat && { session: options.chat }),
    });
  }

  // Call the sandbox agent as a tool. Pass a workspace to keep its files. Leave it out for a fresh Unix workspace.
  asTool(
    agent: SandboxAgent,
    options?: {
      toolName?: string;
      toolDescription?: string;
      workspace?: SandboxWorkspace;
    },
  ) {
    return agent.asTool({
      ...(options?.toolName && { toolName: options.toolName }),
      ...(options?.toolDescription && {
        toolDescription: options.toolDescription,
      }),
      runConfig: {
        sandbox: options?.workspace
          ? { session: options.workspace }
          : { client: new UnixLocalSandboxClient() },
      },
    });
  }

  //1. OpenAI runs this harness. This app creates the session and keeps the executor key.
  //2. Each session needs its own executor. Store sessionId with the chat.
  async createHostedSession(
    instructions: string,
    options?: HostedSessionOptions,
  ): Promise<HostedSession> {
    const session = await this.openai().beta.agents.sessions.create({
      agent: {
        model: options?.model ?? 'gpt-6-astra',
        instructions,
      },
      environment: {
        type: 'self_hosted',
        workspace_directory: options?.workspaceDirectory ?? '/workspace',
        ...(options?.capabilityDirectories && {
          capability_directories: options.capabilityDirectories,
        }),
      },
    });

    if (session.environment.type !== 'self_hosted') {
      throw new Error('Expected a self-hosted environment.');
    }

    return {
      sessionId: session.id,
      environmentId: session.environment.id,
      remoteUrl: session.environment.remote_url,
      workspaceDirectory: session.environment.workspace_directory,
    };
  }

  // Run this command inside the environment. OPENAI_API_KEY stays in this app.
  hostedExecutorCommand(
    session: Pick<HostedSession, 'environmentId' | 'remoteUrl'>,
  ) {
    return {
      command: 'codex',
      args: [
        'exec-server',
        '--remote',
        session.remoteUrl,
        '--environment-id',
        session.environmentId,
      ],
      env: {
        CODEX_API_KEY: this.configService
          .getOrThrow<string>('OPENAI_EXECUTOR_API_KEY')
          .trim(),
      },
    };
  }

  // Start the executor on this machine. A remote environment runs hostedExecutorCommand there instead.
  startHostedExecutor(
    session: Pick<HostedSession, 'environmentId' | 'remoteUrl'>,
  ) {
    const spec = this.hostedExecutorCommand(session);
    return spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: 'inherit',
    });
  }

  //1. Read the session event stream until the executor connects.
  //2. pending means it has not connected yet. failed carries the environment error.
  async waitForHostedConnection(sessionId: string) {
    const stream =
      await this.openai().beta.agents.sessions.events.stream(sessionId);

    for await (const event of stream) {
      if (event.type === 'agent.session.environment.connected') return;
      if (
        event.type === 'agent.session.environment.failed' ||
        event.type === 'agent.session.environment.expired'
      ) {
        const message = event.environment.error?.message;
        throw new Error(message ?? 'The self-hosted environment failed.');
      }
    }

    throw new Error('The event stream ended before the environment connected.');
  }

  // Send one message after the environment is connected. Returns the assistant text.
  async sendToHostedSession(sessionId: string, prompt: string) {
    const events = this.openai().beta.agents.sessions.stream(sessionId, {
      input: prompt,
    });
    events.withResultCollection();
    const result = await events.finalResult();
    return result.output_text;
  }

  // A self-hosted session event for this Mac. Another machine runs hostedExecutorCommand instead.
  onHostedSessionCreated(event: {
    type: string;
    data?: {
      environment_type?: string;
      environment_id?: string;
      connect?: { remote_url?: string };
    };
  }) {
    if (event.type !== 'agent.session.created') return;
    if (event.data?.environment_type !== 'self_hosted') return;

    const environmentId = event.data.environment_id;
    const remoteUrl = event.data.connect?.remote_url;
    if (!environmentId || !remoteUrl) {
      throw new Error(
        'Self-hosted session event is missing the executor address.',
      );
    }

    return this.startHostedExecutor({ environmentId, remoteUrl });
  }

  //1. Verify the OpenAI webhook, then create or delete the remote machine.
  //2. action_required with environment_connection starts the machine. failed deletes it.
  async handleHostedWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const secret = this.configService.get<string>('OPENAI_WEBHOOK_SECRET');
    if (!secret)
      throw new UnauthorizedException('OPENAI_WEBHOOK_SECRET is not set.');
    let event: Awaited<ReturnType<OpenAI['webhooks']['unwrap']>>;
    try {
      event = await this.openai().webhooks.unwrap(rawBody, headers, secret);
    } catch {
      throw new UnauthorizedException('Webhook signature was rejected.');
    }

    if (event.type === 'agent.session.action_required') {
      if (event.data.required_action.type !== 'environment_connection') return;
      await this.ensureRemoteMachine(event.data.id);
      return;
    }
    if (event.type === 'agent.session.failed') {
      await this.releaseRemoteMachine(event.data.id);
    }
  }

  private async ensureRemoteMachine(sessionId: string) {
    const current = this.machineLocks.get(sessionId);
    if (current) return await current;
    const task = this.connectRemoteMachine(sessionId).finally(() => {
      this.machineLocks.delete(sessionId);
    });
    this.machineLocks.set(sessionId, task);
    return await task;
  }

  private async connectRemoteMachine(sessionId: string) {
    const session =
      await this.openai().beta.agents.sessions.retrieve(sessionId);
    if (session.environment.type !== 'self_hosted') return;
    const needsConnection = session.required_actions.some(
      (action) => action.type === 'environment_connection',
    );
    if (!needsConnection || session.metadata.remote_machine_id) return;

    const machineId = await this.createRemoteMachine({
      sessionId: session.id,
      environmentId: session.environment.id,
      remoteUrl: session.environment.remote_url,
      executorKey:
        this.configService.get<string>('OPENAI_EXECUTOR_API_KEY') ?? '',
    });
    await this.openai().beta.agents.sessions.update(session.id, {
      metadata: { ...session.metadata, remote_machine_id: machineId },
    });
  }

  private async releaseRemoteMachine(sessionId: string) {
    try {
      const session =
        await this.openai().beta.agents.sessions.retrieve(sessionId);
      if (session.status !== 'failed') return;
      const machineId = session.metadata.remote_machine_id;
      if (!machineId) return;
      await this.deleteRemoteMachine(machineId);
    } catch (error) {
      if (error instanceof APIError && error.status === 404) return;
      throw error;
    }
  }

  //1. local starts codex on this Mac. The other providers create a machine that starts codex itself.
  //2. The id prefix says which provider created the machine, so delete still works if the setting changes.
  private async createRemoteMachine(request: MachineRequest) {
    switch (this.remoteProvider()) {
      case 'local':
        return this.createLocalMachine(request);
      case 'aws':
        return this.createAwsMachine(request);
      case 'digitalocean':
        return this.createDigitalOceanMachine(request);
      case 'databricks':
        return this.createDatabricksMachine(request);
      case 'oci':
        return this.createOciMachine(request);
    }
  }

  private async deleteRemoteMachine(machineId: string) {
    const separator = machineId.indexOf(':');
    const provider = machineId.slice(0, separator);
    const id = machineId.slice(separator + 1);
    if (provider === 'local') return this.deleteLocalMachine(id);
    if (provider === 'aws') return this.deleteAwsMachine(id);
    if (provider === 'digitalocean') return this.deleteDigitalOceanMachine(id);
    if (provider === 'databricks') return this.deleteDatabricksMachine(id);
    if (provider === 'oci') return this.deleteOciMachine(id);
    throw new Error(`Unknown remote machine ${provider}.`);
  }

  private createLocalMachine(request: MachineRequest) {
    const child = this.startHostedExecutor(request);
    const pid = child.pid;
    if (!pid) throw new Error('The local executor did not start.');
    this.localExecutors.set(String(pid), child);
    return `local:${pid}`;
  }

  private deleteLocalMachine(pid: string) {
    const child = this.localExecutors.get(pid);
    if (child) child.kill();
    else process.kill(Number(pid));
    this.localExecutors.delete(pid);
  }

  private async createAwsMachine(request: MachineRequest) {
    const image = requiredSetting(
      this.configService.get<string>('AWS_MICROVM_IMAGE_ARN'),
      'AWS_MICROVM_IMAGE_ARN',
    );
    const secretArn = requiredSetting(
      this.configService.get<string>('AWS_MICROVM_SECRET_ARN'),
      'AWS_MICROVM_SECRET_ARN',
    );
    const result = await runFile(
      'aws',
      awsRunArgs({
        image,
        region: this.configService.get<string>('AWS_REGION'),
        executionRole: this.configService.get<string>(
          'AWS_MICROVM_EXECUTION_ROLE',
        ),
        payload: JSON.stringify({
          environmentId: request.environmentId,
          remoteUrl: request.remoteUrl,
          secretArn,
        }),
      }),
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
    const body = JSON.parse(result.stdout) as { microvmId?: string };
    if (!body.microvmId) throw new Error('AWS did not return a MicroVM id.');
    return `aws:${body.microvmId}`;
  }

  private async deleteAwsMachine(id: string) {
    await runFile(
      'aws',
      awsTerminateArgs(id, this.configService.get<string>('AWS_REGION')),
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
  }

  private async createDigitalOceanMachine(request: MachineRequest) {
    const token = requiredSetting(
      this.configService.get<string>('DIGITALOCEAN_TOKEN'),
      'DIGITALOCEAN_TOKEN',
    );
    requiredSetting(request.executorKey, 'OPENAI_EXECUTOR_API_KEY');
    const url = new URL('https://api.digitalocean.com/v2/agents/sessions');
    url.searchParams.set('openai_session_id', request.sessionId);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-yaml',
      },
      body: digitalOceanManifest(request),
    });
    const id = readId(await readJson(response));
    if (!id) throw new Error('DigitalOcean did not return a session id.');
    return `digitalocean:${id}`;
  }

  private async deleteDigitalOceanMachine(id: string) {
    const token = requiredSetting(
      this.configService.get<string>('DIGITALOCEAN_TOKEN'),
      'DIGITALOCEAN_TOKEN',
    );
    const response = await fetch(
      `https://api.digitalocean.com/v2/agents/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `DigitalOcean delete failed with status ${response.status}.`,
      );
    }
  }

  private async createDatabricksMachine(request: MachineRequest) {
    const host = databricksHost(
      this.configService.get<string>('DATABRICKS_HOST'),
    );
    const token = requiredSetting(
      this.configService.get<string>('DATABRICKS_TOKEN'),
      'DATABRICKS_TOKEN',
    );
    requiredSetting(request.executorKey, 'OPENAI_EXECUTOR_API_KEY');
    const sandboxId = databricksSandboxId(request.sessionId);
    const created = await fetch(
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
    await fetch(`${host}/api/2.0/sandbox-exec/${name}/exec-sync`, {
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

  private async deleteDatabricksMachine(name: string) {
    const host = databricksHost(
      this.configService.get<string>('DATABRICKS_HOST'),
    );
    const token = requiredSetting(
      this.configService.get<string>('DATABRICKS_TOKEN'),
      'DATABRICKS_TOKEN',
    );
    const response = await fetch(`${host}/api/2.0/${name}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Databricks delete failed with status ${response.status}.`,
      );
    }
  }

  private async createOciMachine(request: MachineRequest) {
    const endpoint = requiredSetting(
      this.configService.get<string>('OCI_SANDBOX_CREATE_URL'),
      'OCI_SANDBOX_CREATE_URL',
    );
    const projectId = requiredSetting(
      this.configService.get<string>('OCI_SANDBOX_PROJECT_ID'),
      'OCI_SANDBOX_PROJECT_ID',
    );
    const token = requiredSetting(
      this.configService.get<string>('OCI_SANDBOX_TOKEN'),
      'OCI_SANDBOX_TOKEN',
    );
    const response = await fetch(endpoint, {
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
    const id = readId(await readJson(response));
    if (!id) throw new Error('OCI did not return a sandbox id.');
    return `oci:${id}`;
  }

  private async deleteOciMachine(id: string) {
    const endpoint = requiredSetting(
      this.configService.get<string>('OCI_SANDBOX_CREATE_URL'),
      'OCI_SANDBOX_CREATE_URL',
    );
    const token = requiredSetting(
      this.configService.get<string>('OCI_SANDBOX_TOKEN'),
      'OCI_SANDBOX_TOKEN',
    );
    const response = await fetch(
      `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`OCI delete failed with status ${response.status}.`);
    }
  }

  private remoteProvider(): RemoteMachineProvider {
    return (
      this.configService.get<RemoteMachineProvider>(
        'REMOTE_MACHINE_PROVIDER',
      ) ?? 'local'
    );
  }

  private async providerClient(
    computer: Exclude<SandboxComputer, 'unix' | 'docker'>,
    options?: OpenSandboxOptions,
  ): Promise<SandboxClient> {
    switch (computer) {
      case 'modal': {
        const { ModalSandboxClient } =
          await import('@openai/agents-extensions/sandbox/modal');
        return new ModalSandboxClient();
      }
      case 'vercel': {
        const { VercelSandboxClient } =
          await import('@openai/agents-extensions/sandbox/vercel');
        return new VercelSandboxClient();
      }
      case 'cloudflare': {
        const { CloudflareSandboxClient } =
          await import('@openai/agents-extensions/sandbox/cloudflare');
        const workerUrl =
          options?.workerUrl ??
          this.configService.get<string>('CLOUDFLARE_SANDBOX_WORKER_URL');
        if (!workerUrl) {
          throw new Error(
            'Cloudflare needs workerUrl or CLOUDFLARE_SANDBOX_WORKER_URL.',
          );
        }
        const apiKey = this.configService.get<string>(
          'CLOUDFLARE_SANDBOX_API_KEY',
        );
        return new CloudflareSandboxClient({
          workerUrl,
          ...(apiKey && { apiKey }),
        });
      }
      case 'e2b': {
        const { E2BSandboxClient } =
          await import('@openai/agents-extensions/sandbox/e2b');
        return new E2BSandboxClient();
      }
      case 'daytona': {
        const { DaytonaSandboxClient } =
          await import('@openai/agents-extensions/sandbox/daytona');
        return new DaytonaSandboxClient();
      }
      case 'blaxel': {
        const { BlaxelSandboxClient } =
          await import('@openai/agents-extensions/sandbox/blaxel');
        return new BlaxelSandboxClient();
      }
    }
  }

  private openai() {
    const apiKey = this.configService
      .getOrThrow<string>('OPENAI_API_KEY')
      .trim();
    this.hostedClient ??= new OpenAI({ apiKey });
    return this.hostedClient;
  }

  private clientOptions(options?: OpenSandboxOptions) {
    return {
      ...(options?.ports && { exposedPorts: options.ports }),
      ...(options?.snapshotDir && {
        snapshot: { type: 'local' as const, baseDir: options.snapshotDir },
      }),
    };
  }

  private isDocker(
    workspace: SandboxWorkspace,
  ): workspace is DockerSandboxSession {
    return 'containerId' in workspace.state;
  }
}

function isHostedComputer(
  computer: SandboxComputer,
): computer is Exclude<SandboxComputer, 'unix' | 'docker'> {
  return computer !== 'unix' && computer !== 'docker';
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

function databricksSandboxId(sessionId: string) {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  return `openai-${cleaned || 'session'}`;
}

function databricksHost(host: string | undefined) {
  const value = requiredSetting(host, 'DATABRICKS_HOST');
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('DATABRICKS_HOST must be https.');
  }
  return url.origin;
}

function databricksHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function requiredSetting(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required for this remote machine.`);
  return value;
}

async function readJson(response: Response) {
  if (!response.ok) {
    throw new Error(
      `Remote machine request failed with status ${response.status}.`,
    );
  }
  return (await response.json()) as unknown;
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
