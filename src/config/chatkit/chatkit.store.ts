import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@/generated/prisma/client.js';
import {
  AttachmentStore,
  NotFoundError,
  Store,
  type Attachment,
  type AttachmentCreateParams,
  type Order,
  type Page,
  type ThreadItem,
  type ThreadMetadata,
} from '@/lib/chatkit/chatkit.service.js';
import {
  isUniqueViolation,
  PrismaService,
} from '@/lib/prisma/prisma.service.js';
import { ChatKitAuth, type ChatKitContext } from './chatkit.auth.js';

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const json = (value: unknown) => value as unknown as Prisma.InputJsonValue;

//1. ChatKit threads, items, and attachment metadata in Postgres, as JSON in ChatKit's own shape.
//2. Every read and write is scoped to context.userId, so one user can never see another's chat.
@Injectable()
export class ChatKitStore extends Store<ChatKitContext> {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async loadThread(threadId: string, context: ChatKitContext) {
    const row = await this.prisma.db.chatkitThread.findFirst({
      where: { id: threadId, userId: context.userId },
      select: { data: true },
    });
    if (!row) throw new NotFoundError('Thread not found.');
    return row.data as unknown as ThreadMetadata;
  }

  //1. Updates the user's own thread, or creates it.
  //2. A thread id owned by someone else fails as not found, never as a takeover.
  async saveThread(thread: ThreadMetadata, context: ChatKitContext) {
    const { count } = await this.prisma.db.chatkitThread.updateMany({
      where: { id: thread.id, userId: context.userId },
      data: { data: json(thread) },
    });
    if (count) return;
    try {
      await this.prisma.db.chatkitThread.create({
        data: {
          id: thread.id,
          userId: context.userId,
          data: json(thread),
          createdAt: new Date(thread.created_at),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new NotFoundError('Thread not found.');
      throw error;
    }
  }

  async loadThreads(
    limit: number,
    after: string | null,
    order: Order,
    context: ChatKitContext,
  ): Promise<Page<ThreadMetadata>> {
    const cursor = after
      ? await this.prisma.db.chatkitThread.findFirst({
          where: { id: after, userId: context.userId },
          select: { createdAt: true, id: true },
        })
      : null;
    const direction = order === 'asc' ? 'gt' : 'lt';
    const rows = await this.prisma.db.chatkitThread.findMany({
      where: {
        userId: context.userId,
        ...(cursor && {
          OR: [
            { createdAt: { [direction]: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { [direction]: cursor.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: order }, { id: order }],
      take: limit + 1,
      select: { id: true, data: true },
    });
    return page(rows, limit, (row) => row.data as unknown as ThreadMetadata);
  }

  async deleteThread(threadId: string, context: ChatKitContext) {
    // Items and attachments (with their bytes) go with the thread.
    await this.prisma.db.chatkitThread.deleteMany({
      where: { id: threadId, userId: context.userId },
    });
  }

  async loadThreadItems(
    threadId: string,
    after: string | null,
    limit: number,
    order: Order,
    context: ChatKitContext,
  ): Promise<Page<ThreadItem>> {
    await this.loadThread(threadId, context);
    const cursor = after
      ? await this.prisma.db.chatkitItem.findUnique({
          where: { threadId_id: { threadId, id: after } },
          select: { seq: true },
        })
      : null;
    const rows = await this.prisma.db.chatkitItem.findMany({
      where: {
        threadId,
        ...(cursor && { seq: { [order === 'asc' ? 'gt' : 'lt']: cursor.seq } }),
      },
      orderBy: { seq: order },
      take: limit + 1,
      select: { id: true, data: true },
    });
    return page(rows, limit, (row) => row.data as unknown as ThreadItem);
  }

  // A repeated item id updates in place and keeps its position.
  async addThreadItem(
    threadId: string,
    item: ThreadItem,
    context: ChatKitContext,
  ) {
    await this.saveItem(threadId, item, context);
  }

  async saveItem(threadId: string, item: ThreadItem, context: ChatKitContext) {
    await this.loadThread(threadId, context);
    await this.prisma.db.chatkitItem.upsert({
      where: { threadId_id: { threadId, id: item.id } },
      create: { threadId, id: item.id, data: json(item) },
      update: { data: json(item) },
    });
  }

  async loadItem(threadId: string, itemId: string, context: ChatKitContext) {
    await this.loadThread(threadId, context);
    const row = await this.prisma.db.chatkitItem.findUnique({
      where: { threadId_id: { threadId, id: itemId } },
      select: { data: true },
    });
    if (!row) throw new NotFoundError('Item not found.');
    return row.data as unknown as ThreadItem;
  }

  async deleteThreadItem(
    threadId: string,
    itemId: string,
    context: ChatKitContext,
  ) {
    await this.loadThread(threadId, context);
    await this.prisma.db.chatkitItem.deleteMany({
      where: { threadId, id: itemId },
    });
  }

  async saveAttachment(attachment: Attachment, context: ChatKitContext) {
    if (attachment.thread_id)
      await this.loadThread(attachment.thread_id, context);
    const { count } = await this.prisma.db.chatkitAttachment.updateMany({
      where: { id: attachment.id, userId: context.userId },
      data: { data: json(attachment), threadId: attachment.thread_id ?? null },
    });
    if (count) return;
    try {
      await this.prisma.db.chatkitAttachment.create({
        data: {
          id: attachment.id,
          userId: context.userId,
          threadId: attachment.thread_id ?? null,
          data: json(attachment),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new NotFoundError('Attachment not found.');
      throw error;
    }
  }

  async loadAttachment(attachmentId: string, context: ChatKitContext) {
    const row = await this.prisma.db.chatkitAttachment.findFirst({
      where: { id: attachmentId, userId: context.userId },
      select: { data: true },
    });
    if (!row) throw new NotFoundError('Attachment not found.');
    return row.data as unknown as Attachment;
  }

  async deleteAttachment(attachmentId: string, context: ChatKitContext) {
    await this.prisma.db.chatkitAttachment.deleteMany({
      where: { id: attachmentId, userId: context.userId },
    });
  }

  // The bytes of the user's own file, for the model.
  async loadAttachmentContent(attachmentId: string, userId: string) {
    const found = await this.loadAttachmentForLink(attachmentId);
    if (found.userId !== userId)
      throw new NotFoundError('Attachment not found.');
    return found;
  }

  // A file by id with its owner, so a signed link can be checked against that owner.
  async loadAttachmentForLink(attachmentId: string) {
    const row = await this.prisma.db.chatkitAttachment.findUnique({
      where: { id: attachmentId },
      select: { userId: true, data: true, content: true },
    });
    if (!row) throw new NotFoundError('Attachment not found.');
    return {
      userId: row.userId,
      attachment: row.data as unknown as Attachment,
      content: row.content ? Buffer.from(row.content) : undefined,
    };
  }

  // Saves uploaded bytes, and clears the upload instructions once the file is there.
  async saveAttachmentContent(
    attachment: Attachment,
    content: Buffer,
    context: ChatKitContext,
  ) {
    const { upload_descriptor: _done, ...uploaded } = attachment;
    const { count } = await this.prisma.db.chatkitAttachment.updateMany({
      where: { id: attachment.id, userId: context.userId },
      data: { data: json(uploaded), content: new Uint8Array(content) },
    });
    if (!count) throw new NotFoundError('Attachment not found.');
    return uploaded as Attachment;
  }
}

//1. Two-phase upload: attachments.create returns a signed link to this server's upload route.
//2. Deleting removes the row and its bytes together.
@Injectable()
export class ChatKitAttachmentStore extends AttachmentStore<ChatKitContext> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: ChatKitAuth,
    private readonly config: ConfigService,
  ) {
    super();
  }

  get maxBytes() {
    return (
      this.config.get<number>('CHATKIT_MAX_UPLOAD_BYTES') ??
      DEFAULT_MAX_UPLOAD_BYTES
    );
  }

  // Metadata for a new file, with its own upload and content links.
  describe(
    id: string,
    name: string,
    mimeType: string,
    context: ChatKitContext,
  ): Attachment {
    const signature = this.auth.signAttachment(id, context.userId);
    const link = (path: string) =>
      `${context.baseUrl}/v1/chatkit/attachments/${encodeURIComponent(id)}/${path}?sig=${signature}`;
    return mimeType.startsWith('image/')
      ? {
          type: 'image',
          id,
          name,
          mime_type: mimeType,
          preview_url: link('content'),
        }
      : { type: 'file', id, name, mime_type: mimeType };
  }

  createAttachment(input: AttachmentCreateParams, context: ChatKitContext) {
    checkUpload(input.name, input.mime_type, input.size, this.maxBytes);
    const id = this.generateAttachmentId(input.mime_type, context);
    const signature = this.auth.signAttachment(id, context.userId);
    return Promise.resolve({
      ...this.describe(id, input.name, input.mime_type, context),
      upload_descriptor: {
        url: `${context.baseUrl}/v1/chatkit/attachments/${encodeURIComponent(id)}/upload?sig=${signature}`,
        method: 'POST' as const,
      },
    });
  }

  async deleteAttachment(attachmentId: string, context: ChatKitContext) {
    await this.prisma.db.chatkitAttachment.deleteMany({
      where: { id: attachmentId, userId: context.userId },
    });
  }
}

// Rejects files that are empty, too large, or have no type.
export function checkUpload(
  name: string,
  mimeType: string,
  size: number,
  maxBytes: number,
) {
  if (!name || !mimeType)
    throw new RangeError('A file needs a name and a type.');
  if (!Number.isInteger(size) || size <= 0 || size > maxBytes)
    throw new RangeError(`Files must be between 1 byte and ${maxBytes} bytes.`);
}

function page<T, R extends { id: string }>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): Page<T> {
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit);
  return {
    data: kept.map(map),
    has_more: hasMore,
    after: hasMore ? (kept.at(-1)?.id ?? null) : null,
  };
}
