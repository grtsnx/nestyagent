import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  Agent,
  ModelSettings,
  run,
  Runner,
  setDefaultOpenAIKey,
  Tool,
} from '@openai/agents';

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

  constructor(private readonly configService: ConfigService) {}

  // Set the default OpenAI key
  onModuleInit() {
    const apiKey = this.configService
      .getOrThrow<string>('OPENAI_API_KEY')
      .trim();
    setDefaultOpenAIKey(apiKey);
  }

  // Optional shared fallback. Agents that set their own model keep that model.
  createRunner(model: string) {
    this.runner = new Runner({ model });
    return this.runner;
  }

  // Create a new agent. Leave model out to use the runner model.
  // modelSettings defaults to medium reasoning effort. Pass settings to change it.
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
  createTriageAgent(
    name: string,
    instructions: string,
    handoffs: Agent[],
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

  //1. Medium reasoning effort unless the caller sets another effort or other settings.
  //2. temperature is included only when the caller passes a number, including 0.
  private modelSettings(
    settings?: ModelSettings,
    temperature?: number,
  ): ModelSettings {
    return {
      ...settings,
      ...(temperature !== undefined && { temperature }),
      reasoning: {
        effort: 'medium',
        ...settings?.reasoning,
      },
    };
  }

  //1. Run a prompt on an agent. For triage, pass the agent from createTriageAgent.
  //2. That agent reads the prompt and hands it to one specialist in its handoffs.
  //3. context is optional data for your code. The model does not see it.
  async runAgent<TContext>(prompt: string, agent: Agent, context?: TContext) {
    if (context === undefined) {
      if (this.runner) return await this.runner.run(agent, prompt);
      return await run(agent, prompt);
    }

    if (this.runner) return await this.runner.run(agent, prompt, { context });
    return await run(agent, prompt, { context });
  }
}
