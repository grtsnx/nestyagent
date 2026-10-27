import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
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
  setDefaultOpenAIKey,
  StreamedRunResult,
  TextOutput,
  Tool,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '@openai/agents';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// Any agent, whatever its context or output type.
type AnyAgent = Agent<any, any>;

// A schema agent returns that schema's type. Without a schema the agent returns text.
type OutputOf<TSchema> = TSchema extends z.ZodObject ? TSchema : TextOutput;

export type AgentGuardrails = {
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail<AgentOutputType>[];
};

type ResumeOptions = {
  websocket?: boolean;
  signal?: AbortSignal;
  maxTurns?: number;
  outputGuardrailBlockedMessage?:
    string | OutputGuardrailBlockedMessageFormatter;
};

type RunAgentOptions<TContext> = ResumeOptions & {
  context?: TContext;
  session?: Session;
};

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
};

type ReplyOptions<TContext> = RunAgentOptions<TContext> & {
  fallback?: AnyAgent;
};

//1. A chat history kept in Postgres. It survives a restart and is shared by every copy of the app.
//2. Every write is one statement, so two messages at once cannot lose or mix up items.
export class DatabaseSession implements Session {
  constructor(
    private readonly prisma: PrismaService,
    readonly chatId: string,
  ) {}

  async getSessionId() {
    return this.chatId;
  }

  // Oldest first. With limit, only the newest items, still oldest first.
  async getItems(limit?: number) {
    const rows = await this.prisma.db.chatItem.findMany({
      where: { chatId: this.chatId },
      orderBy: { id: limit === undefined ? 'asc' : 'desc' },
      ...(limit !== undefined && { take: limit }),
      select: { item: true },
    });
    const items = rows.map((row) => row.item as unknown as AgentInputItem);
    return limit === undefined ? items : items.reverse();
  }

  async addItems(items: AgentInputItem[]) {
    if (items.length === 0) return;
    await this.prisma.db.chatItem.createMany({
      data: items.map((item) => ({
        chatId: this.chatId,
        item: item as unknown as Prisma.InputJsonValue,
      })),
    });
  }

  // Removes and returns the newest item. SKIP LOCKED lets two pops at once take different items.
  async popItem() {
    const rows = await this.prisma.db.$queryRaw<{ item: AgentInputItem }[]>`
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
  }

  async clearSession() {
    await this.prisma.db.chatItem.deleteMany({
      where: { chatId: this.chatId },
    });
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
export class OpenaiService implements OnModuleInit {
  private sharedRunner?: Runner;
  private runnerModel?: string;
  private socketRunner?: Runner;
  private apiClient?: OpenAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // Set the default OpenAI key
  onModuleInit() {
    setDefaultOpenAIKey(this.apiKey());
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
    this.sharedRunner = new Runner({ model });
    this.socketRunner = undefined;
    return this.sharedRunner;
  }

  //1. The history for one chat, kept in Postgres. Pass the same session on every later message.
  //2. Store chatId with your user. Pass it back later, even after a restart, to continue the chat.
  createSession(chatId: string = randomUUID()) {
    return new DatabaseSession(this.prisma, chatId);
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
    prompt: string,
    agent: TAgent,
    options: RunAgentOptions<TContext> & Streamed,
  ): Promise<StreamedRunResult<TContext, TAgent>>;
  runAgent<TAgent extends AnyAgent, TContext = unknown>(
    prompt: string,
    agent: TAgent,
    options?: RunAgentOptions<TContext> & NotStreamed,
  ): Promise<RunResult<TContext, TAgent>>;
  async runAgent(
    prompt: string,
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
    const result = await this.runAgent(prompt, agent, {
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.session && { session: options.session }),
      ...(options?.websocket && { websocket: options.websocket }),
      ...(options?.outputGuardrailBlockedMessage !== undefined && {
        outputGuardrailBlockedMessage: options.outputGuardrailBlockedMessage,
      }),
    });
    return this.chatTurn(agent, options?.fallback ?? agent, result);
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
    const result = await this.resumeAgent(turn.agent, state);
    return this.chatTurn(turn.agent, turn.helper, result);
  }

  private chatTurn(
    agent: AnyAgent,
    fallback: AnyAgent,
    result: RunResult<any, AnyAgent>,
  ): ChatTurn {
    const waiting = (result.interruptions?.length ?? 0) > 0;
    return {
      output: waiting ? undefined : result.finalOutput,
      helper: this.nextAgent(result, fallback),
      agent,
      waiting,
      result,
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

  //1. Optional. Store a paused run in Postgres when a person will decide later. Returns its id.
  //2. The run survives a restart. Keep the id with the request that needs the decision.
  async saveRun(result: PausedRun) {
    const row = await this.prisma.db.pausedRun.create({
      data: { state: result.state.toString() },
      select: { id: true },
    });
    return row.id;
  }

  //1. Load a paused run by the id from saveRun. Pass the same agent that started the run.
  //2. A run can be taken once. A second load throws, so a double click cannot run a tool twice.
  //3. If the state does not fit the agent, the transaction rolls back and the run stays waiting.
  async loadRun(agent: AnyAgent, id: string) {
    return await this.prisma.db.$transaction(async (tx) => {
      const taken = await tx.pausedRun.updateMany({
        where: { id, status: 'waiting' },
        data: { status: 'taken' },
      });
      if (taken.count !== 1) {
        throw new Error('This paused run was already taken or does not exist.');
      }
      const run = await tx.pausedRun.findUniqueOrThrow({
        where: { id },
        select: { state: true },
      });
      return await RunState.fromString(agent, run.state);
    });
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
    input: string | RunState<any, AnyAgent>,
    options?: RunAgentOptions<unknown> & { stream?: boolean },
  ) {
    const runOptions = {
      context: options?.context,
      session: options?.session,
      signal: options?.signal,
      maxTurns: options?.maxTurns,
      outputGuardrailBlockedMessage: options?.outputGuardrailBlockedMessage,
    };
    const runner = this.runner(options?.websocket);

    if (options?.stream) {
      return await runner.run(agent, input, { ...runOptions, stream: true });
    }
    return await runner.run(agent, input, runOptions);
  }

  // The socket runner, the shared runner from createRunner, or the SDK's plain default.
  private runner(websocket?: boolean) {
    if (websocket) return this.webSocketRunner();
    this.sharedRunner ??= new Runner();
    return this.sharedRunner;
  }

  // Built once and reused, so later runs share the same socket provider.
  private webSocketRunner() {
    this.socketRunner ??= new Runner({
      ...(this.runnerModel && { model: this.runnerModel }),
      modelProvider: new OpenAIProvider({ useResponsesWebSocket: true }),
    });
    return this.socketRunner;
  }

  private apiKey() {
    return this.configService.getOrThrow<string>('OPENAI_API_KEY').trim();
  }
}
