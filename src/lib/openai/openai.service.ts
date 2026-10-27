import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  Agent,
  AgentOutputType,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  InputGuardrail,
  InputGuardrailTripwireTriggered,
  MemorySession,
  ModelSettings,
  OpenAIProvider,
  OutputGuardrail,
  OutputGuardrailTripwireTriggered,
  run,
  Runner,
  RunState,
  RunToolApprovalItem,
  Session,
  setDefaultOpenAIKey,
  Tool,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '@openai/agents';

type BlockedToolMessage =
  | string
  | ((args: {
      defaultMessage: string;
      guardrailName: string;
    }) => Promise<string | undefined> | string | undefined);

type RunAgentOptions<TContext> = {
  context?: TContext;
  session?: Session;
  websocket?: boolean;
  stream?: boolean;
  outputGuardrailBlockedMessage?: BlockedToolMessage;
};

type AsToolOptions = Pick<
  NonNullable<Parameters<Agent['asTool']>[0]>,
  'toolName' | 'toolDescription' | 'needsApproval' | 'runConfig'
>;

type CreateAgentOptions = {
  model?: string;
  tools?: Tool[];
  schema?: z.ZodObject;
  handoffDescription?: string;
  modelSettings?: ModelSettings;
  temperature?: number;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail<AgentOutputType>[];
};

