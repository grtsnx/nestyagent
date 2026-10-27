import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { run, Session } from '@openai/agents';
import OpenAI, { APIError } from 'openai';
import { RemoteMachineProvider, RemoteMachines } from './remote-machine.js';
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

@Injectable()
export class SandboxService {
  private hostedClient?: OpenAI;
  private remoteMachines?: RemoteMachines;
  private readonly machineLocks = new Map<string, Promise<void>>();

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

    const machineId = await this.machines().create({
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
      await this.machines().release(machineId);
    } catch (error) {
      if (error instanceof APIError && error.status === 404) return;
      throw error;
    }
  }

  private machines() {
    this.remoteMachines ??= new RemoteMachines(
      {
        provider: this.remoteProvider(),
        awsImageArn: this.configService.get<string>('AWS_MICROVM_IMAGE_ARN'),
        awsExecutionRole: this.configService.get<string>(
          'AWS_MICROVM_EXECUTION_ROLE',
        ),
        awsSecretArn: this.configService.get<string>('AWS_MICROVM_SECRET_ARN'),
        awsRegion: this.configService.get<string>('AWS_REGION'),
        digitalOceanToken: this.configService.get<string>('DIGITALOCEAN_TOKEN'),
        databricksHost: this.configService.get<string>('DATABRICKS_HOST'),
        databricksToken: this.configService.get<string>('DATABRICKS_TOKEN'),
        ociProjectId: this.configService.get<string>('OCI_SANDBOX_PROJECT_ID'),
        ociToken: this.configService.get<string>('OCI_SANDBOX_TOKEN'),
        ociCreateUrl: this.configService.get<string>('OCI_SANDBOX_CREATE_URL'),
      },
      (request) => this.startHostedExecutor(request),
    );
    return this.remoteMachines;
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
