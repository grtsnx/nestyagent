import { Module } from '@nestjs/common';
import { OpenaiModule } from '../openai/openai.module.js';
import { SandboxService } from './sandbox.service.js';

@Module({
  imports: [OpenaiModule],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
