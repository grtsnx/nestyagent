import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  ChatKitAttachmentStore,
  ChatKitAuth,
  ChatKitAuthGuard,
  ChatKitStore,
  ChatKitUploadGuard,
  ChatKitUploadInterceptor,
} from '@/config/chatkit/index.js';
import { PrismaModule } from '../prisma/prisma.module.js';

// Shared ChatKit infrastructure; each application extends ChatKitService for its agent.
@Global()
@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    ChatKitAuth,
    ChatKitAuthGuard,
    ChatKitStore,
    ChatKitAttachmentStore,
    ChatKitUploadGuard,
    ChatKitUploadInterceptor,
  ],
  exports: [
    ChatKitAuth,
    ChatKitAuthGuard,
    ChatKitStore,
    ChatKitAttachmentStore,
    ChatKitUploadGuard,
    ChatKitUploadInterceptor,
  ],
})
export class ChatKitModule {}
