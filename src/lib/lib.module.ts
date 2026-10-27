import { Module } from '@nestjs/common';
import { LangfuseModule } from './langfuse/langfuse.module.js';
import { OpenaiModule } from './openai/openai.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';

@Module({
  imports: [PrismaModule, LangfuseModule, OpenaiModule, SandboxModule],
  exports: [PrismaModule, LangfuseModule, OpenaiModule, SandboxModule],
})
export class LibModule {}
