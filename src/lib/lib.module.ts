import { Module } from '@nestjs/common';
import { OpenaiModule } from './openai/openai.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';

@Module({
  imports: [OpenaiModule, SandboxModule],
  exports: [OpenaiModule, SandboxModule],
})
export class LibModule {}
