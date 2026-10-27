import { Module } from '@nestjs/common';
import { SystemPromptsModule } from '../system-prompts/system-prompts.module.js';
import { ChatKitModule as ChatKitLibModule } from '@/lib/chatkit/chatkit.module.js';
import { ChatKitController } from './chatkit.controller.js';
import { AgenticChatKitService } from './chatkit.service.js';

@Module({
  imports: [ChatKitLibModule, SystemPromptsModule],
  controllers: [ChatKitController],
  providers: [AgenticChatKitService],
})
export class ChatKitModule {}
