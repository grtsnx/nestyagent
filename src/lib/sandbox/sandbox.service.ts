import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { InputGuardrail, OutputGuardrail, run, Session } from '@openai/agents';
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
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local';
import {
  remoteMachineProviders,
  type Environment,
  type RemoteMachineProvider,
} from '@/config/index.js';
import { OpenaiService } from '../openai/openai.service.js';

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
  client?: SandboxClient;
  password?: string;
  workerUrl?: string;
};

type FreshSandboxOptions = OpenSandboxOptions & { manifest?: Manifest };

type CreateSandboxAgentOptions = {
  model?: string;
  manifest?: Manifest;
  skills?: SkillsArgs;
  memory?: boolean | MemoryArgs;
  handoffDescription?: string;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
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
// Used when neither the call nor OPENAI_HOSTED_MODEL names a model.
const DEFAULT_HOSTED_MODEL = 'gpt-6-astra';
// How long to wait for an executor to connect before giving up.
const CONNECT_TIMEOUT_MS = 120_000;
// A claim older than this belongs to a create that crashed, so a retry may take over.
const CLAIM_TTL_MS = 10 * 60_000;
const CLAIM_PREFIX = 'pending:';
// How many recent sessions to search when an environment expires.
const EXPIRED_SCAN_LIMIT = 500;
// The only variables the executor inherits from this app, besides CODEX_API_KEY.
const EXECUTOR_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL'];
const runFile = promisify(execFile);

type MachineRequest = {
  sessionId: string;
  environmentId: string;
  remoteUrl: string;
  executorKey: string;
};

type MachineDriver = {
  create: (request: MachineRequest) => Promise<string> | string;
  delete: (id: string) => Promise<void> | void;
};

@Injectable()
export class SandboxService {
  private readonly machineLocks = new Map<string, Promise<void>>();
  private readonly localExecutors = new Map<string, ChildProcess>();

  // Each provider creates a machine that starts codex, and deletes it by the id it returned.
  private readonly machines: Record<RemoteMachineProvider, MachineDriver> = {
    local: {
      create: (request) => this.createLocalMachine(request),
      delete: (id) => this.deleteLocalMachine(id),
    },
    aws: {
      create: (request) => this.createAwsMachine(request),
      delete: (id) => this.deleteAwsMachine(id),
    },
    digitalocean: {
      create: (request) => this.createDigitalOceanMachine(request),
      delete: (id) => this.deleteDigitalOceanMachine(id),
    },
    databricks: {
      create: (request) => this.createDatabricksMachine(request),
      delete: (id) => this.deleteDatabricksMachine(id),
    },
    oci: {
      create: (request) => this.createOciMachine(request),
      delete: (id) => this.deleteOciMachine(id),
    },
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly openaiService: OpenaiService,
  ) {}

  // Create a sandbox agent. Leave model out to use the default model.
  // manifest, skills, memory, handoffDescription, and guardrails are optional.
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
      ...(options?.inputGuardrails && {
        inputGuardrails: options.inputGuardrails,
      }),
      ...(options?.outputGuardrails && {
        outputGuardrails: options.outputGuardrails,
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
    const client = await this.sandboxClient(options);
    if (!client.create)
      throw new Error('This computer cannot open a workspace.');
    return (await client.create({
      manifest: this.workspaceManifest(manifest, options?.password),
    })) as SandboxWorkspace;
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

  // Save the live session so a later process can resume the same files. Pass the same options used to open it.
  async saveSandbox(workspace: SandboxWorkspace, options?: OpenSandboxOptions) {
    const client = await this.sandboxClient(options);
    if (!client.serializeSessionState) {
      throw new Error('This computer cannot save a workspace.');
    }
    return await client.serializeSessionState(workspace.state);
  }

  // Resume a saved session. Pass the same computer, client, and snapshotDir used to open it.
  async resumeSandbox(
    saved: Record<string, unknown>,
    options?: OpenSandboxOptions,
  ) {
    const client = await this.sandboxClient(options);
    if (!client.resume || !client.deserializeSessionState) {
      throw new Error('This computer cannot resume a saved workspace.');
    }
    const state = await client.deserializeSessionState(saved);
    return (await client.resume(state)) as SandboxWorkspace;
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

  //1. Run once and let the SDK delete the workspace. Use this when the files do not need to survive.
  //2. Takes the same computer options as openSandbox. manifest replaces the agent's default manifest.
  async runSandboxOnce(
    prompt: string,
    agent: SandboxAgent,
    options?: FreshSandboxOptions & { chat?: Session },
  ) {
    return await run(agent, prompt, {
      sandbox: await this.freshSandbox(agent, options),
      ...(options?.chat && { session: options.chat }),
    });
  }

  //1. Call the sandbox agent as a tool. Pass a workspace to keep its files.
  //2. Leave workspace out for a fresh workspace on each call, built from the same options as openSandbox.
  //3. needsApproval is optional. Pass true to always pause, or a function that pauses some calls.
  async asTool(
    agent: SandboxAgent,
    options?: FreshSandboxOptions & {
      toolName?: string;
      toolDescription?: string;
      workspace?: SandboxWorkspace;
      needsApproval?: NonNullable<
        Parameters<OpenaiService['asTool']>[1]
      >['needsApproval'];
    },
  ) {
    return this.openaiService.asTool(agent, {
      toolName: options?.toolName,
      toolDescription: options?.toolDescription,
      ...(options?.needsApproval !== undefined && {
        needsApproval: options.needsApproval,
      }),
      runConfig: {
        sandbox: options?.workspace
          ? { session: options.workspace }
          : await this.freshSandbox(agent, options),
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
        model:
          options?.model ??
          this.configService.get<string>('OPENAI_HOSTED_MODEL') ??
          DEFAULT_HOSTED_MODEL,
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
      env: { CODEX_API_KEY: this.executorKey() },
    };
  }

  //1. Start the executor on this machine. A remote environment runs hostedExecutorCommand there instead.
  //2. The executor gets CODEX_API_KEY and a few basics only. This app's own keys stay out of reach of agent code.
  startHostedExecutor(
    session: Pick<HostedSession, 'environmentId' | 'remoteUrl'>,
  ) {
    const spec = this.hostedExecutorCommand(session);
    return spawn(spec.command, spec.args, {
      env: executorEnvironment(spec.env),
      stdio: 'inherit',
    });
  }

  //1. Open the event stream, start the executor on this machine, then wait for it to connect.
  //2. The executor is stopped if it fails or does not connect within timeoutMs.
  async connectHostedSession(
    session: Pick<HostedSession, 'sessionId' | 'environmentId' | 'remoteUrl'>,
    timeoutMs?: number,
  ) {
    let executor: ChildProcess | undefined;
    try {
      await this.waitForHostedConnection(session.sessionId, {
        timeoutMs,
        onListening: () => {
          executor = this.startHostedExecutor(session);
        },
      });
    } catch (error) {
      executor?.kill();
      throw error;
    }
    if (!executor) throw new Error('The executor did not start.');
    return executor;
  }

  //1. Read the session event stream until the executor connects.
  //2. onListening runs once the stream is open. Start a remote executor there so the connected event is not missed.
  //3. failed or expired carries the environment error. Waiting stops after timeoutMs.
  async waitForHostedConnection(
    sessionId: string,
    options?: {
      timeoutMs?: number;
      onListening?: () => unknown;
    },
  ) {
    const signal = AbortSignal.timeout(
      options?.timeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    try {
      const stream = await this.openai().beta.agents.sessions.events.stream(
        sessionId,
        { signal },
      );
      await options?.onListening?.();

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
    } catch (error) {
      if (signal.aborted) {
        throw new Error('The self-hosted environment did not connect in time.');
      }
      throw error;
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

  //1. Verify the OpenAI webhook, then create or delete the remote machine.
  //2. action_required with environment_connection creates the machine.
  //3. A failed session or an expired environment deletes it.
  //4. Work finishes before the reply, so a failure returns an error and OpenAI sends the event again.
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
      await this.releaseSessionMachine(event.data.id);
      return;
    }
    if (event.type === 'agent.environment.expired') {
      await this.releaseEnvironmentMachine(event.data.id);
    }
  }

  // One create per session in this process. connectRemoteMachine guards across processes.
  private async ensureRemoteMachine(sessionId: string) {
    const current = this.machineLocks.get(sessionId);
    if (current) return await current;
    const task = this.connectRemoteMachine(sessionId).finally(() => {
      this.machineLocks.delete(sessionId);
    });
    this.machineLocks.set(sessionId, task);
    return await task;
  }

  //1. Claim the session in its metadata before creating anything. Re-read so only one claim goes ahead.
  //2. Create the machine. A failure clears the claim so OpenAI's retry can try again.
  //3. Record the machine id. If that fails, delete the machine so nothing runs unrecorded.
  private async connectRemoteMachine(sessionId: string) {
    const session =
      await this.openai().beta.agents.sessions.retrieve(sessionId);
    if (session.environment.type !== 'self_hosted') return;
    const needsConnection = session.required_actions.some(
      (action) => action.type === 'environment_connection',
    );
    const current = session.metadata.remote_machine_id;
    if (!needsConnection || (current && !isStaleClaim(current))) return;

    const request = {
      sessionId: session.id,
      environmentId: session.environment.id,
      remoteUrl: session.environment.remote_url,
      executorKey: this.executorKey(),
    };
    const claim = `${CLAIM_PREFIX}${Date.now()}:${randomUUID()}`;
    await this.setMachineId(session.id, session.metadata, claim);
    const claimed =
      await this.openai().beta.agents.sessions.retrieve(sessionId);
    if (claimed.metadata.remote_machine_id !== claim) return;

    let machineId: string;
    try {
      machineId = await this.createRemoteMachine(request);
    } catch (error) {
      await this.setMachineId(session.id, session.metadata);
      throw error;
    }

    try {
      await this.setMachineId(session.id, session.metadata, machineId);
    } catch (error) {
      await this.deleteRemoteMachine(machineId).catch((cleanup: unknown) => {
        throw new AggregateError(
          [error, cleanup],
          `Remote machine ${machineId} was created but could not be recorded or deleted.`,
        );
      });
      throw error;
    }
  }

  // Replace remote_machine_id and keep the other metadata. Leave machineId out to remove it.
  private async setMachineId(
    sessionId: string,
    metadata: Record<string, string>,
    machineId?: string,
  ) {
    const next = { ...metadata };
    delete next.remote_machine_id;
    if (machineId) next.remote_machine_id = machineId;
    await this.openai().beta.agents.sessions.update(sessionId, {
      metadata: next,
    });
  }

  private async releaseSessionMachine(sessionId: string) {
    try {
      const session =
        await this.openai().beta.agents.sessions.retrieve(sessionId);
      if (session.status !== 'failed') return;
      await this.releaseMachine(session.metadata.remote_machine_id);
    } catch (error) {
      if (error instanceof APIError && error.status === 404) return;
      throw error;
    }
  }

  // The expired event names only the environment, so find its session among the recent ones.
  private async releaseEnvironmentMachine(environmentId: string) {
    let scanned = 0;
    for await (const session of this.openai().beta.agents.sessions.list({
      order: 'desc',
    })) {
      if (
        session.environment.type === 'self_hosted' &&
        session.environment.id === environmentId
      ) {
        await this.releaseMachine(session.metadata.remote_machine_id);
        return;
      }
      if (++scanned >= EXPIRED_SCAN_LIMIT) return;
    }
  }

  private async releaseMachine(machineId?: string) {
    if (!machineId || machineId.startsWith(CLAIM_PREFIX)) return;
    await this.deleteRemoteMachine(machineId);
  }

  // The id prefix says which provider created the machine, so delete still works if the setting changes.
  private async createRemoteMachine(request: MachineRequest) {
    const provider = this.remoteProvider();
    return `${provider}:${await this.machines[provider].create(request)}`;
  }

  private async deleteRemoteMachine(machineId: string) {
    const separator = machineId.indexOf(':');
    const provider = machineId.slice(0, separator);
    if (!isRemoteMachineProvider(provider)) {
      throw new Error(`Unknown remote machine ${provider}.`);
    }
    await this.machines[provider].delete(machineId.slice(separator + 1));
  }

  private createLocalMachine(request: MachineRequest) {
    const child = this.startHostedExecutor(request);
    if (!child.pid) throw new Error('The local executor did not start.');
    const pid = String(child.pid);
    this.localExecutors.set(pid, child);
    child.once('exit', () => this.localExecutors.delete(pid));
    return pid;
  }

  // Only stop an executor this process started. After a restart the pid may belong to another program.
  private deleteLocalMachine(pid: string) {
    this.localExecutors.get(pid)?.kill();
    this.localExecutors.delete(pid);
  }

  private async createAwsMachine(request: MachineRequest) {
    const result = await runFile(
      'aws',
      awsRunArgs({
        image: this.setting('AWS_MICROVM_IMAGE_ARN'),
        region: this.configService.get<string>('AWS_REGION'),
        executionRole: this.configService.get<string>(
          'AWS_MICROVM_EXECUTION_ROLE',
        ),
        payload: JSON.stringify({
          environmentId: request.environmentId,
          remoteUrl: request.remoteUrl,
          secretArn: this.setting('AWS_MICROVM_SECRET_ARN'),
        }),
      }),
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
    const body = JSON.parse(result.stdout) as { microvmId?: string };
    if (!body.microvmId) throw new Error('AWS did not return a MicroVM id.');
    return body.microvmId;
  }

  private async deleteAwsMachine(id: string) {
    await runFile(
      'aws',
      awsTerminateArgs(id, this.configService.get<string>('AWS_REGION')),
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
  }

  private async createDigitalOceanMachine(request: MachineRequest) {
    const url = new URL('https://api.digitalocean.com/v2/agents/sessions');
    url.searchParams.set('openai_session_id', request.sessionId);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.setting('DIGITALOCEAN_TOKEN')}`,
        'Content-Type': 'application/x-yaml',
      },
      body: digitalOceanManifest(request),
    });
    const id = readId(await readJson(response));
    if (!id) throw new Error('DigitalOcean did not return a session id.');
    return id;
  }

  private async deleteDigitalOceanMachine(id: string) {
    const response = await fetch(
      `https://api.digitalocean.com/v2/agents/sessions/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.setting('DIGITALOCEAN_TOKEN')}`,
        },
      },
    );
    assertDeleted(response, 'DigitalOcean');
  }

  //1. The sandbox id comes from the session id, so a retry finds the same sandbox instead of making a second one.
  //2. 409 means that sandbox already exists. The start command runs again on it.
  private async createDatabricksMachine(request: MachineRequest) {
    const host = databricksHost(this.setting('DATABRICKS_HOST'));
    const token = this.setting('DATABRICKS_TOKEN');
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
    const body = created.status === 409 ? undefined : await readJson(created);
    const name =
      typeof body === 'object' &&
      body &&
      'name' in body &&
      typeof body.name === 'string'
        ? body.name
        : `sandboxes/${sandboxId}`;
    const started = await fetch(
      `${host}/api/2.0/sandbox-exec/${name}/exec-sync`,
      {
        method: 'POST',
        headers: databricksHeaders(token),
        body: JSON.stringify({
          cmd: '/bin/bash',
          args: ['-lc', databricksExecutorScript(request)],
          envs: { CODEX_API_KEY: request.executorKey, RUST_LOG: 'info' },
          execution_timeout: '120s',
        }),
      },
    );
    await readJson(started);
    return name;
  }

  private async deleteDatabricksMachine(name: string) {
    const host = databricksHost(this.setting('DATABRICKS_HOST'));
    const response = await fetch(`${host}/api/2.0/${name}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.setting('DATABRICKS_TOKEN')}`,
        Accept: 'application/json',
      },
    });
    assertDeleted(response, 'Databricks');
  }

  private async createOciMachine(request: MachineRequest) {
    const response = await fetch(this.setting('OCI_SANDBOX_CREATE_URL'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.setting('OCI_SANDBOX_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: this.setting('OCI_SANDBOX_PROJECT_ID'),
        displayName: `openai-${request.sessionId}`,
        freeformTags: {
          environmentId: request.environmentId,
          remoteUrl: request.remoteUrl,
        },
      }),
    });
    const id = readId(await readJson(response));
    if (!id) throw new Error('OCI did not return a sandbox id.');
    return id;
  }

  private async deleteOciMachine(id: string) {
    const endpoint = this.setting('OCI_SANDBOX_CREATE_URL');
    const response = await fetch(
      `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.setting('OCI_SANDBOX_TOKEN')}`,
        },
      },
    );
    assertDeleted(response, 'OCI');
  }

  private remoteProvider(): RemoteMachineProvider {
    return (
      this.configService.get<RemoteMachineProvider>(
        'REMOTE_MACHINE_PROVIDER',
      ) ?? 'local'
    );
  }

  //1. One place picks the client, so open, save, resume, runSandboxOnce, and asTool always agree.
  //2. client wins, then a hosted computer, then Docker, then Unix.
  private async sandboxClient(
    options?: OpenSandboxOptions,
  ): Promise<SandboxClient> {
    if (options?.client) return options.client;
    if (options?.computer && isHostedComputer(options.computer)) {
      return await this.providerClient(options.computer, options);
    }
    const clientOptions = this.clientOptions(options);
    if (options?.computer === 'docker') {
      return new DockerSandboxClient({
        image: options.image ?? DOCKER_IMAGE,
        ...clientOptions,
      });
    }
    return new UnixLocalSandboxClient(clientOptions);
  }

  // A client and manifest for a workspace the SDK creates and deletes on its own.
  private async freshSandbox(
    agent: SandboxAgent,
    options?: FreshSandboxOptions,
  ) {
    return {
      client: await this.sandboxClient(options),
      manifest: this.workspaceManifest(
        options?.manifest ?? agent.defaultManifest ?? new Manifest(),
        options?.password,
      ),
    };
  }

  //1. Add ACCOUNT_PASSWORD to the manifest environment. ephemeral keeps it out of saved state.
  //2. Every other manifest field is kept. With no password, the manifest is returned unchanged.
  private workspaceManifest(manifest: Manifest, password?: string) {
    const secret =
      password !== undefined
        ? password.trim() || undefined
        : this.configService.get<string>('ACCOUNT_PASSWORD');
    if (secret === undefined) return manifest;
    return new Manifest({
      version: manifest.version,
      root: manifest.root,
      entries: manifest.entries,
      environment: {
        ...manifest.environment,
        ACCOUNT_PASSWORD: { value: secret, ephemeral: true },
      },
      users: manifest.users,
      groups: manifest.groups,
      extraPathGrants: manifest.extraPathGrants,
      remoteMountCommandAllowlist: manifest.remoteMountCommandAllowlist,
    });
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
    return this.openaiService.client();
  }

  private executorKey() {
    return this.configService
      .getOrThrow<string>('OPENAI_EXECUTOR_API_KEY')
      .trim();
  }

  private setting(name: keyof Environment) {
    const value = this.configService.get<string>(name);
    if (!value) throw new Error(`${name} is required for this remote machine.`);
    return value;
  }

  private clientOptions(options?: OpenSandboxOptions) {
    return {
      ...(options?.ports && { exposedPorts: options.ports }),
      ...(options?.snapshotDir && {
        snapshot: { type: 'local' as const, baseDir: options.snapshotDir },
      }),
    };
  }
}

