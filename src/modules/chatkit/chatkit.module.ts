import { Module } from '@nestjs/common';
import { SystemPromptsModule } from '../system-prompts/system-prompts.module.js';
import {
  ChatKitAttachmentStore,
  ChatKitAuth,
  ChatKitAuthGuard,
  ChatKitStore,
} from '@/config/chatkit/index.js';
import { ChatKitController } from './chatkit.controller.js';
import { MsSuzieChatKitService } from './chatkit.service.js';

@Module({
  imports: [SystemPromptsModule],
  controllers: [ChatKitController],
  providers: [
    ChatKitAuth,
    ChatKitAuthGuard,
    ChatKitStore,
    ChatKitAttachmentStore,
    MsSuzieChatKitService,
  ],
})
export class ChatKitModule {}
