import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { run, Session } from '@openai/agents';
import {
  Capabilities,
  Capability,
  Manifest,
  MemoryArgs,
  SandboxAgent,
  SkillsArgs,
  memory,
  skills,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

type CreateSandboxAgentOptions = {
  model?: string;
  manifest?: Manifest;
  skills?: SkillsArgs;
  memory?: boolean | MemoryArgs;
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
      capabilities: this.capabilities(options),
      ...(options?.model && { model: options.model }),
      ...(options?.manifest && { defaultManifest: options.manifest }),
    });
  }

  // Shell, filesystem, and compaction are always on.
  // Skills and memory are added only when the caller asks for them.
  private capabilities(options?: CreateSandboxAgentOptions): Capability[] {
    return [
      ...Capabilities.default(),
      ...(options?.skills ? [skills(options.skills)] : []),
      ...(options?.memory
        ? [memory(options.memory === true ? undefined : options.memory)]
        : []),
    ];
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
