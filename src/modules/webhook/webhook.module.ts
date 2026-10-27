import { Module } from '@nestjs/common';
import { SandboxService } from '@/lib/index.js';
import { WebhookController } from './webhook.controller.js';

@Module({
  controllers: [WebhookController],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class WebhookModule {}
