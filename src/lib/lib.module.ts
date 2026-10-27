import { Module } from '@nestjs/common';
import { WebhookModule } from '@/modules/webhook/webhook.module.js';
import { OpenaiModule } from './openai/openai.module.js';

@Module({
  imports: [OpenaiModule, WebhookModule],
  exports: [OpenaiModule, WebhookModule],
})
export class LibModule {}
