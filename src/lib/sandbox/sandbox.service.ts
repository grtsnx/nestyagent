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

  // Create a sandbox agent. Leave model out to use the default model.
  // manifest is optional starting files. skills and memory are optional.
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

  //1. Shell, filesystem, and compaction are always on.
  //2. Skills and memory are added only when the caller asks for them.
  //3. skills takes one source: text in the call, a folder, or a git repo.
  //4. memory: true reads old lessons and writes new ones.
  private capabilities(options?: CreateSandboxAgentOptions): Capability[] {
    return [
      ...Capabilities.default(),
      ...(options?.skills ? [skills(options.skills)] : []),
      ...(options?.memory
        ? [memory(options.memory === true ? undefined : options.memory)]
        : []),
    ];
  }

  // Open a workspace computer. Pass a manifest to start with files or a cloned repo.
  // ACCOUNT_PASSWORD is added only when it is set in the server environment.
  async openSandbox(manifest = new Manifest()) {
    const password = this.configService.get<string>('ACCOUNT_PASSWORD');

    return await this.client.create({
      manifest: new Manifest({
        entries: manifest.entries,
        environment: {
          ...manifest.environment,
          ...(password !== undefined && {
            ACCOUNT_PASSWORD: { value: password, ephemeral: true },
          }),
        },
      }),
    });
  }

  //1. Run a prompt on a sandbox agent inside a workspace.
  //2. Pass the same workspace on the next run to keep the files and the browser.
  //3. chat is optional. Reuse one session to continue the messages.
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
