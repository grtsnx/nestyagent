import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { SystemPromptsModule } from './system-prompts/system-prompts.module.js';
import { WebhookModule } from './webhook/webhook.module.js';

@Module({
  imports: [AdminModule, SystemPromptsModule, WebhookModule],
})
export class V1Module {}
