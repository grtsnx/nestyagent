import { Module } from '@nestjs/common';
import { InstructionsModule } from './instructions/instructions.module.js';
import { WebhookModule } from './webhook/webhook.module.js';

@Module({
  imports: [InstructionsModule, WebhookModule],
})
export class V1Module {}