function isHostedComputer(
  computer: SandboxComputer,
): computer is Exclude<SandboxComputer, 'unix' | 'docker'> {
  return computer !== 'unix' && computer !== 'docker';
}

function isRemoteMachineProvider(
  provider: string,
): provider is RemoteMachineProvider {
  return (remoteMachineProviders as readonly string[]).includes(provider);
}

function isStaleClaim(machineId: string) {
  if (!machineId.startsWith(CLAIM_PREFIX)) return false;
  const claimedAt = Number(machineId.slice(CLAIM_PREFIX.length).split(':')[0]);
  return !(Date.now() - claimedAt < CLAIM_TTL_MS);
}

export function executorEnvironment(extra: Record<string, string>) {
  const basics = EXECUTOR_ENV_KEYS.flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value] as const] : [];
  });
  return { ...Object.fromEntries(basics), ...extra };
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

// Values are double-quoted, so a key with :, #, or a newline cannot break the YAML.
export function digitalOceanManifest(request: MachineRequest) {
  return [
    'agent: codex-agentapi',
    'egress:',
    '  - api.openai.com',
    '  - codex-cloud-environments.chatgpt.com',
    'env:',
    `  CODEX_ENVIRONMENT_ID: ${JSON.stringify(request.environmentId)}`,
    'secrets:',
    `  CODEX_API_KEY: ${JSON.stringify(request.executorKey)}`,
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

function databricksHost(value: string) {
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

async function readJson(response: Response) {
  if (!response.ok) {
    throw new Error(
      `Remote machine request failed with status ${response.status}.`,
    );
  }
  return (await response.json()) as unknown;
}

// A machine that is already gone counts as deleted.
function assertDeleted(response: Response, provider: string) {
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `${provider} delete failed with status ${response.status}.`,
    );
  }
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
