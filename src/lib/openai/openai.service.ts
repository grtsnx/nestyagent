import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
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
  connectMcpServers,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  getCurrentTrace,
  getCurrentSpan,
  getDefaultModel,
  getOrCreateTrace,
  hostedMcpTool,
  InputGuardrail,
  InputGuardrailTripwireTriggered,
  MCPServerStdio,
  MCPServerStreamableHttp,
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
  Usage,
  Tool,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  withCustomSpan,
  withTrace,
} from '@openai/agents';
import type { MCPServer, ModelRequest, RunConfig } from '@openai/agents';
import type { SandboxRunConfig } from '@openai/agents/sandbox';
import type { Prisma } from '@/generated/prisma/client.js';
import { requestStore } from '@/middleware';
import { LangfuseService } from '../langfuse/langfuse.service.js';
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
  previousResponseId?: string;
  promptCacheKey?: string;
  tracePayloads?: boolean;
  userId?: string;
  workflowName?: string;
  groupId?: string;
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
  promptCacheKey: z.string().optional(),
  tracePayloads: z.boolean().optional(),
  userId: z.string().optional(),
  workflowName: z.string().optional(),
  groupId: z.string().optional(),
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
    mcpServers?: MCPServer[];
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
  responseId?: string;
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

  //1. getItems(limit) returns exactly the newest limit items, oldest first. The SDK relies on that.
  //2. getItems() is the model's context: whole turns, newest first, within maxItems and maxBytes.
  //3. Limits are soft for the current turn. It is always sent whole, so a chat never gets stuck.
  async getItems(limit?: number) {
    if (limit !== undefined) {
      if (!Number.isSafeInteger(limit) || limit < 0)
        throw new Error('History limit must be a nonnegative integer.');
      if (limit === 0) return [];
      return (await this.newest(limit)).reverse();
    }
    const maxItems = this.limits.maxItems ?? 200;
    const maxBytes = this.limits.maxBytes ?? 256_000;
    const window = await this.newest(maxItems + 1);
    const truncated = window.length > maxItems;
    const items = window.slice(0, maxItems).reverse();
    if (truncated && !items.some(isUserMessage)) {
      // The current turn alone is longer than maxItems. Send all of it.
      return await this.currentTurn(items);
    }
    // A cut may only fall where a user message starts a turn, so tool calls keep their results.
    const starts = items.flatMap((item, index) =>
      isUserMessage(item) || (index === 0 && !truncated) ? [index] : [],
    );
    let bytes = 0;
    const suffixBytes = items
      .map((item) => Buffer.byteLength(JSON.stringify(item)))
      .reverse()
      .map((size) => (bytes += size))
      .reverse();
    const start =
      starts.find((index) => suffixBytes[index] <= maxBytes) ?? starts.at(-1);
    return start === undefined ? items : items.slice(start);
  }

  private async newest(take: number) {
    const rows = await this.prisma.db.chatItem.findMany({
      where: { chatId: this.chatId },
      orderBy: { id: 'desc' },
      take,
      select: { item: true },
    });
    return rows.map((row) => row.item as unknown as AgentInputItem);
  }

  // Every item from the newest user message on. Without any user message, the window as it is.
  private async currentTurn(window: AgentInputItem[]) {
    const start = await this.prisma.db.chatItem.findFirst({
      where: { chatId: this.chatId, item: { path: ['role'], equals: 'user' } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (!start) return window;
    const rows = await this.prisma.db.chatItem.findMany({
      where: { chatId: this.chatId, id: { gte: start.id } },
      orderBy: { id: 'asc' },
      select: { item: true },
    });
    return rows.map((row) => row.item as unknown as AgentInputItem);
  }

  // The SDK loads history before appending new input. Only that new turn may exceed
  // the budget; an oversized completed turn must not trap the next request.
  prepareInput(history: AgentInputItem[], input: AgentInputItem[]) {
    if (!input.length) return history;
    const maxItems = this.limits.maxItems ?? 200;
    const maxBytes = this.limits.maxBytes ?? 256_000;
    const starts = history.flatMap((item, index) =>
      index === 0 || isUserMessage(item) ? [index] : [],
    );
    starts.push(history.length);
    // One pass accounts for each history item and its separator before the new input.
    let bytes = Buffer.byteLength(JSON.stringify(input));
    const suffixBytes: number[] = [];
    suffixBytes[history.length] = bytes;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      bytes += Buffer.byteLength(JSON.stringify(history[index])) + 1;
      suffixBytes[index] = bytes;
    }
    for (const start of starts) {
      if (
        history.length - start + input.length <= maxItems &&
        suffixBytes[start] <= maxBytes
      )
        return [...history.slice(start), ...input];
    }
    return input;
  }

  // The SDK retries the same operation ID when a history write has an uncertain outcome.
  async applyHistoryTransaction({
    operationId,
    transaction,
  }: SessionHistoryTransactionArgs) {
    if (!operationId.trim())
      throw new Error('A history operation ID is required.');
    const digest = historyDigest(transaction);
    await this.prisma.transaction(async (tx) => {
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
    await this.prisma.transaction(async (tx) => {
      await tx.chat.upsert({
        where: { id: this.chatId },
        create: { id: this.chatId },
        update: { updatedAt: new Date() },
      });
      await tx.chatItem.createMany({
        data: items.map((item) => ({
          chatId: this.chatId,
          item: item as unknown as Prisma.InputJsonValue,
        })),
      });
    });
  }

  // Removes and returns the newest item. SKIP LOCKED lets two pops at once take different items.
  async popItem() {
    return await this.prisma.transaction(async (tx) => {
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
    await this.prisma.transaction((tx) =>
      tx.chat.deleteMany({ where: { id: this.chatId } }),
    );
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
  private readonly logger = new Logger(OpenaiService.name);
  private sharedRunner?: Runner;
  private runnerModel?: string;
  private socketRunner?: Runner;
  private apiClient?: OpenAI;
  private readonly runMetadata = new WeakMap<object, RunMetadata>();
  private readonly shutdown = new AbortController();
  private socketModelProvider?: OpenAIProvider;
  private httpModelProvider?: OpenAIProvider;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly langfuse?: LangfuseService,
  ) {}

  // Set the default OpenAI key
  onModuleInit() {
    setDefaultOpenAIKey(this.apiKey());
  }

  async onModuleDestroy() {
    this.shutdown.abort(new Error('Application is shutting down.'));
    await this.socketModelProvider?.close().catch(() => undefined);
    await this.httpModelProvider?.close().catch(() => undefined);
    this.socketModelProvider = undefined;
    this.socketRunner = undefined;
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
    this.sharedRunner = this.configuredRunner(this.runnerConfig());
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
    // Text, or a function such as SystemPromptsService.forAgent that reads the latest text.
    instructions: string | (() => string | Promise<string>),
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
      ...(options?.mcpServers && { mcpServers: options.mcpServers }),
      ...(options?.handoffDescription && {
        handoffDescription: options.handoffDescription,
      }),
      ...guardrailConfig(options),
    }) as unknown as Agent<unknown, OutputOf<TSchema>>;
  }

  // A public MCP server the model calls through OpenAI. This process does not open the connection.
  hostedMcp(options: Parameters<typeof hostedMcpTool>[0]) {
    return hostedMcpTool(options);
  }

  // A private MCP server this process starts. Call useMcp before the agent runs, and it closes the server after.
  stdioMcp(options: ConstructorParameters<typeof MCPServerStdio>[0]) {
    return new MCPServerStdio(options);
  }

  // A private MCP server this process reaches over HTTP. Call useMcp before the agent runs.
  httpMcp(options: ConstructorParameters<typeof MCPServerStreamableHttp>[0]) {
    return new MCPServerStreamableHttp(options);
  }

  //1. Connect every server, run the function with the ones that connected, then close them.
  //2. Pass the active list to createAgent as mcpServers.
  async useMcp<T>(
    servers: MCPServer[],
    run: (servers: MCPServer[]) => Promise<T>,
  ) {
    const group = await connectMcpServers(servers);
    try {
      return await run(group.active);
    } finally {
      await group.close();
    }
  }

  // Several runs share one trace. Leave this out when each customer message should be its own trace.
  async traceWorkflow<T>(
    name: string,
    run: () => Promise<T>,
    options?: {
      groupId?: string;
      userId?: string;
      metadata?: Record<string, string>;
    },
  ) {
    return await withTrace(
      name,
      async () => {
        try {
          return await run();
        } catch (error) {
          await getCurrentTrace()?.end();
          throw error;
        }
      },
      {
        ...(options?.groupId && { groupId: options.groupId }),
        metadata: {
          ...options?.metadata,
          ...(options?.userId && { user_id: options.userId }),
        },
      },
    );
  }

  // A step the Agents SDK does not already record, such as claiming an approval.
  async span<T>(
    name: string,
    run: () => Promise<T>,
    data?: Record<string, string>,
  ) {
    return await withCustomSpan(async () => run(), {
      data: { name, data: data ?? {} },
    });
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
  //11. previousResponseId is optional. OpenAI keeps the earlier turns, so send only the new message.
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

  //1. Optional. Pass this id as previousResponseId on the next message.
  //2. It is empty while a tool is paused. Finish that run before starting another message.
  nextResponseId(result: {
    lastResponseId?: string;
    interruptions?: { length: number };
  }) {
    if ((result.interruptions?.length ?? 0) > 0) return undefined;
    return result.lastResponseId || undefined;
  }

  //1. One customer message. session is optional and keeps the chat.
  //2. fallback is optional. It is who answers next when nobody took over.
  //3. waiting is true when a tool paused. output and responseId are empty until finish.
  //4. responseId is previousResponseId for the next message when OpenAI keeps the chat.
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
      responseId: this.nextResponseId(result),
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
  // previousResponseId stays on the saved state for this run.
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
    const row = await this.prisma.transaction((tx) =>
      tx.pausedRun.create({
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
              outputGuardrailBlockedMessage:
                policy.outputGuardrailBlockedMessage,
            }),
            ...(policy.promptCacheKey && {
              promptCacheKey: policy.promptCacheKey,
            }),
            ...(policy.tracePayloads !== undefined && {
              tracePayloads: policy.tracePayloads,
            }),
            ...(policy.userId && { userId: policy.userId }),
            ...(policy.workflowName && { workflowName: policy.workflowName }),
            ...(policy.groupId && { groupId: policy.groupId }),
            ...(session && { historyLimits: session.limits }),
          },
        },
      }),
    );
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

  //1. Close a saved approval nobody will answer. Every waiting tool call is rejected and the run finishes.
  //2. The model hears "no", so the chat can take its next message. A pause is resolved, never skipped.
  async cancelRun(
    agent: AnyAgent,
    id: string,
    options?: RunAccess & { message?: string },
  ) {
    const state = await this.loadRun(agent, id, options);
    this.reject(
      { state },
      {
        message: options?.message ?? 'Not approved. The request was cancelled.',
      },
    );
    return await this.resumeAgent(agent, state);
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
      await this.prisma.transaction((tx) =>
        tx.pausedRun.updateMany({
          where: { id, version: row.version },
          data: {
            status: 'waiting',
            version: { increment: 1 },
            recoveryNote: options.note,
          },
        }),
      );
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

  //1. One row per run for the admin monitoring routes: tokens, time, and result. No message text.
  //2. A failed write only logs, so monitoring can never break a customer's chat.
  private async recordRun(run: {
    agent: string;
    started: number;
    chatId?: string;
    model?: string;
    userId?: string;
    traceId?: string;
    requestId?: string;
    result?: { interruptions?: unknown[]; state?: { usage?: Usage } };
    error?: unknown;
  }) {
    if (!this.configService.get<string>('DATABASE_URL')) return;
    const { started, result, error, ...ids } = run;
    const usage = result?.state?.usage;
    try {
      await this.prisma.db.agentRun.create({
        data: {
          ...ids,
          status: error
            ? 'failed'
            : result?.interruptions?.length
              ? 'waiting'
              : 'completed',
          ...(error !== undefined && { error: describeError(error) }),
          requests: usage?.requests ?? 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cachedTokens: cachedTokens(usage),
          durationMs: Date.now() - started,
        },
      });
    } catch {
      this.logger.warn('A helper run could not be recorded for monitoring.');
    }
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
    // One cache key per chat, as the prompt caching guide advises: separate cache use per customer.
    const runner = this.runner(
      policy.websocket,
      policy.promptCacheKey ?? (await session?.getSessionId()),
      policy.tracePayloads,
    );
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
      const sessionId =
        policy.groupId ?? (session ? await session.getSessionId() : undefined);
      const requestId = requestStore.getStore()?.requestId;
      // The model this run really uses, so Langfuse can price it. The SDK default comes last.
      const model =
        (typeof agent.model === 'string' && agent.model) ||
        (typeof agent.model === 'object'
          ? undefined
          : this.runnerModel || getDefaultModel());
      const traceMetadata: Record<string, string> = {
        agent: agent.name,
        ...(requestId && { request_id: requestId }),
        ...(policy.userId && { user_id: policy.userId }),
        ...(model && { model }),
      };
      const joined = getCurrentTrace();
      const userText = userTurn(input);
      return await getOrCreateTrace(
        async () => {
          const trace = getCurrentTrace();
          const traceId = trace?.traceId;
          const note = {
            ...(userText !== undefined && { input: userText }),
            ...(sessionId && { sessionId }),
            ...(policy.userId && { userId: policy.userId }),
            ...(requestId && { requestId }),
            ...(model && { model }),
            agent: agent.name,
          };
          const run = async () => {
            if (saved) {
              await this.span('claim-approval', async () => {
                const claim = await this.prisma.transaction((tx) =>
                  tx.pausedRun.updateMany({
                    where: {
                      id: saved.id,
                      version: saved.version,
                      status: 'waiting',
                    },
                    data: {
                      status: 'running',
                      state: (input as RunState<any, AnyAgent>).toString(),
                      version: { increment: 1 },
                    },
                  }),
                );
                if (claim.count !== 1)
                  throw new ConflictException(
                    'This checkpoint is stale or already running. Reload the saved run.',
                  );
                claimedVersion = saved.version + 1;
              });
            }
            try {
              const runOptions = {
                context: policy.context,
                session,
                ...(session instanceof DatabaseSession &&
                  !(input instanceof RunState) && {
                    sessionInputCallback: (
                      history: AgentInputItem[],
                      next: AgentInputItem[],
                    ) => session.prepareInput(history, next),
                  }),
                signal,
                maxTurns: policy.maxTurns,
                outputGuardrailBlockedMessage:
                  policy.outputGuardrailBlockedMessage,
                sandbox: policy.sandbox,
                ...(joined
                  ? {}
                  : { workflowName: policy.workflowName ?? 'agent-turn' }),
                ...(sessionId && { groupId: sessionId }),
                traceMetadata,
                ...(input instanceof RunState || !policy.previousResponseId
                  ? {}
                  : { previousResponseId: policy.previousResponseId }),
              };
              const result = policy.stream
                ? await runner.run(agent, input, {
                    ...runOptions,
                    stream: true,
                  })
                : await runner.run(agent, input, runOptions);
              if (policy.stream) {
                const streamed = result as StreamedRunResult<unknown, AnyAgent>;
                // Capture the SDK promise before exposing completion that includes persistence and unlock.
                const sdkCompletion = streamed.completed;
                deliver(streamed);
                await sdkCompletion;
              }
              if (
                traceId &&
                !result.interruptions?.length &&
                result.finalOutput !== undefined
              )
                this.langfuse?.note(traceId, { output: result.finalOutput });
              signal?.throwIfAborted();
              if (result.state) {
                this.runMetadata.set(result.state, {
                  options: policy,
                  agentName: agent.name,
                });
                if (saved) {
                  const persisted = await this.prisma.transaction((tx) =>
                    tx.pausedRun.updateMany({
                      where: {
                        id: saved.id,
                        version: claimedVersion,
                        status: 'running',
                      },
                      data: {
                        state: result.state.toString(),
                        status: result.interruptions.length
                          ? 'waiting'
                          : 'completed',
                        version: { increment: 1 },
                      },
                    }),
                  );
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
                await this.prisma
                  .transaction((tx) =>
                    tx.pausedRun.updateMany({
                      where: {
                        id: saved.id,
                        version: claimedVersion,
                        status: 'running',
                      },
                      data: { status: 'recovery_required' },
                    }),
                  )
                  .catch(() => {});
                // If the database is down, the durable 'running' marker also requires reconciliation.
              }
              throw error;
            }
          };
          const started = Date.now();
          const recorded = {
            agent: agent.name,
            started,
            ...(sessionId && { chatId: sessionId }),
            ...(model && { model }),
            ...(policy.userId && { userId: policy.userId }),
            ...(traceId && { traceId }),
            ...(requestId && { requestId }),
          };
          try {
            const result = this.langfuse
              ? await this.langfuse.withRun(note, run)
              : await run();
            await this.recordRun({ ...recorded, result });
            return result;
          } catch (error) {
            await this.recordRun({ ...recorded, error });
            throw error;
          } finally {
            // SDK 0.21 does not end getOrCreateTrace on rejection. Always settle our trace,
            // while leaving a surrounding workflow's lifetime with its owner.
            const owned = new Set([!joined ? trace : undefined]);
            // SDK 0.21 restores a separate trace with RunState and does not end it
            // on rejection either. This exposed SDK field is covered by restart tests.
            if (input instanceof RunState && input._trace !== joined)
              owned.add(input._trace ?? undefined);
            for (const current of owned) await current?.end();
          }
        },
        {
          name: policy.workflowName ?? 'agent-turn',
          ...(sessionId && { groupId: sessionId }),
          metadata: traceMetadata,
        },
      );
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

  // Per-run transport policy is applied after the SDK merges the current agent's settings.
  private runner(
    websocket?: boolean,
    promptCacheKey?: string,
    tracePayloads?: boolean,
  ) {
    const includePayloads = tracePayloads ?? this.tracePayloadsDefault();
    const config = this.runnerConfig(
      websocket,
      includePayloads,
      promptCacheKey,
    );
    if (promptCacheKey || includePayloads !== this.tracePayloadsDefault())
      return this.configuredRunner(config);
    if (websocket) return (this.socketRunner ??= this.configuredRunner(config));
    return (this.sharedRunner ??= this.configuredRunner(config));
  }

  private configuredRunner(config: Partial<RunConfig>) {
    const runner = new Runner(config);
    runner.on('agent_start', (_context, agent) => {
      const span = getCurrentSpan();
      const agentSpanId =
        span?.spanData.type === 'turn' ? span.parentId : span?.spanId;
      if (!agentSpanId) return;
      // Custom Model objects bypass ModelProvider. Do not price their turns as the
      // previous specialist's model; the provider annotates concrete OpenAI calls.
      const model =
        typeof agent.model === 'object'
          ? undefined
          : agent.model ||
            (typeof config.model === 'string' ? config.model : undefined) ||
            getDefaultModel();
      this.langfuse?.noteSpan(agentSpanId, { model });
    });
    return runner;
  }

  // What every runner shares. All socket runs reuse one socket provider.
  // Payloads stay off until TRACE_PAYLOADS or a run's tracePayloads flag turns them on.
  private runnerConfig(
    websocket?: boolean,
    includePayloads?: boolean,
    promptCacheKey?: string,
  ) {
    const provider = websocket
      ? this.socketProvider()
      : (this.httpModelProvider ??= new OpenAIProvider());
    return {
      ...(this.runnerModel && { model: this.runnerModel }),
      traceIncludeSensitiveData: includePayloads ?? this.tracePayloadsDefault(),
      modelProvider: {
        getModel: async (name?: string) => {
          const model = await provider.getModel(name);
          const prepare = (request: ModelRequest): ModelRequest => {
            const spanId = getCurrentSpan()?.spanId;
            if (spanId)
              this.langfuse?.noteSpan(spanId, {
                model: name || getDefaultModel(),
              });
            return promptCacheKey
              ? {
                  ...request,
                  modelSettings: {
                    ...request.modelSettings,
                    providerData: {
                      ...request.modelSettings.providerData,
                      prompt_cache_key: promptCacheKey,
                    },
                  },
                }
              : request;
          };
          return new Proxy(model, {
            get(target, property) {
              if (property === 'getResponse')
                return (request: ModelRequest) =>
                  target.getResponse(prepare(request));
              if (property === 'getStreamedResponse')
                return (request: ModelRequest) =>
                  target.getStreamedResponse(prepare(request));
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      },
    };
  }

  private tracePayloadsDefault() {
    return this.configService.get<boolean>('TRACE_PAYLOADS') === true;
  }

  private socketProvider() {
    this.socketModelProvider ??= new OpenAIProvider({
      useResponsesWebSocket: true,
    });
    return this.socketModelProvider;
  }

  private apiKey() {
    return this.configService.getOrThrow<string>('OPENAI_API_KEY').trim();
  }
}

function isUserMessage(item: AgentInputItem) {
  return 'role' in item && item.role === 'user';
}

function userTurn(
  input: string | AgentInputItem[] | RunState<any, Agent<any, any>>,
) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item && isUserMessage(item) && typeof item.content === 'string')
      return item.content;
  }
  return undefined;
}

// Normalize object key order so JSONB round-trips preserve operation identity.
function historyDigest(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          // Code-unit order, so every server sorts the same way whatever its language settings.
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)]),
      );
    return entry;
  };
  const canonical = JSON.stringify(
    normalize(JSON.parse(JSON.stringify(value))),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

// Cached input tokens are listed per model request.
function cachedTokens(usage?: Usage) {
  return (usage?.inputTokensDetails ?? []).reduce(
    (total, details) => total + Number(details?.cached_tokens ?? 0),
    0,
  );
}

// The error type and a short message, without stack traces.
function describeError(error: unknown) {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 300);
}