type PausedRun = {
  state: RunState<unknown, Agent>;
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

@Injectable()
export class OpenaiService implements OnModuleInit {
  private runner?: Runner;
  private runnerModel?: string;
  private socketRunner?: Runner;
  private apiClient?: OpenAI;

  constructor(private readonly configService: ConfigService) {}

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
    this.runner = new Runner({ model });
    this.socketRunner = undefined;
    return this.runner;
  }

  // A notebook for one chat. Pass the same session on every later message.
  createSession() {
    return new MemorySession();
  }

  // Create a new agent. Leave model out to use the runner model.
  // modelSettings is optional. Leave it out to use the model's own reasoning effort.
  // temperature is optional. Leave it out unless the model accepts it.
  // inputGuardrails and outputGuardrails are optional. Leave them out when nothing needs a check.
  createAgent(
    name: string,
    instructions: string,
    options?: CreateAgentOptions,
  ) {
    const agent = new Agent({
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
      ...(options?.inputGuardrails && {
        inputGuardrails: options.inputGuardrails,
      }),
    });
    if (options?.outputGuardrails) {
      agent.outputGuardrails = options.outputGuardrails;
    }
    return agent;
  }

  //1. Optional check before the agent starts. It runs only when this agent is first.
  //2. runInParallel is optional. Leave it out to run the check alongside the agent.
  //3. Pass false when the agent must wait until the check finishes.
  inputGuardrail(
    name: string,
    execute: InputGuardrail['execute'],
    options?: { runInParallel?: boolean },
  ): InputGuardrail {
    return {
      name,
      execute,
      ...(options?.runInParallel !== undefined && {
        runInParallel: options.runInParallel,
      }),
    };
  }

  //1. Optional. The check is another agent. tripwire reads that agent's output.
  //2. Return true from tripwire when the request should stop.
  //3. runInParallel is optional and follows the same choice as inputGuardrail.
  agentInputGuardrail(
    name: string,
    agent: Agent,
    tripwire: (output: unknown) => boolean,
    options?: { runInParallel?: boolean },
  ) {
    return this.inputGuardrail(
      name,
      async ({ input, context }) => {
        const result = await this.executeRun(agent, input, { context });
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
    options?: Pick<
      CreateAgentOptions,
      | 'model'
      | 'modelSettings'
      | 'temperature'
      | 'inputGuardrails'
      | 'outputGuardrails'
    >,
  ) {
    const agent = Agent.create({
      name,
      instructions,
      handoffs,
      handoffDescription,
      modelSettings: this.modelSettings(
        options?.modelSettings,
        options?.temperature,
      ),
      ...(options?.model && { model: options.model }),
      ...(options?.inputGuardrails && {
        inputGuardrails: options.inputGuardrails,
      }),
    });
    if (options?.outputGuardrails) {
      agent.outputGuardrails = options.outputGuardrails;
    }
    return agent;
  }

  //1. Turn an agent into a tool. The manager keeps the reply and calls this agent for one job.
  //2. toolName, toolDescription, needsApproval, and runConfig are optional.
  //3. The agent name is used when toolName is left out. needsApproval pauses before the tool runs.
  //4. runConfig is how SandboxService passes the workspace.
  asTool(agent: Agent, options?: AsToolOptions) {
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
  //6. stream is optional. Wait for completed, then approve or reject the same state.
  //7. outputGuardrailBlockedMessage is optional. It replaces a blocked tool result.
  //8. When a tool pauses, the result carries interruptions. approve or reject, then resumeAgent.
  async runAgent<TContext>(
    prompt: string,
    agent: Agent,
    options?: RunAgentOptions<TContext>,
  ) {
    return await this.executeRun(agent, prompt, options);
  }

  //1. Optional. Call this after a handoff when the same specialist should answer the next message.
  //2. fallback is required here. It is used when the run has no last agent.
  nextAgent(result: { lastAgent?: Agent }, fallback: Agent) {
    return result.lastAgent ?? fallback;
  }

  //1. Optional. Approve a paused tool call, then pass the returned state to resumeAgent.
  //2. Leave interruptions out to approve every pause on the result.
  //3. alwaysApprove is optional. It allows that tool for the rest of this run.
  approve(result: PausedRun, options?: ApprovalChoice) {
    for (const interruption of this.approvalItems(
      result,
      options?.interruptions,
    )) {
      result.state.approve(interruption, {
        ...(options?.alwaysApprove !== undefined && {
          alwaysApprove: options.alwaysApprove,
        }),
      });
    }
    return result.state;
  }

  //1. Optional. Reject a paused tool call, then pass the returned state to resumeAgent.
  //2. Leave interruptions out to reject every pause on the result.
  //3. message and alwaysReject are optional.
  reject(result: PausedRun, options?: RejectionChoice) {
    for (const interruption of this.approvalItems(
      result,
      options?.interruptions,
    )) {
      result.state.reject(interruption, {
        ...(options?.alwaysReject !== undefined && {
          alwaysReject: options.alwaysReject,
        }),
        ...(options?.message !== undefined && { message: options.message }),
      });
    }
    return result.state;
  }

  // Continue a paused run from the state approve or reject returned.
  // websocket, stream, and outputGuardrailBlockedMessage are optional.
  async resumeAgent<TContext>(
    agent: Agent,
    state: PausedRun['state'],
    options?: Pick<
      RunAgentOptions<TContext>,
      'websocket' | 'stream' | 'outputGuardrailBlockedMessage'
    >,
  ) {
    return await this.executeRun(agent, state, options);
  }

  // Optional. Store this string when a person will decide later.
  saveRun(result: PausedRun) {
    return result.state.toString();
  }

  // Load a string from saveRun. Pass the same agent that started the run.
  async loadRun(agent: Agent, saved: string) {
    return RunState.fromString(agent, saved);
  }

  private approvalItems(result: PausedRun, chosen?: RunToolApprovalItem[]) {
    if (chosen) return chosen;
    if (result.interruptions) return result.interruptions;
    return result.state.getInterruptions();
  }

  private async executeRun(
    agent: Agent,
    input: Parameters<typeof run>[1],
    options?: RunAgentOptions<unknown>,
  ) {
    const runOptions = {
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.session && { session: options.session }),
      ...(options?.outputGuardrailBlockedMessage !== undefined && {
        outputGuardrailBlockedMessage: options.outputGuardrailBlockedMessage,
      }),
    };
    const runner = options?.websocket ? this.webSocketRunner() : this.runner;

    if (options?.stream) {
      const streamed = { ...runOptions, stream: true as const };
      if (runner) return await runner.run(agent, input, streamed);
      return await run(agent, input, streamed);
    }

    if (runner) return await runner.run(agent, input, runOptions);
    return await run(agent, input, runOptions);
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
