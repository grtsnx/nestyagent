import { Module } from '@nestjs/common';
import { SandboxService } from './sandbox.service.js';

@Module({
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
