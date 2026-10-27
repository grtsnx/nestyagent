import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { Agent, run, Runner, setDefaultOpenAIKey, Tool } from '@openai/agents';

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
  createAgent(
    name: string,
    instructions: string,
    model?: string,
    tools?: Tool[],
    schema?: z.ZodObject,
    handoffDescription?: string,
  ) {
    return new Agent({
      name,
      instructions,
      ...(model && { model }),
      ...(schema && { outputType: schema }),
      ...(tools && { tools }),
      ...(handoffDescription && { handoffDescription }),
    });
  }

  //1. Create a triage agent that routes work to specialist agents.
  //2. handoffDescription is required so another agent knows when to hand off to it.
  createTriageAgent(
    name: string,
    instructions: string,
    handoffs: Agent[],
    handoffDescription: string,
    model?: string,
  ) {
    return Agent.create({
      name,
      instructions,
      handoffs,
      handoffDescription,
      ...(model && { model }),
    });
  }

  //1. Run a prompt on an agent. For triage, pass the agent from createTriageAgent.
  //2. That agent reads the prompt and hands it to one specialist in its handoffs.
  //3. context is optional data for your code. The model does not see it.
  async runAgent<TContext>(prompt: string, agent: Agent, context?: TContext) {
    const options = context === undefined ? undefined : { context };

    if (this.runner) {
      return await this.runner.run(agent, prompt, options);
    }

    return await run(agent, prompt, options);
  }
}
