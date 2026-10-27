import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { Agent, run, setDefaultOpenAIKey, Tool } from '@openai/agents';

@Injectable()
export class OpenaiService implements OnModuleInit {
  constructor(private readonly configService: ConfigService) {}

  // Set the default OpenAI key
  onModuleInit() {
    const apiKey = this.configService
      .getOrThrow<string>('OPENAI_API_KEY')
      .trim();
    setDefaultOpenAIKey(apiKey);
  }

  // Create a new agent
  createAgent(
    name: string,
    instructions: string,
    model: string,
    tools?: Tool[],
    schema?: z.ZodObject,
    handoffDescription?: string,
  ) {
    return new Agent({
      name,
      instructions,
      model,
      ...(schema && { outputType: schema }),
      ...(tools && { tools }),
      ...(handoffDescription && { handoffDescription }),
    });
  }

  // Create a triage agent that routes work to specialist agents.
  // handoffDescription is required so another agent knows when to hand off to it.
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

  // Run a prompt on an agent. For triage, pass the agent from createTriageAgent.
  // That agent reads the prompt and hands it to one specialist in its handoffs.
  // context is optional data for your code. The model does not see it.
  async runAgent<TContext>(prompt: string, agent: Agent, context?: TContext) {
    return await run(
      agent,
      prompt,
      context === undefined ? undefined : { context },
    );
  }
}
