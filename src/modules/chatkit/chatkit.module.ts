import { Module } from '@nestjs/common';
import { SystemPromptsModule } from '../system-prompts/system-prompts.module.js';
import { ChatKitModule as ChatKitLibModule } from '@/lib/chatkit/chatkit.module.js';
import { ChatKitController } from './chatkit.controller.js';
import { MsSuzieChatKitService } from './chatkit.service.js';

@Module({
  imports: [ChatKitLibModule, SystemPromptsModule],
  controllers: [ChatKitController],
  providers: [MsSuzieChatKitService],
})
export class ChatKitModule {}
