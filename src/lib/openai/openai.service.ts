import {
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  Agent,
  AgentInputItem,
  AgentOutputType,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  InputGuardrail,
  InputGuardrailTripwireTriggered,
  ModelSettings,
  OpenAIProvider,
  OutputGuardrail,
  OutputGuardrailBlockedMessageFormatter,
  OutputGuardrailTripwireTriggered,
  Runner,
  RunResult,
  RunState,
  RunToolApprovalItem,
  Session,
  SessionHistoryTransactionArgs,
  setDefaultOpenAIKey,
  StreamedRunResult,
  TextOutput,
  Tool,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '@openai/agents';
import type { SandboxRunConfig } from '@openai/agents/sandbox';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const RUN_GONE = 'This paused run was already taken or does not exist.';

// Any agent, whatever its context or output type.
type AnyAgent = Agent<any, any>;

// A schema agent returns that schema's type. Without a schema the agent returns text.
type OutputOf<TSchema> = TSchema extends z.ZodObject ? TSchema : TextOutput;

export type AgentGuardrails = {
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail<AgentOutputType>[];
};

type ResumeOptions = {
  session?: Session;
  sandbox?: SandboxRunConfig;
  ownerId?: string;
  agentVersion?: string;
  websocket?: boolean;
  signal?: AbortSignal;
  maxTurns?: number;
  outputGuardrailBlockedMessage?:
    string | OutputGuardrailBlockedMessageFormatter;
};

export type RunAgentOptions<TContext = unknown> = ResumeOptions & {
  context?: TContext;
  session?: Session;
};

type SavedRunIdentity = { id: string; version: number };
type RunMetadata = {
  options: RunAgentOptions;
  agentName?: string;
  saved?: SavedRunIdentity;
};
type RunAccess = { ownerId?: string; agentVersion?: string };
const storedOptionsSchema = z.object({
  websocket: z.boolean().optional(),
  maxTurns: z.number().int().positive().optional(),
  outputGuardrailBlockedMessage: z.string().optional(),
  historyLimits: z
    .object({
      maxItems: z.number().int().positive().optional(),
      maxBytes: z.number().int().positive().optional(),
    })
    .optional(),
});

type Streamed = { stream: true };
type NotStreamed = { stream?: false };

type AsToolOptions = Pick<
  NonNullable<Parameters<Agent['asTool']>[0]>,
  'toolName' | 'toolDescription' | 'needsApproval' | 'runConfig'
>;

type CreateAgentOptions<TSchema extends z.ZodObject | undefined = undefined> =
  AgentGuardrails & {
    model?: string;
    tools?: Tool[];
    schema?: TSchema;
    handoffDescription?: string;
    modelSettings?: ModelSettings;
    temperature?: number;
  };

type PausedRun = {
  state: RunState<any, AnyAgent>;
  interruptions?: RunToolApprovalItem[];
};

type ApprovalChoice = {
  interruptions?: RunToolApprovalItem[];
  alwaysApprove?: boolean;
};

type RejectionChoice = {
  interruptions?: RunToolApprovalItem[];
  alwaysReject?: boolean;
  message?: string;
};

type ChatTurn = {
  output: unknown;
  helper: AnyAgent;
  agent: AnyAgent;
  waiting: boolean;
  result: RunResult<any, AnyAgent>;
  options?: RunAgentOptions;
};

type ReplyOptions<TContext> = RunAgentOptions<TContext> & {
  fallback?: AnyAgent;
};

export type HistoryLimits = { maxItems?: number; maxBytes?: number };

// Persistent history. OpenaiService coordinates full turns across workers.
export class DatabaseSession implements Session {
  constructor(
    private readonly prisma: PrismaService,
    readonly chatId: string,
    readonly limits: HistoryLimits = {},
  ) {}

  async getSessionId() {
    return this.chatId;
  }

  // Oldest first. With limit, only the newest items, still oldest first.
  async getItems(limit?: number) {
    const maxItems = this.limits.maxItems ?? 200;
    const count = limit ?? maxItems;
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('History limit must be a nonnegative integer.');
    if (count === 0) return [];
    const rows = await this.prisma.db.chatItem.findMany({
      where: { chatId: this.chatId },
      orderBy: { id: 'desc' },
      take: count + 1,
      select: { item: true },
    });
    const truncated = rows.length > count;
    let items = rows
      .slice(0, count)
      .reverse()
      .map((row) => row.item as unknown as AgentInputItem);
    if (truncated && limit === undefined) {
      const start = items.findIndex(
        (item) => 'role' in item && item.role === 'user',
      );
      if (start < 0)
        throw new Error(
          'The current turn exceeds the history limit. Compact it or increase maxItems.',
        );
      items = items.slice(start);
    }
    if (
      Buffer.byteLength(JSON.stringify(items)) >
      (this.limits.maxBytes ?? 256_000)
    ) {
      throw new Error(
        'Chat history exceeds maxBytes. Compact it before continuing.',
      );
    }
    return items;
  }

  // The SDK retries the same operation ID when a history write has an uncertain outcome.
  async applyHistoryTransaction({
    operationId,
    transaction,
  }: SessionHistoryTransactionArgs) {
    if (!operationId.trim())
      throw new Error('A history operation ID is required.');
    const digest = historyDigest(transaction);
    await this.prisma.db.$transaction(async (tx) => {
      // Updating the parent locks this chat until the short database transaction commits.
      await tx.chat.upsert({
        where: { id: this.chatId },
        create: { id: this.chatId },
        update: { updatedAt: new Date() },
      });
      const previous = await tx.chatHistoryOperation.findUnique({
        where: { chatId_operationId: { chatId: this.chatId, operationId } },
      });
      if (previous) {
        if (previous.digest !== digest)
          throw new ConflictException(
            'History operation ID was reused with different data.',
          );
        return;
      }
      let items: AgentInputItem[];
      if (transaction.type === 'append_items') {
        items = transaction.items;
      } else {
        const suffix = transaction.expectedSuffix.length
          ? await tx.chatItem.findMany({
              where: { chatId: this.chatId },
              orderBy: { id: 'desc' },
              take: transaction.expectedSuffix.length,
            })
          : [];
        if (
          historyDigest(
            suffix
              .slice()
              .reverse()
              .map((row) => row.item),
          ) !== historyDigest(transaction.expectedSuffix)
        ) {
          throw new ConflictException(
            'Chat history changed before its suffix could be replaced.',
          );
        }
        await tx.chatItem.deleteMany({
          where: {
            chatId: this.chatId,
            id: { in: suffix.map((row) => row.id) },
          },
        });
        items = transaction.replacement;
      }
      if (items.length)
        await tx.chatItem.createMany({
          data: items.map((item) => ({
            chatId: this.chatId,
            item: item as unknown as Prisma.InputJsonValue,
          })),
        });
      await tx.chatHistoryOperation.create({
        data: { chatId: this.chatId, operationId, digest },
      });
    });
  }

  // One transaction: the chat row is made or touched, and every item is added, or none are.
  async addItems(items: AgentInputItem[]) {
    if (items.length === 0) return;
    const db = this.prisma.db;
    await db.$transaction([
      db.chat.upsert({
        where: { id: this.chatId },
        create: { id: this.chatId },
        update: { updatedAt: new Date() },
      }),
      db.chatItem.createMany({
        data: items.map((item) => ({
          chatId: this.chatId,
          item: item as unknown as Prisma.InputJsonValue,
        })),
      }),
    ]);
  }

  // Removes and returns the newest item. SKIP LOCKED lets two pops at once take different items.
  async popItem() {
    return await this.prisma.db.$transaction(async (tx) => {
      await tx.chat.updateMany({
        where: { id: this.chatId },
        data: { updatedAt: new Date() },
      });
      const rows = await tx.$queryRaw<{ item: AgentInputItem }[]>`
      DELETE FROM chat_items
      WHERE id = (
        SELECT id FROM chat_items
        WHERE chat_id = ${this.chatId}
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING item`;
      return rows[0]?.item;
    });
  }

  // Deleting the chat row deletes its items too.
  async clearSession() {
    await this.prisma.db.chat.deleteMany({ where: { id: this.chatId } });
  }
}

// The guardrail fields for any agent constructor. A list left out becomes the SDK default of none.
export function guardrailConfig(options?: AgentGuardrails): AgentGuardrails {
  return {
    inputGuardrails: options?.inputGuardrails,
    outputGuardrails: options?.outputGuardrails,
  };
}

@Injectable()
export class OpenaiService implements OnModuleInit, OnModuleDestroy {
  private sharedRunner?: Runner;
  private runnerModel?: string;
  private socketRunner?: Runner;
  private apiClient?: OpenAI;
  private readonly runMetadata = new WeakMap<object, RunMetadata>();
  private readonly shutdown = new AbortController();
  private readonly socketProviders = new Set<OpenAIProvider>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // Set the default OpenAI key
  onModuleInit() {
    setDefaultOpenAIKey(this.apiKey());
  }

  async onModuleDestroy() {
    this.shutdown.abort(new Error('Application is shutting down.'));
    await Promise.allSettled(
      [...this.socketProviders].map((provider) => provider.close()),
    );
    this.socketProviders.clear();
  }

  // One OpenAI client for the hosted session API. It uses the same key as the agents.
  client() {
    this.apiClient ??= new OpenAI({ apiKey: this.apiKey() });
    return this.apiClient;
  }

  //1. Optional shared fallback. Agents that set their own model keep that model.
  //2. It applies to every later run in this app, so call it once at startup.
  createRunner(model: string) {
    this.runnerModel = model;
    this.sharedRunner = new Runner({ model, traceIncludeSensitiveData: false });
    this.socketRunner = undefined;
    return this.sharedRunner;
  }

  //1. The history for one chat, kept in Postgres. Pass the same session on every later message.
  //2. Store chatId with your user. Pass it back later, even after a restart, to continue the chat.
  createSession(chatId: string = randomUUID(), limits?: HistoryLimits) {
    return new DatabaseSession(this.prisma, chatId, limits);
  }

  // Create a new agent. Leave model out to use the runner model.
  // modelSettings is optional. Leave it out to use the model's own reasoning effort.
  // temperature is optional. Leave it out unless the model accepts it.
  // inputGuardrails and outputGuardrails are optional. Leave them out when nothing needs a check.
  // The agent's output type is the schema when one is passed, and text otherwise.
  createAgent<TSchema extends z.ZodObject | undefined = undefined>(
    name: string,
    instructions: string,
    options?: CreateAgentOptions<TSchema>,
  ) {
    return new Agent({
      name,
      instructions,
      modelSettings: this.modelSettings(
        options?.modelSettings,
        options?.temperature,
      ),
      ...(options?.model && { model: options.model }),
      ...(options?.schema && { outputType: options.schema }),
      ...(options?.tools && { tools: options.tools }),
      ...(options?.handoffDescription && {
        handoffDescription: options.handoffDescription,
      }),
      ...guardrailConfig(options),
    }) as unknown as Agent<unknown, OutputOf<TSchema>>;
  }

  //1. Optional check before the agent starts. It runs only when this agent is first.
  //2. The agent waits for the check, so no tool runs before a blocked request stops.
  //3. Pass runInParallel: true to run both at once. It is faster, but a tool may run before the check stops it.
  inputGuardrail(
    name: string,
    execute: InputGuardrail['execute'],
    options?: { runInParallel?: boolean },
  ): InputGuardrail {
    return {
      name,
      execute,
      runInParallel: options?.runInParallel ?? false,
    };
  }

  //1. Optional. The check is another agent. tripwire reads that agent's typed output.
  //2. Return true from tripwire when the request should stop.
  //3. runInParallel is optional and follows the same choice as inputGuardrail.
  agentInputGuardrail<TAgent extends AnyAgent>(
    name: string,
    agent: TAgent,
    tripwire: (output: RunResult<unknown, TAgent>['finalOutput']) => boolean,
    options?: { runInParallel?: boolean },
  ) {
    return this.inputGuardrail(
      name,
      async ({ input, context }) => {
        const result = await this.runner().run(agent, input, { context });
        return {
          outputInfo: result.finalOutput,
          tripwireTriggered: tripwire(result.finalOutput),
        };
      },
      options,
    );
  }

  // Optional. Returns which check blocked, or undefined when the error is something else.
  guardrailTripwire(error: unknown) {
    if (error instanceof InputGuardrailTripwireTriggered)
      return 'input' as const;
    if (error instanceof OutputGuardrailTripwireTriggered)
      return 'output' as const;
    if (error instanceof ToolInputGuardrailTripwireTriggered)
      return 'tool-input' as const;
    if (error instanceof ToolOutputGuardrailTripwireTriggered)
      return 'tool-output' as const;
    return undefined;
  }

  // Optional tool-check results. Pass one back from a tool guardrail.
  allowTool(outputInfo?: unknown) {
    return ToolGuardrailFunctionOutputFactory.allow(outputInfo);
  }

  rejectTool(message: string, outputInfo?: unknown) {
    return ToolGuardrailFunctionOutputFactory.rejectContent(
      message,
      outputInfo,
    );
  }

  stopTool(outputInfo?: unknown) {
    return ToolGuardrailFunctionOutputFactory.throwException(outputInfo);
  }

  // Optional check on the reply of the agent that produces the final output.
  outputGuardrail(
    name: string,
    execute: OutputGuardrail<AgentOutputType>['execute'],
  ): OutputGuardrail<AgentOutputType> {
    return { name, execute };
  }

  // Optional check on a tool's arguments. Pass it to tool() as inputGuardrails.
  toolInputGuardrail(
    name: string,
    run: Parameters<typeof defineToolInputGuardrail>[0]['run'],
  ) {
    return defineToolInputGuardrail({ name, run });
  }

  // Optional check on a tool's result. Pass it to tool() as outputGuardrails.
  toolOutputGuardrail(
    name: string,
    run: Parameters<typeof defineToolOutputGuardrail>[0]['run'],
  ) {
    return defineToolOutputGuardrail({ name, run });
  }

  //1. Create a triage agent that routes work to specialist agents.
  //2. handoffDescription is required so another agent knows when to hand off to it.
  //3. handoffs takes agents, or handoff(agent, options) when one handoff needs its own settings.
  createTriageAgent(
    name: string,
    instructions: string,
    handoffs: Agent['handoffs'],
    handoffDescription: string,
    options?: AgentGuardrails &
      Pick<CreateAgentOptions, 'model' | 'modelSettings' | 'temperature'>,
  ) {
    // Explicit types keep the guardrail list from changing the triage agent's text output.
    return Agent.create<TextOutput, Agent['handoffs']>({
      name,
      instructions,
      handoffs,
      handoffDescription,
      modelSettings: this.modelSettings(
        options?.modelSettings,
        options?.temperature,
      ),
      ...(options?.model && { model: options.model }),
      ...guardrailConfig(options),
    });
  }

  //1. Turn an agent into a tool. The manager keeps the reply and calls this agent for one job.
  //2. toolName, toolDescription, needsApproval, and runConfig are optional.
  //3. The agent name is used when toolName is left out. needsApproval pauses before the tool runs.
  //4. runConfig is how SandboxService passes the workspace.
  asTool(agent: AnyAgent, options?: AsToolOptions) {
    return agent.asTool({ ...options });
  }

  //1. Only the settings the caller passes are sent, so a model without reasoning still works.
  //2. temperature is included only when the caller passes a number, including 0.
  private modelSettings(
    settings?: ModelSettings,
    temperature?: number,
  ): ModelSettings {
    return {
      ...settings,
      ...(temperature !== undefined && { temperature }),
    };
  }

  //1. Run a prompt on an agent. For triage, pass the agent from createTriageAgent.
  //2. That agent reads the prompt and hands it to one specialist in its handoffs.
  //3. context is optional data for your code. The model does not see it.
  //4. session is optional. Reuse one session to continue a chat.
  //5. websocket is optional. Turn it on when this run will call the model many times.
  //6. stream is optional. stream: true returns a streamed result. Wait for completed, then approve or reject.
  //7. outputGuardrailBlockedMessage is optional. It replaces a blocked tool result.
  //8. signal is optional. Abort it to stop the run, for example when the caller disconnects.
  //9. maxTurns is optional. It stops a run that loops longer than that many model turns.
  //10. When a tool pauses, the result carries interruptions. approve or reject, then resumeAgent.
  runAgent<TAgent extends AnyAgent, TContext = unknown>(
    prompt: string | AgentInputItem[],
    agent: TAgent,
    options: RunAgentOptions<TContext> & Streamed,
  ): Promise<StreamedRunResult<TContext, TAgent>>;
  runAgent<TAgent extends AnyAgent, TContext = unknown>(
    prompt: string | AgentInputItem[],
    agent: TAgent,
    options?: RunAgentOptions<TContext> & NotStreamed,
  ): Promise<RunResult<TContext, TAgent>>;
  async runAgent(
    prompt: string | AgentInputItem[],
    agent: AnyAgent,
    options?: RunAgentOptions<unknown> & { stream?: boolean },
  ) {
    return await this.executeRun(agent, prompt, options);
  }

  //1. Optional. Call this after a handoff when the same specialist should answer the next message.
  //2. fallback is required here. It is used when the run has no last agent.
  nextAgent(result: { lastAgent?: AnyAgent }, fallback: AnyAgent) {
    return result.lastAgent ?? fallback;
  }

  //1. One customer message. session is optional and keeps the chat.
  //2. fallback is optional. It is who answers next when nobody took over.
  //3. waiting is true when a tool paused. output is empty until finish.
  async reply<TContext>(
    prompt: string,
    agent: AnyAgent,
    options?: ReplyOptions<TContext>,
  ): Promise<ChatTurn> {
    const { fallback, ...runOptions } = options ?? {};
    const result = await this.runAgent(prompt, agent, runOptions);
    return this.chatTurn(agent, fallback ?? agent, result, runOptions);
  }

  //1. Finish a paused reply. Pass approve or reject.
  //2. message is optional and is only sent when the decision is reject.
  async finish(
    turn: ChatTurn,
    decision: 'approve' | 'reject',
    options?: { message?: string },
  ): Promise<ChatTurn> {
    const state =
      decision === 'reject'
        ? this.reject(turn.result, {
            ...(options?.message !== undefined && {
              message: options.message,
            }),
          })
        : this.approve(turn.result);
    const result = await this.resumeAgent(turn.agent, state, turn.options);
    return this.chatTurn(turn.agent, turn.helper, result, turn.options);
  }

  private chatTurn(
    agent: AnyAgent,
    fallback: AnyAgent,
    result: RunResult<any, AnyAgent>,
    options?: RunAgentOptions,
  ): ChatTurn {
    const waiting = (result.interruptions?.length ?? 0) > 0;
    return {
      output: waiting ? undefined : result.finalOutput,
      helper: this.nextAgent(result, fallback),
      agent,
      waiting,
      result,
      options,
    };
  }

  //1. Optional. Approve a paused tool call, then pass the returned state to resumeAgent.
  //2. Leave interruptions out to approve every pause on the result.
  //3. alwaysApprove is optional. It allows that tool for the rest of this run.
  approve(result: PausedRun, options?: ApprovalChoice) {
    return this.decide(result, options?.interruptions, (item) =>
      result.state.approve(item, { alwaysApprove: options?.alwaysApprove }),
    );
  }

  //1. Optional. Reject a paused tool call, then pass the returned state to resumeAgent.
  //2. Leave interruptions out to reject every pause on the result.
  //3. message and alwaysReject are optional.
  reject(result: PausedRun, options?: RejectionChoice) {
    return this.decide(result, options?.interruptions, (item) =>
      result.state.reject(item, {
        alwaysReject: options?.alwaysReject,
        message: options?.message,
      }),
    );
  }

  // Continue a paused run from the state approve or reject returned.
  // websocket, stream, signal, maxTurns, and outputGuardrailBlockedMessage are optional.
  resumeAgent<TAgent extends AnyAgent>(
    agent: TAgent,
    state: PausedRun['state'],
    options: ResumeOptions & Streamed,
  ): Promise<StreamedRunResult<unknown, TAgent>>;
  resumeAgent<TAgent extends AnyAgent>(
    agent: TAgent,
    state: PausedRun['state'],
    options?: ResumeOptions & NotStreamed,
  ): Promise<RunResult<unknown, TAgent>>;
  async resumeAgent(
    agent: AnyAgent,
    state: PausedRun['state'],
    options?: ResumeOptions & { stream?: boolean },
  ) {
    return await this.executeRun(agent, state, options);
  }

  // Persist the checkpoint and portable run policy. Secrets in SDK context are the caller's responsibility.
  async saveRun(result: PausedRun, options?: RunAgentOptions) {
    const metadata = this.runMetadata.get(result.state);
    if (metadata?.saved) return metadata.saved.id;
    const policy = { ...metadata?.options, ...options };
    const session = policy.session;
    if (session && !(session instanceof DatabaseSession)) {
      throw new Error(
        'Saved runs require DatabaseSession so the session can be restored after a restart.',
      );
    }
    const row = await this.prisma.db.pausedRun.create({
      data: {
        state: result.state.toString(),
        chatId: session?.chatId,
        agentName: metadata?.agentName,
        agentVersion: policy.agentVersion,
        ownerId: policy.ownerId,
        runOptions: {
          ...(policy.websocket !== undefined && {
            websocket: policy.websocket,
          }),
          ...(policy.maxTurns !== undefined && { maxTurns: policy.maxTurns }),
          ...(typeof policy.outputGuardrailBlockedMessage === 'string' && {
            outputGuardrailBlockedMessage: policy.outputGuardrailBlockedMessage,
          }),
          ...(session && { historyLimits: session.limits }),
        },
      },
    });
    this.runMetadata.set(result.state, {
      options: policy,
      agentName: metadata?.agentName,
      saved: { id: row.id, version: row.version },
    });
    return row.id;
  }

  // Reading never consumes a checkpoint. Execution claims its version under a database lock.
  async loadRun(agent: AnyAgent, id: string, access: RunAccess = {}) {
    const row = await this.readRun(agent, id, access);
    if (row.status !== 'waiting') {
      if (row.status === 'completed') throw new Error(RUN_GONE);
      throw new ConflictException(
        'This run needs reconciliation before retry. Inspect external effects and call recoverRun.',
      );
    }
    const state = await RunState.fromString(agent, row.state);
    const { historyLimits, ...policy } = storedOptionsSchema.parse(
      row.runOptions ?? {},
    );
    this.runMetadata.set(state, {
      agentName: agent.name,
      saved: { id, version: row.version },
      options: {
        ...policy,
        ...access,
        ...(row.chatId && {
          session: this.createSession(row.chatId, historyLimits),
        }),
      },
    });
    return state;
  }

  // An interrupted external action may have succeeded. Only the application can reconcile it.
  async recoverRun(
    agent: AnyAgent,
    id: string,
    options: RunAccess & { note: string },
  ) {
    if (!options.note.trim())
      throw new Error('A reconciliation note is required before retrying.');
    return await this.prisma.withLock(`run:${id}`, async () => {
      const row = await this.readRun(agent, id, options);
      if (!['running', 'recovery_required', 'taken'].includes(row.status)) {
        throw new ConflictException(
          'Only an interrupted run can be recovered.',
        );
      }
      await this.prisma.db.pausedRun.updateMany({
        where: { id, version: row.version },
        data: {
          status: 'waiting',
          version: { increment: 1 },
          recoveryNote: options.note,
        },
      });
      return await this.loadRun(agent, id, options);
    });
  }

  private async readRun(agent: AnyAgent, id: string, access: RunAccess) {
    if (!z.uuid().safeParse(id).success) throw new Error(RUN_GONE);
    const row = await this.prisma.db.pausedRun.findUnique({ where: { id } });
    if (!row || (row.ownerId && row.ownerId !== access.ownerId))
      throw new Error(RUN_GONE);
    if (
      (row.agentName && row.agentName !== agent.name) ||
      (row.agentVersion && row.agentVersion !== access.agentVersion)
    ) {
      throw new ConflictException(
        'The saved agent or configuration version does not match.',
      );
    }
    return row;
  }

  //1. Approve or reject each chosen pause, then hand back the state to resume.
  //2. Without a choice, every pause on the result is decided.
  private decide(
    result: PausedRun,
    chosen: RunToolApprovalItem[] | undefined,
    apply: (item: RunToolApprovalItem) => void,
  ) {
    const items =
      chosen ?? result.interruptions ?? result.state.getInterruptions();
    for (const item of items) apply(item);
    return result.state;
  }

  private async executeRun(
    agent: AnyAgent,
    input: string | AgentInputItem[] | RunState<any, AnyAgent>,
    options?: RunAgentOptions<unknown> & { stream?: boolean },
  ) {
    const metadata =
      typeof input === 'object' ? this.runMetadata.get(input) : undefined;
    const policy = {
      ...metadata?.options,
      ...options,
      stream: options?.stream ?? false,
    };
    const saved = metadata?.saved;
    const session = policy.session;
    if (
      saved &&
      metadata?.options.session &&
      session !== metadata.options.session
    ) {
      if (
        (await session?.getSessionId()) !==
        (await metadata.options.session.getSessionId())
      ) {
        throw new ConflictException(
          'A saved run must resume in its original chat.',
        );
      }
    }
    const runner = this.runner(policy.websocket);
    let deliver!: (result: StreamedRunResult<unknown, AnyAgent>) => void;
    let rejectDelivery!: (error: unknown) => void;
    const ready = policy.stream
      ? new Promise<StreamedRunResult<unknown, AnyAgent>>((resolve, reject) => {
          deliver = resolve;
          rejectDelivery = reject;
        })
      : undefined;
    let claimedVersion: number | undefined;

    const execute = async (lockSignal?: AbortSignal) => {
      const signal = AbortSignal.any([
        this.shutdown.signal,
        ...(policy.signal ? [policy.signal] : []),
        ...(lockSignal ? [lockSignal] : []),
      ]);
      signal?.throwIfAborted();
      if (!saved && session instanceof DatabaseSession) {
        const pending = await this.prisma.db.pausedRun.findMany({
          where: {
            chatId: session.chatId,
            status: {
              in: ['waiting', 'running', 'recovery_required', 'taken'],
            },
          },
          take: 1,
        });
        if (pending.length)
          throw new ConflictException(
            'This chat has a pending approval or interrupted run. Resume or reconcile it first.',
          );
      }
      if (saved) {
        const claim = await this.prisma.db.pausedRun.updateMany({
          where: { id: saved.id, version: saved.version, status: 'waiting' },
          data: {
            status: 'running',
            state: (input as RunState<any, AnyAgent>).toString(),
            version: { increment: 1 },
          },
        });
        if (claim.count !== 1)
          throw new ConflictException(
            'This checkpoint is stale or already running. Reload the saved run.',
          );
        claimedVersion = saved.version + 1;
      }
      try {
        const runOptions = {
          context: policy.context,
          session,
          signal,
          maxTurns: policy.maxTurns,
          outputGuardrailBlockedMessage: policy.outputGuardrailBlockedMessage,
          sandbox: policy.sandbox,
        };
        const result = policy.stream
          ? await runner.run(agent, input, { ...runOptions, stream: true })
          : await runner.run(agent, input, runOptions);
        if (policy.stream) {
          const streamed = result as StreamedRunResult<unknown, AnyAgent>;
          // Capture the SDK promise before exposing completion that includes persistence and unlock.
          const sdkCompletion = streamed.completed;
          deliver(streamed);
          await sdkCompletion;
        }
        signal?.throwIfAborted();
        if (result.state) {
          this.runMetadata.set(result.state, {
            options: policy,
            agentName: agent.name,
          });
          if (saved) {
            const persisted = await this.prisma.db.pausedRun.updateMany({
              where: {
                id: saved.id,
                version: claimedVersion,
                status: 'running',
              },
              data: {
                state: result.state.toString(),
                status: result.interruptions.length ? 'waiting' : 'completed',
                version: { increment: 1 },
              },
            });
            if (persisted.count !== 1)
              throw new ConflictException(
                'The run checkpoint changed before completion.',
              );
            this.runMetadata.set(result.state, {
              options: policy,
              agentName: agent.name,
              saved: { id: saved.id, version: claimedVersion! + 1 },
            });
          } else if (
            session instanceof DatabaseSession &&
            result.interruptions.length
          ) {
            await this.saveRun(result, policy);
          }
        }
        return result;
      } catch (error) {
        if (saved && claimedVersion !== undefined) {
          // Keep the last known checkpoint; never replay an uncertain side effect automatically.
          await this.prisma.db.pausedRun
            .updateMany({
              where: {
                id: saved.id,
                version: claimedVersion,
                status: 'running',
              },
              data: { status: 'recovery_required' },
            })
            .catch(() => {});
          // If the database is down, the durable 'running' marker also requires reconciliation.
        }
        throw error;
      }
    };
    const locks = [
      ...(saved ? [`run:${saved.id}`] : []),
      ...(session instanceof DatabaseSession ? [`chat:${session.chatId}`] : []),
    ];
    const lifecycle = locks.length
      ? this.prisma.withLock(locks, execute)
      : execute();
    if (!ready) return await lifecycle;
    const completion = lifecycle.then(() => {});
    completion.catch(rejectDelivery);
    const streamed = await ready;
    Object.defineProperty(streamed, 'completed', {
      value: completion,
      configurable: true,
    });
    return streamed;
  }

  // The socket runner, the shared runner from createRunner, or the SDK's plain default.
  private runner(websocket?: boolean) {
    if (websocket) return this.webSocketRunner();
    this.sharedRunner ??= new Runner({ traceIncludeSensitiveData: false });
    return this.sharedRunner;
  }

  // Built once and reused, so later runs share the same socket provider.
  private webSocketRunner() {
    if (this.socketRunner) return this.socketRunner;
    const provider = new OpenAIProvider({ useResponsesWebSocket: true });
    this.socketProviders.add(provider);
    this.socketRunner = new Runner({
      ...(this.runnerModel && { model: this.runnerModel }),
      traceIncludeSensitiveData: false,
      modelProvider: provider,
    });
    return this.socketRunner;
  }

  private apiKey() {
    return this.configService.getOrThrow<string>('OPENAI_API_KEY').trim();
  }
}

// Normalize object key order so JSONB round-trips preserve operation identity.
function historyDigest(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      );
    return entry;
  };
  const canonical = JSON.stringify(
    normalize(JSON.parse(JSON.stringify(value))),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
