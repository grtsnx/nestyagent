import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chatkitUploadLimitSchema } from '../environment.js';
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

export { DEFAULT_MAX_UPLOAD_BYTES } from '../environment.js';

const json = (value: unknown) => value as unknown as Prisma.InputJsonValue;

//1. ChatKit threads, items, and attachment metadata in Postgres, as JSON in ChatKit's own shape.
//2. Every read and write is scoped to context.userId, so one user can never see another's chat.
@Injectable()
export class ChatKitStore extends Store<ChatKitContext> {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  generateThreadId(context: ChatKitContext) {
    return context.createdThreadId ?? super.generateThreadId(context);
  }

  transaction<T>(
    _threadId: string,
    _context: ChatKitContext,
    work: (store: Store<ChatKitContext>) => Promise<T>,
  ): Promise<T> {
    return this.prisma.transaction(() => work(this));
  }

  async loadThread(threadId: string, context: ChatKitContext) {
    const row = await this.prisma.connection.chatkitThread.findFirst({
      where: { id: threadId, userId: context.userId },
      select: { data: true },
    });
    if (!row) throw new NotFoundError('Thread not found.');
    return row.data as unknown as ThreadMetadata;
  }

  //1. Updates the user's own thread, or creates it.
  //2. A thread id owned by someone else fails as not found, never as a takeover.
  async saveThread(thread: ThreadMetadata, context: ChatKitContext) {
    return await this.prisma.transaction(async () => {
      const { count } = await this.prisma.connection.chatkitThread.updateMany({
        where: { id: thread.id, userId: context.userId },
        data: { data: json(thread) },
      });
      if (count) return;
      try {
        await this.prisma.connection.chatkitThread.create({
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
    });
  }

  async loadThreads(
    limit: number,
    after: string | null,
    order: Order,
    context: ChatKitContext,
  ): Promise<Page<ThreadMetadata>> {
    const cursor = after
      ? await this.prisma.connection.chatkitThread.findFirst({
          where: { id: after, userId: context.userId },
          select: { createdAt: true, id: true },
        })
      : null;
    const direction = order === 'asc' ? 'gt' : 'lt';
    const rows = await this.prisma.connection.chatkitThread.findMany({
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
    return await this.prisma.transaction(async () => {
      // Items and attachments (with their bytes) go with the thread.
      await this.prisma.connection.chatkitThread.deleteMany({
        where: { id: threadId, userId: context.userId },
      });
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
      ? await this.prisma.connection.chatkitItem.findUnique({
          where: {
            threadId_id: { threadId, id: after },
            thread: { userId: context.userId },
          },
          select: { seq: true },
        })
      : null;
    const rows = await this.prisma.connection.chatkitItem.findMany({
      where: {
        threadId,
        thread: { userId: context.userId },
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
    return await this.prisma.transaction(async () => {
      await this.loadThread(threadId, context);
      await this.prisma.connection.chatkitItem.upsert({
        where: {
          threadId_id: { threadId, id: item.id },
          thread: { userId: context.userId },
        },
        create: { threadId, id: item.id, data: json(item) },
        update: { data: json(item) },
      });
    });
  }

  async loadItem(threadId: string, itemId: string, context: ChatKitContext) {
    await this.loadThread(threadId, context);
    const row = await this.prisma.connection.chatkitItem.findUnique({
      where: {
        threadId_id: { threadId, id: itemId },
        thread: { userId: context.userId },
      },
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
    return await this.prisma.transaction(async () => {
      await this.loadThread(threadId, context);
      await this.prisma.connection.chatkitItem.deleteMany({
        where: { threadId, id: itemId, thread: { userId: context.userId } },
      });
    });
  }

  async saveAttachment(attachment: Attachment, context: ChatKitContext) {
    return await this.prisma.transaction(async () => {
      if (attachment.thread_id)
        await this.loadThread(attachment.thread_id, context);
      const existing = await this.lockAttachment(attachment.id);
      if (existing) {
        if (
          existing.userId !== context.userId ||
          (existing.threadId && existing.threadId !== attachment.thread_id)
        )
          throw new NotFoundError(
            'Attachment is not available for this thread.',
          );
        const threadId = attachment.thread_id ?? null;
        // Binding never replaces canonical metadata with a stale client-visible copy.
        const updated = {
          ...(existing.data as unknown as Attachment),
          ...(threadId && { thread_id: threadId }),
        };
        await this.prisma.connection.chatkitAttachment.updateMany({
          where: { id: attachment.id, userId: context.userId },
          data: { threadId, data: json(updated) },
        });
        return;
      }
      try {
        await this.prisma.connection.chatkitAttachment.create({
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
    });
  }

  async loadAttachment(attachmentId: string, context: ChatKitContext) {
    const row = await this.prisma.connection.chatkitAttachment.findFirst({
      where: { id: attachmentId, userId: context.userId },
      select: { data: true },
    });
    if (!row) throw new NotFoundError('Attachment not found.');
    return row.data as unknown as Attachment;
  }

  async deleteAttachment(attachmentId: string, context: ChatKitContext) {
    return await this.prisma.transaction(async () => {
      await this.prisma.connection.chatkitAttachment.deleteMany({
        where: { id: attachmentId, userId: context.userId },
      });
    });
  }

  // The bytes of the user's own file, for the model.
  async loadAttachmentContent(attachmentId: string, userId: string) {
    const row = await this.prisma.connection.chatkitAttachment.findFirst({
      where: { id: attachmentId, userId },
      select: { userId: true, data: true, content: true },
    });
    if (!row) throw new NotFoundError('Attachment not found.');
    return {
      userId: row.userId,
      attachment: row.data as unknown as Attachment,
      content: row.content ? Buffer.from(row.content) : undefined,
    };
  }

  async loadAttachmentInfo(attachmentId: string) {
    const row = await this.prisma.connection.chatkitAttachment.findUnique({
      where: { id: attachmentId },
      select: { userId: true, data: true },
    });
    if (!row) throw new NotFoundError('Attachment not found.');
    return {
      userId: row.userId,
      attachment: row.data as unknown as Attachment,
    };
  }

  async loadPendingAttachment(attachmentId: string, userId: string) {
    const row = await this.prisma.connection.chatkitAttachment.findFirst({
      where: { id: attachmentId, userId, content: null },
      select: { data: true },
    });
    const attachment = row?.data as unknown as Attachment | undefined;
    if (!attachment?.upload_descriptor)
      throw new NotFoundError('Attachment not found.');
    return attachment;
  }

  // Compatibility for callers checking link existence; bytes require an owner.
  loadAttachmentForLink(attachmentId: string) {
    return this.loadAttachmentInfo(attachmentId);
  }

  // Saves uploaded bytes, and clears the upload instructions once the file is there.
  async saveAttachmentContent(
    attachment: Attachment,
    content: Buffer,
    context: ChatKitContext,
  ) {
    return await this.prisma.transaction(async () => {
      const current = await this.lockAttachment(attachment.id);
      if (!current || current.userId !== context.userId)
        throw new NotFoundError('Attachment not found.');
      const { upload_descriptor: _done, ...uploaded } =
        current.data as unknown as Attachment;
      const { count } =
        await this.prisma.connection.chatkitAttachment.updateMany({
          where: { id: attachment.id, userId: context.userId, content: null },
          data: { data: json(uploaded), content: new Uint8Array(content) },
        });
      if (!count) throw new NotFoundError('Attachment not found.');
      return uploaded as Attachment;
    });
  }

  saveUploadedAttachment(
    attachment: Attachment,
    content: Buffer,
    context: ChatKitContext,
  ) {
    return this.prisma.transaction(async () => {
      await this.saveAttachment(attachment, context);
      return this.saveAttachmentContent(attachment, content, context);
    });
  }

  private async lockAttachment(id: string) {
    const rows = await this.prisma.connection.$queryRaw<
      Array<{ userId: string; threadId: string | null; data: Prisma.JsonValue }>
    >`
      SELECT user_id AS "userId", thread_id AS "threadId", data
      FROM chatkit_attachments WHERE id = ${id} FOR UPDATE`;
    return rows[0];
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
    return chatkitUploadLimitSchema.parse(
      this.config.get<unknown>('CHATKIT_MAX_UPLOAD_BYTES'),
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
    const signature = this.auth.issueUpload(id, context.userId);
    return Promise.resolve({
      ...this.describe(id, input.name, input.mime_type, context),
      upload_descriptor: {
        url: `${context.baseUrl}/v1/chatkit/attachments/${encodeURIComponent(id)}/upload?sig=${signature}`,
        method: 'POST' as const,
      },
    });
  }

  async deleteAttachment(attachmentId: string, context: ChatKitContext) {
    await this.prisma.transaction(() =>
      this.prisma.connection.chatkitAttachment.deleteMany({
        where: { id: attachmentId, userId: context.userId },
      }),
    );
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
