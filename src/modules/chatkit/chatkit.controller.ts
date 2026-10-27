import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ChatKitAuth,
  ChatKitAuthGuard,
  checkUpload,
  type ChatKitContext,
  type ChatKitRequest,
} from '@/config/chatkit/index.js';
import { ChatKitRequestDto, ChatKitTokenDto } from '@/dto/index.js';
import {
  InvalidRequestError,
  NotFoundError,
  serialize,
} from '@/lib/chatkit/chatkit.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { AdminKeyGuard, ApiFailure, ApiSuccess, baseUrl } from '@/middleware';
import { MsSuzieChatKitService } from './chatkit.service.js';

// Files are kept in memory, never on disk. Reading stops past this. The configured limit, at most 50 MB, is checked after.
const UPLOAD_CEILING = 50 * 1024 * 1024 + 1;
// Shown inline. Anything else, such as SVG or HTML, downloads, so it can never run as a page.
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

type UploadedPart = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

@ApiTags('ChatKit')
@Controller({ path: 'chatkit', version: '1' })
export class ChatKitController {
  private readonly logger = new Logger(ChatKitController.name);

  constructor(
    private readonly server: MsSuzieChatKitService,
    private readonly auth: ChatKitAuth,
    private readonly prisma: PrismaService,
  ) {}

