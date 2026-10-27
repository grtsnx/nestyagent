import {
  Injectable,
  Logger,
  UnauthorizedException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Session, type AgentInputItem, type TextOutput } from '@openai/agents';
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
import {
  guardrailConfig,
  OpenaiService,
  type AgentGuardrails,
  type RunAgentOptions,
} from '../openai/openai.service.js';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service.js';

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

type CreateSandboxAgentOptions = AgentGuardrails & {
  model?: string;
  manifest?: Manifest;
  skills?: SkillsArgs;
  memory?: boolean | MemoryArgs;
  handoffDescription?: string;
};

export type SandboxWorkspace = SandboxSession;

// Any sandbox agent, whatever its context or output type.
type AnySandboxAgent = SandboxAgent<any, any>;

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

const DOCKER_IMAGE = 'node:24-bookworm-slim';
// Used when neither the call nor OPENAI_HOSTED_MODEL names a model.
const DEFAULT_HOSTED_MODEL = 'gpt-6-astra';
// How long to wait for an executor to connect before giving up.
const CONNECT_TIMEOUT_MS = 120_000;
const PROVIDER_TIMEOUT_MS = 120_000;
const WORKER_POLL_MS = 1_000;
const WEBHOOK_LEASE_MS = 5 * 60_000;
// The only variables the executor inherits from this app, besides CODEX_API_KEY.
const EXECUTOR_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL'];
const runFile = promisify(execFile);

type MachineRequest = {
  sessionId: string;
  environmentId: string;
  remoteUrl: string;
  executorKey: string;
  signal?: AbortSignal;
};

type MachineDriver = {
  create: (request: MachineRequest) => Promise<string> | string;
  delete: (id: string, signal?: AbortSignal) => Promise<void> | void;
};

