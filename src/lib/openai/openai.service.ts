import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, run, setDefaultOpenAIKey } from '@openai/agents';

@Injectable()
export class OpenaiService implements OnModuleInit {
  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.getOrThrow<string>('OPENAI_API_KEY');
    setDefaultOpenAIKey(apiKey);
  }

  createAgent(name: string, instructions: string, model: string) {
    return new Agent({
      name,
      instructions,
      model,
    });
  }

  async runAgent(
    prompt: string,
    name: string,
    instructions: string,
    model: string,
  ) {
    return await run(this.createAgent(name, instructions, model), prompt);
  }
}
