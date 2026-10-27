import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
  type CallHandler,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Attachment } from '@/lib/chatkit/chatkit.service.js';
import { NotFoundError } from '@/lib/chatkit/chatkit.service.js';
import { ChatKitAuth, type ChatKitRequest } from './chatkit.auth.js';
import { ChatKitStore } from './chatkit.store.js';
import { chatkitUploadLimitSchema } from '../environment.js';

export type ChatKitUploadRequest = ChatKitRequest & {
  upload?: { attachment: Attachment; userId: string };
};

// Guards run before multipart parsing, so an invalid capability never buffers a file.
@Injectable()
export class ChatKitUploadGuard implements CanActivate {
  constructor(
    private readonly auth: ChatKitAuth,
    private readonly store: ChatKitStore,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (!this.auth.enabled)
      throw new UnauthorizedException(
        'ChatKit is off. Set CHATKIT_SECRET to turn it on.',
      );
    const request = context.switchToHttp().getRequest<ChatKitUploadRequest>();
    const id = request.params.id;
    const signature = request.query.sig;
    const userId =
      typeof id === 'string' && typeof signature === 'string'
        ? this.auth.verifyUpload(id, signature)
        : undefined;
    if (!userId || typeof id !== 'string')
      throw new NotFoundException('Attachment not found.');
    try {
      request.upload = {
        userId,
        attachment: await this.store.loadPendingAttachment(id, userId),
      };
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new NotFoundException('Attachment not found.');
      throw error;
    }
    return true;
  }
}

// Multer enforces the configured ceiling while reading, rather than after buffering.
@Injectable()
export class ChatKitUploadInterceptor implements NestInterceptor {
  private readonly delegate: NestInterceptor;
  constructor(config: ConfigService) {
    const maxBytes = chatkitUploadLimitSchema.parse(
      config.get<unknown>('CHATKIT_MAX_UPLOAD_BYTES'),
    );
    const Interceptor = FileInterceptor('file', {
      limits: { fileSize: maxBytes, files: 1, fields: 0 },
    });
    this.delegate = new Interceptor();
  }
  intercept(context: ExecutionContext, next: CallHandler) {
    return this.delegate.intercept(context, next);
  }
}
