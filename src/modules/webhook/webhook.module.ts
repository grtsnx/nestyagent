import { Module } from '@nestjs/common';
import { SandboxModule } from '@/lib/sandbox/sandbox.module.js';
import { WebhookController } from './webhook.controller.js';

@Module({
  imports: [SandboxModule],
  controllers: [WebhookController],
  exports: [SandboxModule],
})
export class WebhookModule {}
