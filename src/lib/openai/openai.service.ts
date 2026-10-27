import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  ModelSettings,
  OpenAIProvider,
  run,
  Runner,
  Session,
  setDefaultOpenAIKey,
  Tool,
} from '@openai/agents';

type RunAgentOptions<TContext> = {
  context?: TContext;
  session?: Session;
  websocket?: boolean;
};

type AsToolOptions = Pick<
  NonNullable<Parameters<Agent['asTool']>[0]>,
  'toolName' | 'toolDescription' | 'runConfig'
>;

type CreateAgentOptions = {
  model?: string;
  tools?: Tool[];
  schema?: z.ZodObject;
  handoffDescription?: string;
  modelSettings?: ModelSettings;
  temperature?: number;
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
  createAgent(
    name: string,
    instructions: string,
    options?: CreateAgentOptions,
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
    });
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
      'model' | 'modelSettings' | 'temperature'
    >,
  ) {
    return Agent.create({
      name,
      instructions,
      handoffs,
      handoffDescription,
      modelSettings: this.modelSettings(
        options?.modelSettings,
        options?.temperature,
      ),
      ...(options?.model && { model: options.model }),
    });
  }

  //1. Turn an agent into a tool. The manager keeps the reply and calls this agent for one job.
  //2. toolName and toolDescription are optional. The agent name is used when toolName is left out.
  //3. runConfig is optional. SandboxService passes the workspace through it.
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
  async runAgent<TContext>(
    prompt: string,
    agent: Agent,
    options?: RunAgentOptions<TContext>,
  ) {
    const runOptions = {
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.session && { session: options.session }),
    };
    const runner = options?.websocket ? this.webSocketRunner() : this.runner;

    if (runner) return await runner.run(agent, prompt, runOptions);
    return await run(agent, prompt, runOptions);
  }

  //1. Optional. Call this after a handoff when the same specialist should answer the next message.
  //2. fallback is required here. It is used when the run has no last agent.
  nextAgent(result: { lastAgent?: Agent }, fallback: Agent) {
    return result.lastAgent ?? fallback;
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
