import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { ChatKitModule } from './chatkit/chatkit.module.js';
import { SystemPromptsModule } from './system-prompts/system-prompts.module.js';
import { WebhookModule } from './webhook/webhook.module.js';

@Module({
  imports: [AdminModule, ChatKitModule, SystemPromptsModule, WebhookModule],
})
export class V1Module {}
