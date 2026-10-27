import { Module } from '@nestjs/common';
import { OpenaiModule } from './openai/openai.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';

@Module({
  imports: [PrismaModule, OpenaiModule, SandboxModule],
  exports: [PrismaModule, OpenaiModule, SandboxModule],
})
export class LibModule {}
