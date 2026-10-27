import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { run, Session } from '@openai/agents';
import OpenAI from 'openai';
import {
  Capabilities,
  Capability,
  Manifest,
  MemoryArgs,
  SandboxAgent,
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

type SandboxComputer = 'unix' | 'docker';

type OpenSandboxOptions = {
  ports?: number[];
  snapshotDir?: string;
  computer?: SandboxComputer;
  image?: string;
};

type CreateSandboxAgentOptions = {
  model?: string;
  manifest?: Manifest;
  skills?: SkillsArgs;
  memory?: boolean | MemoryArgs;
  handoffDescription?: string;
};

export type SandboxWorkspace = UnixLocalSandboxSession | DockerSandboxSession;

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
  //2. ports are the preview ports the agent may use. snapshotDir is where file snapshots are stored.
  //3. ACCOUNT_PASSWORD is added only when this app has one, and it is ephemeral.
  async openSandbox(manifest = new Manifest(), options?: OpenSandboxOptions) {
    const password = this.configService.get<string>('ACCOUNT_PASSWORD');
    const nextManifest = new Manifest({
      entries: manifest.entries,
      environment: {
        ...manifest.environment,
        ...(password !== undefined && {
          ACCOUNT_PASSWORD: { value: password, ephemeral: true },
        }),
      },
    });
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
    await workspace.close();
  }

  // The agent starts the server. This returns the URL for a port opened with the workspace.
  async previewUrl(workspace: SandboxWorkspace, port: number) {
    const endpoint = await workspace.resolveExposedPort(port);
    if (endpoint.url) return endpoint.url;
    const scheme = endpoint.tls ? 'https' : 'http';
    return `${scheme}://${endpoint.host}:${endpoint.port}`;
  }

  // Save the live session so a later process can resume the same files.
  async saveSandbox(workspace: SandboxWorkspace) {
    if (this.isDocker(workspace)) {
      return await new DockerSandboxClient().serializeSessionState(
        workspace.state,
      );
    }
    return await new UnixLocalSandboxClient().serializeSessionState(
      workspace.state,
    );
  }

  // Resume a saved session. Pass the same computer and snapshotDir used to open it.
  async resumeSandbox(
    saved: Record<string, unknown>,
    options?: OpenSandboxOptions,
  ) {
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
      options?.computer === 'docker'
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