@Injectable()
export class SandboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxService.name);
  private readonly ownerId = randomUUID();
  private readonly localExecutors = new Map<string, ChildProcess>();
  private readonly stoppedExecutors = new Set<string>();
  private readonly executorProcesses = new Set<ChildProcess>();
  private readonly executorUpdates = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private workerTimer?: ReturnType<typeof setInterval>;
  private workerTask?: Promise<void>;

  // Each provider creates a machine that starts codex, and deletes it by the id it returned.
  private readonly machines: Record<RemoteMachineProvider, MachineDriver> = {
    local: {
      create: (request) => this.createLocalMachine(request),
      delete: (id) => this.deleteLocalMachine(id),
    },
    aws: {
      create: (request) => this.createAwsMachine(request),
      delete: (id, signal) => this.deleteAwsMachine(id, signal),
    },
    digitalocean: {
      create: (request) => this.createDigitalOceanMachine(request),
      delete: (id, signal) => this.deleteDigitalOceanMachine(id, signal),
    },
    databricks: {
      create: (request) => this.createDatabricksMachine(request),
      delete: (id, signal) => this.deleteDatabricksMachine(id, signal),
    },
    oci: {
      create: (request) => this.createOciMachine(request),
      delete: (id, signal) => this.deleteOciMachine(id, signal),
    },
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly openaiService: OpenaiService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    if (
      !this.configService.get('DATABASE_URL') ||
      !this.configService.get('OPENAI_WEBHOOK_SECRET')
    )
      return;
    const poll = () => {
      void this.processHostedWebhooks().catch(() =>
        this.logger.error('Hosted webhook worker could not access its queue.'),
      );
    };
    this.workerTimer = setInterval(poll, WORKER_POLL_MS);
    this.workerTimer.unref();
    poll();
  }

  async onModuleDestroy() {
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.shutdown.abort(new Error('Sandbox service is stopping.'));
    await this.workerTask?.catch(() => undefined);
    await Promise.all(
      [...this.executorProcesses].map((child) => this.stopExecutor(child)),
    );
    await Promise.all(this.executorUpdates);
  }

  // Create a sandbox agent. Leave model out to use the default model.
  // manifest, skills, memory, handoffDescription, and guardrails are optional.
  createSandboxAgent(
    name: string,
    instructions: string,
    options?: CreateSandboxAgentOptions,
  ) {
    // Explicit types keep the guardrail list from changing the agent's text output.
    return new SandboxAgent<unknown, TextOutput>({
      name,
      instructions,
      capabilities: this.capabilities(options),
      ...(options?.model && { model: options.model }),
      ...(options?.manifest && { defaultManifest: options.manifest }),
      ...(options?.handoffDescription && {
        handoffDescription: options.handoffDescription,
      }),
      ...guardrailConfig(options),
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

  //1. Open a workspace. Production defaults to Docker; development defaults to Unix.
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
    prompt: string | AgentInputItem[],
    agent: AnySandboxAgent,
    options: RunAgentOptions<unknown> & {
      workspace: SandboxWorkspace;
      chat?: Session;
    },
  ) {
    const { workspace, chat, ...runOptions } = options;
    return await this.openaiService.runAgent(prompt, agent, {
      ...runOptions,
      sandbox: { session: workspace },
      session: runOptions.session ?? chat,
    });
  }

  // Run once with a workspace the SDK creates and closes for this call.
  async runSandboxOnce(
    prompt: string | AgentInputItem[],
    agent: AnySandboxAgent,
    options?: FreshSandboxOptions &
      RunAgentOptions<unknown> & { chat?: Session },
  ) {
    const { chat, ...runOptions } = options ?? {};
    return await this.openaiService.runAgent(prompt, agent, {
      ...runOptions,
      sandbox: await this.freshSandbox(agent, options),
      session: runOptions.session ?? chat,
    });
  }

  //1. Call the sandbox agent as a tool. Pass a workspace to keep its files.
  //2. Leave workspace out for a fresh workspace on each call, built from the same options as openSandbox.
  //3. needsApproval is optional. Pass true to always pause, or a function that pauses some calls.
  async asTool(
    agent: AnySandboxAgent,
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
    signal?: AbortSignal,
  ) {
    this.assertLocalAllowed();
    this.shutdown.signal.throwIfAborted();
    const spec = this.hostedExecutorCommand(session);
    const child = spawn(spec.command, spec.args, {
      env: executorEnvironment(spec.env),
      stdio: 'inherit',
      signal: signal
        ? AbortSignal.any([signal, this.shutdown.signal])
        : this.shutdown.signal,
    });
    this.executorProcesses.add(child);
    const track = () => {
      if (child.pid)
        this.localExecutors.set(`${this.ownerId}:${child.pid}`, child);
    };
    track();
    child.once('spawn', track);
    // A spawn failure must never become an unhandled EventEmitter error.
    child.on('error', () =>
      this.logger.warn('Local executor reported a process error.'),
    );
    child.once('close', () => {
      this.executorProcesses.delete(child);
      if (!child.pid) return;
      const id = `${this.ownerId}:${child.pid}`;
      this.localExecutors.delete(id);
      this.stoppedExecutors.add(id);
      if (this.configService.get('DATABASE_URL')) {
        const update = this.db()
          .remoteMachine.updateMany({
            where: { machineId: `local:${id}` },
            data: {
              status: 'deleted',
              desiredState: 'deleted',
              machineId: null,
            },
          })
          .catch(() =>
            this.logger.warn(
              'Exited local executor still needs database reconciliation.',
            ),
          );
        this.executorUpdates.add(update);
        void update.finally(() => this.executorUpdates.delete(update));
      }
    });
    return child;
  }

  //1. Open the event stream, start the executor on this machine, then wait for it to connect.
  //2. The executor is stopped if it fails or does not connect within timeoutMs.
  async connectHostedSession(
    session: Pick<HostedSession, 'sessionId' | 'environmentId' | 'remoteUrl'>,
    timeoutMs?: number,
  ) {
    let executor: ChildProcess | undefined;
    const failed = new AbortController();
    const onError = (error: Error) => failed.abort(error);
    const onExit = () =>
      failed.abort(new Error('The local executor exited before connecting.'));
    try {
      await this.waitForHostedConnection(session.sessionId, {
        timeoutMs,
        signal: failed.signal,
        onListening: () => {
          executor = this.startHostedExecutor(session);
          executor.once('error', onError);
          executor.once('exit', onExit);
        },
      });
    } catch (error) {
      if (executor) await this.stopExecutor(executor);
      throw error;
    } finally {
      executor?.off('error', onError);
      executor?.off('exit', onExit);
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
      signal?: AbortSignal;
    },
  ) {
    const timeout = AbortSignal.timeout(
      options?.timeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    const signal = AbortSignal.any([
      timeout,
      this.shutdown.signal,
      ...(options?.signal ? [options.signal] : []),
    ]);
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
      if (timeout.aborted) {
        throw new Error('The self-hosted environment did not connect in time.');
      }
      signal.throwIfAborted();
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

  // A successful response means the verified event is durable. Provider work runs separately.
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
    if (
      event.type !== 'agent.session.failed' &&
      event.type !== 'agent.environment.expired' &&
      !(
        event.type === 'agent.session.action_required' &&
        event.data.required_action.type === 'environment_connection'
      )
    )
      return;
    const headerId = headers['webhook-id'];
    const id =
      event.id ??
      (typeof headerId === 'string' ? headerId : undefined) ??
      createHash('sha256').update(rawBody).digest('hex');
    try {
      await this.db().hostedWebhook.create({
        data: { id, type: event.type, resourceId: event.data.id },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // Leases survive crashes. The environment advisory lock serializes provider calls across replicas.
  async processHostedWebhooks(): Promise<void> {
    if (this.workerTask) return await this.workerTask;
    if (this.shutdown.signal.aborted) return;
    this.workerTask = this.drainHostedWebhooks();
    try {
      await this.workerTask;
    } finally {
      this.workerTask = undefined;
    }
  }

  private async drainHostedWebhooks() {
    const due = {
      OR: [
        { status: 'pending' as const, availableAt: { lte: new Date() } },
        { status: 'processing' as const, leaseExpiresAt: { lte: new Date() } },
      ],
    };
    const events = await this.db().hostedWebhook.findMany({
      where: due,
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const event of events) {
      if (this.shutdown.signal.aborted) return;
      const leaseToken = randomUUID();
      const claimed = await this.db().hostedWebhook.updateMany({
        where: { id: event.id, ...due },
        data: {
          status: 'processing',
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + WEBHOOK_LEASE_MS),
          attempts: { increment: 1 },
        },
      });
      if (!claimed.count) continue;
      const lease = new AbortController();
      const heartbeat = setInterval(() => {
        void this.db()
          .hostedWebhook.updateMany({
            where: { id: event.id, leaseToken },
            data: { leaseExpiresAt: new Date(Date.now() + WEBHOOK_LEASE_MS) },
          })
          .then((result) => {
            if (!result.count)
              lease.abort(new Error('Webhook lease was lost.'));
          })
          .catch(() =>
            lease.abort(new Error('Webhook lease could not be renewed.')),
          );
      }, WEBHOOK_LEASE_MS / 3);
      heartbeat.unref();
      try {
        const signal = AbortSignal.any([lease.signal, this.shutdown.signal]);
        if (event.type === 'agent.session.action_required')
          await this.connectRemoteMachine(event.resourceId, signal);
        else
          await this.releaseMachine(
            event.type === 'agent.environment.expired'
              ? { environmentId: event.resourceId }
              : { sessionId: event.resourceId },
            signal,
          );
        await this.db().hostedWebhook.updateMany({
          where: { id: event.id, leaseToken },
          data: {
            status: 'completed',
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
          },
        });
      } catch (error) {
        const reconciliation = error instanceof MachineReconciliationRequired;
        await this.db().hostedWebhook.updateMany({
          where: { id: event.id, leaseToken },
          data: {
            status: reconciliation ? 'reconciliation' : 'pending',
            availableAt: new Date(
              Date.now() +
                Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts, 6)),
            ),
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: reconciliation
              ? 'machine_reconciliation_required'
              : 'processing_failed',
          },
        });
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  private async connectRemoteMachine(sessionId: string, signal: AbortSignal) {
    let session;
    try {
      session = await this.openai().beta.agents.sessions.retrieve(sessionId, {
        signal: providerSignal(signal),
      });
    } catch (error) {
      if (error instanceof APIError && error.status === 404) return;
      throw error;
    }
    if (session.environment.type !== 'self_hosted') return;
    const environment = session.environment;
    await this.prisma.withLock(
      `sandbox:${environment.id}`,
      async (lockSignal) => {
        const operationSignal = AbortSignal.any([signal, lockSignal]);
        operationSignal.throwIfAborted();
        let row = await this.db().remoteMachine.findUnique({
          where: { sessionId },
        });
        const expired = await this.hasExpiredEnvironment(environment.id);
        const needsConnection = session.required_actions.some(
          (action) => action.type === 'environment_connection',
        );
        if (
          !expired &&
          session.status !== 'failed' &&
          needsConnection &&
          row?.status === 'deleted'
        ) {
          await this.db().remoteMachine.updateMany({
            where: { sessionId },
            data: { desiredState: 'active' },
          });
          await this.requireReconciliation(
            sessionId,
            undefined,
            'executor_connection_missing',
          );
        }
        if (
          row?.desiredState === 'deleted' ||
          session.status === 'failed' ||
          expired
        ) {
          if (row)
            await this.deleteClaimedMachine(
              row,
              operationSignal,
              expired || row.desiredState === 'deleted',
            );
          return;
        }
        if (!needsConnection) return;
        if (row?.status === 'ready') await this.checkReadyMachine(row);
        if (row && row.status !== 'pending') {
          await this.requireReconciliation(sessionId);
        }
        const provider =
          row?.provider && isRemoteMachineProvider(row.provider)
            ? row.provider
            : this.remoteProvider();
        this.validateMachineSettings(provider);
        const request: MachineRequest = {
          sessionId,
          environmentId: environment.id,
          remoteUrl: environment.remote_url,
          executorKey: this.executorKey(),
          signal: operationSignal,
        };
        const claimToken = randomUUID();
        if (!row) {
          row = await this.db().remoteMachine.create({
            data: {
              sessionId,
              environmentId: environment.id,
              claimToken,
              provider,
            },
          });
        }
        await this.db().remoteMachine.updateMany({
          where: { sessionId },
          data: {
            status: 'creating',
            provider,
            claimToken,
            claimedAt: new Date(),
            lastError: null,
          },
        });
        let machineId: string;
        try {
          operationSignal.throwIfAborted();
          machineId = `${provider}:${await this.machines[provider].create(request)}`;
        } catch (error) {
          return await this.requireReconciliation(
            sessionId,
            error instanceof KnownMachineFailure ? error.machineId : undefined,
          );
        }
        try {
          const saved = await this.db().remoteMachine.updateMany({
            where: { sessionId, claimToken, status: 'creating' },
            data: {
              machineId,
              status: operationSignal.aborted ? 'reconciliation' : 'ready',
              claimedAt: new Date(),
            },
          });
          if (saved.count !== 1) throw new Error('Machine claim was lost.');
        } catch {
          // Keep the known id whenever the database recovers. Never erase an ambiguous create claim.
          try {
            await this.db().remoteMachine.updateMany({
              where: { sessionId },
              data: {
                machineId,
                status: 'reconciliation',
                desiredState: 'deleted',
                lastError: 'machine_record_failed',
              },
            });
          } catch {
            this.logger.error(
              `Machine requires reconciliation: session=${sessionId} machine=${machineId}`,
            );
          }
          throw new MachineReconciliationRequired();
        }
        if (operationSignal.aborted) throw new MachineReconciliationRequired();
        const expiredAfterCreate = await this.hasExpiredEnvironment(
          environment.id,
        );
        if (
          (provider === 'local' &&
            this.stoppedExecutors.has(machineId.slice('local:'.length))) ||
          expiredAfterCreate ||
          (await this.isSessionFailed(sessionId, operationSignal))
        ) {
          await this.deleteClaimedMachine(
            { ...row, machineId, status: 'ready' },
            operationSignal,
            expiredAfterCreate,
          );
        }
      },
    );
  }

  // A required connection can mean an executor is still booting. Retain the event during
  // the grace period, then require an operator to inspect the provider before any replacement.
  private async checkReadyMachine(row: {
    sessionId: string;
    machineId: string | null;
    claimedAt: Date;
  }): Promise<never> {
    const local = row.machineId?.startsWith('local:');
    const child =
      local && row.machineId
        ? this.localExecutors.get(row.machineId.slice('local:'.length))
        : undefined;
    if (
      !row.machineId ||
      (local &&
        (!child || child.exitCode !== null || child.signalCode !== null)) ||
      Date.now() - row.claimedAt.getTime() >= CONNECT_TIMEOUT_MS
    ) {
      return await this.requireReconciliation(
        row.sessionId,
        undefined,
        'executor_connection_missing',
      );
    }
    throw new Error('The executor is still waiting to connect.');
  }

  // Expiry is permanent. Session failures must be checked against the current session state.
  private async hasExpiredEnvironment(environmentId: string) {
    return (
      (
        await this.db().hostedWebhook.findMany({
          where: {
            type: 'agent.environment.expired',
            resourceId: environmentId,
          },
          take: 1,
        })
      ).length > 0
    );
  }

  private async isSessionFailed(sessionId: string, signal: AbortSignal) {
    try {
      const session = await this.openai().beta.agents.sessions.retrieve(
        sessionId,
        {
          signal: providerSignal(signal),
        },
      );
      return session.status === 'failed';
    } catch (error) {
      if (error instanceof APIError && error.status === 404) return true;
      throw error;
    }
  }

  private async releaseMachine(
    where: { sessionId: string } | { environmentId: string },
    signal: AbortSignal,
  ) {
    const row = await this.db().remoteMachine.findUnique({ where });
    // Expiry remains in the inbox even if provisioning has not inserted its row yet.
    if (!row) return;
    await this.prisma.withLock(
      `sandbox:${row.environmentId}`,
      async (lockSignal) => {
        const operationSignal = AbortSignal.any([signal, lockSignal]);
        if (
          'sessionId' in where &&
          !(await this.isSessionFailed(where.sessionId, operationSignal))
        )
          return;
        const current = await this.db().remoteMachine.findUnique({ where });
        if (current)
          await this.deleteClaimedMachine(
            current,
            operationSignal,
            'environmentId' in where,
          );
      },
    );
  }

  private async deleteClaimedMachine(
    row: { sessionId: string; machineId: string | null; status: string },
    signal: AbortSignal,
    permanent: boolean,
  ) {
    // A failed session can recover before a retry; only expiry or explicit orphan disposal
    // should persist a terminal intent. The failure event itself remains durable for retries.
    if (permanent) {
      await this.db().remoteMachine.updateMany({
        where: { sessionId: row.sessionId },
        data: { desiredState: 'deleted' },
      });
    }
    if (!row.machineId && ['creating', 'reconciliation'].includes(row.status))
      await this.requireReconciliation(row.sessionId);
    if (row.machineId) {
      signal.throwIfAborted();
      try {
        await this.deleteRemoteMachine(row.machineId, signal);
      } catch (error) {
        if (error instanceof MachineReconciliationRequired)
          await this.requireReconciliation(row.sessionId);
        throw error;
      }
    }
    await this.db().remoteMachine.updateMany({
      where: { sessionId: row.sessionId },
      data: { status: 'deleted', machineId: null, lastError: null },
    });
  }

  private async requireReconciliation(
    sessionId: string,
    machineId?: string,
    reason = 'provider_outcome_unknown',
  ): Promise<never> {
    await this.db().remoteMachine.updateMany({
      where: { sessionId },
      data: {
        status: 'reconciliation',
        lastError: reason,
        ...(machineId && { machineId }),
      },
    });
    throw new MachineReconciliationRequired();
  }

  // Operator recovery after checking the provider. Absence must be confirmed before another create is allowed.
  async reconcileRemoteMachine(
    sessionId: string,
    outcome: { machineId: string } | { absent: true },
  ) {
    const row = await this.db().remoteMachine.findUniqueOrThrow({
      where: { sessionId },
    });
    if (
      'machineId' in outcome &&
      !isRemoteMachineProvider(outcome.machineId.split(':')[0])
    ) {
      throw new Error('A provider-prefixed machine id is required.');
    }
    await this.prisma.withLock(`sandbox:${row.environmentId}`, async () => {
      const current = await this.db().remoteMachine.findUniqueOrThrow({
        where: { sessionId },
      });
      if (!['creating', 'reconciliation'].includes(current.status))
        throw new Error('This machine does not need reconciliation.');
      await this.db().$transaction(async (tx) => {
        await tx.remoteMachine.updateMany({
          where: { sessionId },
          data: {
            machineId: 'machineId' in outcome ? outcome.machineId : null,
            status:
              'machineId' in outcome
                ? 'ready'
                : current.desiredState === 'deleted'
                  ? 'deleted'
                  : 'pending',
            lastError: null,
            claimedAt: new Date(),
          },
        });
        await tx.hostedWebhook.updateMany({
          where: {
            status: 'reconciliation',
            OR: [
              {
                type: 'agent.environment.expired',
                resourceId: current.environmentId,
              },
              {
                type: {
                  in: ['agent.session.action_required', 'agent.session.failed'],
                },
                resourceId: sessionId,
              },
            ],
          },
          data: { status: 'pending', availableAt: new Date(), lastError: null },
        });
      });
    });
  }

  // The prefix keeps cleanup tied to the original provider when configuration changes.
  private async deleteRemoteMachine(machineId: string, signal?: AbortSignal) {
    const separator = machineId.indexOf(':');
    const provider = machineId.slice(0, separator);
    if (!isRemoteMachineProvider(provider))
      throw new MachineReconciliationRequired();
    await this.machines[provider].delete(
      machineId.slice(separator + 1),
      signal,
    );
  }

  private async createLocalMachine(request: MachineRequest) {
    const child = this.startHostedExecutor(request, request.signal);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (!child.pid) throw new Error('The local executor did not start.');
    return `${this.ownerId}:${child.pid}`;
  }

  private async deleteLocalMachine(id: string) {
    if (this.stoppedExecutors.has(id)) return;
    const child = this.localExecutors.get(id);
    if (!child) throw new MachineReconciliationRequired();
    await this.stopExecutor(child);
  }

  private async stopExecutor(child: ChildProcess) {
    if (!child.pid || !this.executorProcesses.has(child)) return;
    const running = child.exitCode === null && child.signalCode === null;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (running && !child.kill('SIGKILL')) {
          cleanup();
          reject(new Error('Local executor could not be stopped.'));
        }
      }, 5_000);
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error('Local executor did not exit.'));
      }, 10_000);
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(deadline);
        child.off('close', exited);
      };
      const exited = () => {
        cleanup();
        resolve();
      };
      child.once('close', exited);
      if (running && !child.kill()) {
        cleanup();
        reject(new Error('Local executor could not be stopped.'));
      }
    });
  }

  private validateMachineSettings(provider: RemoteMachineProvider) {
    if (provider === 'local') this.assertLocalAllowed();
    const required = {
      local: [],
      aws: ['AWS_MICROVM_IMAGE_ARN', 'AWS_MICROVM_SECRET_ARN'],
      digitalocean: ['DIGITALOCEAN_TOKEN'],
      databricks: ['DATABRICKS_HOST', 'DATABRICKS_TOKEN'],
      oci: [
        'OCI_SANDBOX_CREATE_URL',
        'OCI_SANDBOX_TOKEN',
        'OCI_SANDBOX_PROJECT_ID',
      ],
    } as const;
    for (const key of required[provider]) this.setting(key);
    if (provider === 'databricks')
      databricksHost(this.setting('DATABRICKS_HOST'));
  }

  private assertLocalAllowed() {
    if (this.configService.get('NODE_ENV') === 'production')
      throw new Error(
        'Local executors and Unix workspaces are disabled in production.',
      );
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
      {
        timeout: PROVIDER_TIMEOUT_MS,
        maxBuffer: 1_000_000,
        signal: providerSignal(request.signal),
      },
    );
    const body = JSON.parse(result.stdout) as { microvmId?: string };
    if (!body.microvmId) throw new Error('AWS did not return a MicroVM id.');
    return body.microvmId;
  }

  private async deleteAwsMachine(id: string, signal?: AbortSignal) {
    await runFile(
      'aws',
      awsTerminateArgs(id, this.configService.get<string>('AWS_REGION')),
      {
        timeout: PROVIDER_TIMEOUT_MS,
        maxBuffer: 1_000_000,
        signal: providerSignal(signal),
      },
    );
  }

  private async createDigitalOceanMachine(request: MachineRequest) {
    const url = new URL('https://api.digitalocean.com/v2/agents/sessions');
    url.searchParams.set('openai_session_id', request.sessionId);
    const response = await fetch(url, {
      method: 'POST',
      signal: providerSignal(request.signal),
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

  private async deleteDigitalOceanMachine(id: string, signal?: AbortSignal) {
    const response = await fetch(
      `https://api.digitalocean.com/v2/agents/sessions/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        signal: providerSignal(signal),
        headers: {
          Authorization: `Bearer ${this.setting('DIGITALOCEAN_TOKEN')}`,
        },
      },
    );
    assertDeleted(response, 'DigitalOcean');
  }

  // The stable id identifies an existing sandbox. Reconcile a conflict before launching another executor.
  private async createDatabricksMachine(request: MachineRequest) {
    const host = databricksHost(this.setting('DATABRICKS_HOST'));
    const token = this.setting('DATABRICKS_TOKEN');
    const sandboxId = databricksSandboxId(request.sessionId);
    const created = await fetch(
      `${host}/api/2.0/sandboxes?sandbox_id=${encodeURIComponent(sandboxId)}`,
      {
        method: 'POST',
        signal: providerSignal(request.signal),
        headers: databricksHeaders(token),
        body: JSON.stringify({
          spec: { compute: { inactivity_timeout: '900s' } },
        }),
      },
    );
    if (created.status === 409) {
      throw new KnownMachineFailure(`databricks:sandboxes/${sandboxId}`);
    }
    const body = await readJson(created);
    const name =
      typeof body === 'object' &&
      body &&
      'name' in body &&
      typeof body.name === 'string'
        ? body.name
        : `sandboxes/${sandboxId}`;
    try {
      const started = await fetch(
        `${host}/api/2.0/sandbox-exec/${name}/exec-sync`,
        {
          method: 'POST',
          signal: providerSignal(request.signal),
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
    } catch {
      throw new KnownMachineFailure(`databricks:${name}`);
    }
    return name;
  }

  private async deleteDatabricksMachine(name: string, signal?: AbortSignal) {
    const host = databricksHost(this.setting('DATABRICKS_HOST'));
    const response = await fetch(`${host}/api/2.0/${name}`, {
      method: 'DELETE',
      signal: providerSignal(signal),
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
      signal: providerSignal(request.signal),
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

  private async deleteOciMachine(id: string, signal?: AbortSignal) {
    const endpoint = this.setting('OCI_SANDBOX_CREATE_URL');
    const response = await fetch(
      `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        signal: providerSignal(signal),
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
    if (options?.client) {
      if (options.client instanceof UnixLocalSandboxClient)
        this.assertLocalAllowed();
      return options.client;
    }
    if (options?.computer && isHostedComputer(options.computer)) {
      return await this.providerClient(options.computer, options);
    }
    const clientOptions = this.clientOptions(options);
    const computer =
      options?.computer ??
      (this.configService.get('NODE_ENV') === 'production' ? 'docker' : 'unix');
    if (computer === 'docker') {
      return new DockerSandboxClient({
        image: options?.image ?? DOCKER_IMAGE,
        ...clientOptions,
      });
    }
    this.assertLocalAllowed();
    return new UnixLocalSandboxClient(clientOptions);
  }

  // A client and manifest for a workspace the SDK creates and deletes on its own.
  private async freshSandbox(
    agent: AnySandboxAgent,
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

  private db() {
    return this.prisma.db;
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

class MachineReconciliationRequired extends Error {
  constructor() {
    super('The provider outcome requires reconciliation before retrying.');
  }
}

class KnownMachineFailure extends Error {
  constructor(readonly machineId: string) {
    super('Machine creation did not finish.');
  }
}

function providerSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