  @ApiOperation({
    summary: 'ChatKit protocol endpoint',
    description:
      'The ChatKit client sends every request here, and streaming requests answer with server-sent events.',
  })
  @ApiBearerAuth()
  @ApiBody({ type: ChatKitRequestDto })
  @ApiProduces('text/event-stream', 'application/json')
  @ApiSuccess(
    'A streaming request answers with server-sent events, and the rest with JSON.',
    {},
  )
  @ApiFailure(
    HttpStatus.UNAUTHORIZED,
    'The bearer token is missing, expired, or not signed with CHATKIT_SECRET.',
    'A valid ChatKit token is required.',
    '/v1/chatkit',
  )
  @ApiFailure(
    HttpStatus.FORBIDDEN,
    'CHATKIT_SECRET is not set, so ChatKit is off.',
    'ChatKit is off. Set CHATKIT_SECRET to turn it on.',
    '/v1/chatkit',
  )
  @ApiFailure(
    HttpStatus.CONFLICT,
    'Another reply is already streaming in this thread, so try again when it finishes.',
    'This operation is already running. Retry after it finishes.',
    '/v1/chatkit',
  )
  @UseGuards(ChatKitAuthGuard)
  @Post()
  async process(
    @Req() request: RawBodyRequest<ChatKitRequest>,
    @Res() response: Response,
  ) {
    const disconnected = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded)
        disconnected.abort(new Error('The ChatKit client disconnected.'));
    });
    const body =
      request.rawBody?.toString('utf8') ?? JSON.stringify(request.body ?? {});
    const threadId = threadIdOf(body);
    const run = async (lock?: AbortSignal) => {
      const signal = lock
        ? AbortSignal.any([disconnected.signal, lock])
        : disconnected.signal;
      const context: ChatKitContext = { ...request.chatkit!, signal };
      const result = await this.server
        .process(body, context, signal)
        .catch(rethrow);
      if (!result.streaming) {
        response.status(200).type('application/json').send(result.json);
        return;
      }
      await this.stream(result.stream, response);
    };
    // One reply at a time per thread, across every server, so two messages never interleave.
    if (threadId) await this.prisma.withLock(`chatkit:${threadId}`, run);
    else await run();
  }

  @ApiOperation({
    summary: 'Upload a file',
    description:
      'The ChatKit client posts a file here with the direct upload strategy and gets the attachment back.',
  })
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'This is the file to attach, in a field named file.',
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiSuccess('The file was saved and can be sent with the next message.', {
    type: 'image',
    id: 'atc_0123456789abcdef0123456789abcdef',
    name: 'homework.png',
    mime_type: 'image/png',
    preview_url:
      'https://api.mssuzie.io/v1/chatkit/attachments/atc_0123456789abcdef0123456789abcdef/content?sig=signature',
  })
  @UseGuards(ChatKitAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_CEILING },
    }),
  )
  @Post('attachments')
  async upload(
    @Req() request: ChatKitRequest,
    @UploadedFile() file: UploadedPart | undefined,
    @Res() response: Response,
  ) {
    const context = request.chatkit!;
    const part = this.checkPart(file);
    const store = this.server.chatkitStore;
    const files = this.server.chatkitAttachments;
    const attachment = files.describe(
      files.generateAttachmentId(part.mimetype, context),
      part.originalname,
      part.mimetype,
      context,
    );
    await store.saveAttachment(attachment, context);
    const saved = await store.saveAttachmentContent(
      attachment,
      part.buffer,
      context,
    );
    response.status(200).type('application/json').send(serialize(saved));
  }

  @ApiOperation({
    summary: 'Finish a two-phase upload',
    description:
      'The ChatKit client posts the file bytes here after attachments.create, using the signed link it was given.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'This is the file to attach, in a field named file.',
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiSuccess('The bytes were saved for the attachment.', {
    type: 'file',
    id: 'atc_0123456789abcdef0123456789abcdef',
    name: 'report.pdf',
    mime_type: 'application/pdf',
  })
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'The link is not valid for this attachment, or the attachment was deleted.',
    'Attachment not found.',
    '/v1/chatkit/attachments/atc_1/upload',
  )
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_CEILING },
    }),
  )
  @Post('attachments/:id/upload')
  async finishUpload(
    @Param('id') id: string,
    @Query('sig') signature: string | undefined,
    @Req() request: Request,
    @UploadedFile() file: UploadedPart | undefined,
    @Res() response: Response,
  ) {
    const found = await this.signedAttachment(id, signature);
    const part = this.checkPart(file);
    const context: ChatKitContext = {
      userId: found.userId,
      baseUrl: baseUrl(request),
    };
    const saved = await this.server.chatkitStore.saveAttachmentContent(
      found.attachment,
      part.buffer,
      context,
    );
    response.status(200).type('application/json').send(serialize(saved));
  }

  @ApiOperation({
    summary: 'Read an attachment',
    description:
      'This route returns a file’s bytes through the signed link in its preview_url, so images show in the chat.',
  })
  @ApiProduces('application/octet-stream', ...INLINE_TYPES)
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'The link is not valid for this attachment, or the attachment was deleted.',
    'Attachment not found.',
    '/v1/chatkit/attachments/atc_1/content',
  )
  @Get('attachments/:id/content')
  async content(
    @Param('id') id: string,
    @Query('sig') signature: string | undefined,
    @Res() response: Response,
  ) {
    const { attachment, content } = await this.signedAttachment(id, signature);
    if (!content) throw new NotFoundException('The file was not uploaded yet.');
    const inline = INLINE_TYPES.has(attachment.mime_type);
    response
      .status(200)
      .setHeader(
        'Content-Type',
        inline ? attachment.mime_type : 'application/octet-stream',
      )
      .setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      )
      .setHeader('Cache-Control', 'private, max-age=3600')
      // The chat runs on another site. The signed link is the permission, so let it load there.
      .setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(content);
  }

  @ApiOperation({
    summary: 'Issue a ChatKit token',
    description:
      'Your own backend calls this with the admin key to get a short-lived token for one signed-in user.',
  })
  @ApiSecurity('admin')
  @ApiSuccess(
    'This token goes in the Authorization header of every ChatKit request.',
    {
      token:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJndWFyZGlhbi03In0.signature',
      expiresAt: '2026-10-27T10:00:00.000Z',
    },
    HttpStatus.CREATED,
  )
  @ApiFailure(
    HttpStatus.UNAUTHORIZED,
    'The x-admin-key header is missing or does not match ADMIN_API_KEY.',
    'A valid x-admin-key header is required.',
    '/v1/chatkit/tokens',
  )
  @UseGuards(AdminKeyGuard)
  @Post('tokens')
  token(@Body() body: ChatKitTokenDto) {
    return this.auth.issueToken(body.userId, body.ttlSeconds);
  }

  //1. Waits for the first event before sending headers, so a missing thread is a clean 404.
  //2. After that, errors arrive as ChatKit error events inside the stream.
  //3. A browser that leaves keeps the loop draining, so the cancel path saves what arrived.
  private async stream(events: AsyncGenerator<string>, response: Response) {
    const first = await events.next().catch(rethrow);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // Stops proxies such as nginx from holding events back.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    try {
      if (!first.done) response.write(first.value);
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        if (!response.writableEnded) response.write(next.value);
      }
    } catch (error) {
      this.logger.error({
        message: 'A ChatKit stream ended with an error.',
        error: error instanceof Error ? error.name : 'Error',
      });
    } finally {
      if (!response.writableEnded) response.end();
    }
  }

  private async signedAttachment(id: string, signature: string | undefined) {
    if (!this.auth.enabled)
      throw new UnauthorizedException(
        'ChatKit is off. Set CHATKIT_SECRET to turn it on.',
      );
    try {
      const found = await this.server.chatkitStore.loadAttachmentForLink(id);
      if (
        !signature ||
        !this.auth.verifyAttachment(id, found.userId, signature)
      )
        throw new NotFoundError('Attachment not found.');
      return found;
    } catch (error) {
      return rethrow(error);
    }
  }

  private checkPart(file: UploadedPart | undefined) {
    if (!file)
      throw new BadRequestException('Send the file in a field named file.');
    try {
      checkUpload(
        file.originalname,
        file.mimetype,
        file.size,
        this.server.chatkitAttachments.maxBytes,
      );
    } catch (error) {
      return rethrow(error);
    }
    return file;
  }
}

// The thread a streaming request belongs to, for the per-thread lock.
function threadIdOf(body: string) {
  try {
    const id = (JSON.parse(body) as { params?: { thread_id?: unknown } }).params
      ?.thread_id;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

// ChatKit errors become the HTTP errors the client expects.
function rethrow(error: unknown): never {
  if (error instanceof NotFoundError)
    throw new NotFoundException(error.message);
  if (error instanceof InvalidRequestError || error instanceof RangeError)
    throw new BadRequestException(error.message);
  throw error;
}
