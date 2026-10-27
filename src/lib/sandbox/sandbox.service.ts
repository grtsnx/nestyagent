import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { run, Session } from '@openai/agents';
import { Capability, Manifest, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

type CreateSandboxAgentOptions = {
  model?: string;
  capabilities?: Capability[];
  manifest?: Manifest;
};

@Injectable()
export class SandboxService {
  private readonly client = new UnixLocalSandboxClient();

  constructor(private readonly configService: ConfigService) {}

  createSandboxAgent(
    name: string,
    instructions: string,
    options?: CreateSandboxAgentOptions,
  ) {
    return new SandboxAgent({
      name,
      instructions,
      ...(options?.model && { model: options.model }),
      ...(options?.capabilities && { capabilities: options.capabilities }),
      ...(options?.manifest && { defaultManifest: options.manifest }),
    });
  }

  async openSandbox(manifest = new Manifest()) {
    const password = this.configService.get<string>('ACCOUNT_PASSWORD');

    return await this.client.create({
      manifest: new Manifest({
        ...manifest,
        environment: {
          ...(password !== undefined && { ACCOUNT_PASSWORD: password }),
        },
      }),
    });
  }

  async runSandbox(
    prompt: string,
    agent: SandboxAgent,
    options: {
      workspace: Awaited<ReturnType<SandboxService['openSandbox']>>;
      chat?: Session;
    },
  ) {
    return await run(agent, prompt, {
      sandbox: { session: options.workspace },
      ...(options.chat && { session: options.chat }),
    });
  }
}
