import { Module } from '@nestjs/common';
import { ComposioModule } from './composio/composio.module.js';
import { LangfuseModule } from './langfuse/langfuse.module.js';
import { OpenaiModule } from './openai/openai.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';

@Module({
  imports: [
    PrismaModule,
    LangfuseModule,
    ComposioModule,
    OpenaiModule,
    SandboxModule,
  ],
  exports: [
    PrismaModule,
    LangfuseModule,
    ComposioModule,
    OpenaiModule,
    SandboxModule,
  ],
})
export class LibModule {}
