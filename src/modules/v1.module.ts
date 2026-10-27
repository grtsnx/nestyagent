import { Module } from '@nestjs/common';
import { WebhookModule } from './webhook/webhook.module.js';

@Module({
  imports: [WebhookModule],
})
export class V1Module {}
