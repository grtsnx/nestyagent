import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
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
import type { Response } from 'express';
import {
  ChatKitAuth,
  ChatKitAuthGuard,
  ChatKitUploadGuard,
  ChatKitUploadInterceptor,
  checkUpload,
  type ChatKitContext,
  type ChatKitRequest,
  type ChatKitUploadRequest,
} from '@/config/chatkit/index.js';
import {
  ChatKitApprovalRecoveryDto,
  ChatKitRequestDto,
  ChatKitThreadOwnerDto,
  ChatKitThreadRecoveryDto,
  ChatKitTokenDto,
} from '@/dto/index.js';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  parseRequest,
  serialize,
} from '@/lib/chatkit/chatkit.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { AdminKeyGuard, ApiFailure, ApiSuccess, baseUrl } from '@/middleware';
import { AgenticChatKitService } from './chatkit.service.js';

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
    private readonly server: AgenticChatKitService,
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
    let parsed;
    try {
      parsed = parseRequest(body);
    } catch (error) {
      rethrow(error);
    }
    const createdThreadId =
      parsed.type === 'threads.create'
        ? this.server.chatkitStore.generateThreadId(request.chatkit!)
        : undefined;
    const threadId =
      createdThreadId ??
      ('thread_id' in parsed.params ? parsed.params.thread_id : undefined);
    let json: string | undefined;
    const run = async (lock?: AbortSignal) => {
      const signal = lock
        ? AbortSignal.any([disconnected.signal, lock])
        : disconnected.signal;
      const context: ChatKitContext = {
        ...request.chatkit!,
        signal,
        ...(createdThreadId && { createdThreadId }),
      };
      const result = await this.server
        .processRequest(parsed, context, signal)
        .catch(rethrow);
      if (!result.streaming) {
        json = result.json;
        return;
      }
      await this.stream(result.stream, response, (error) =>
        disconnected.abort(error),
      );
    };
    //1. One reply at a time per thread, across every server, so two messages never interleave.
    //2. The response finishes only after the lock is released, so the client's next request
    //   never finds this one still holding it.
    try {
      if (threadId) await this.prisma.withLock(`chatkit:${threadId}`, run);
      else await run();
    } finally {
      if (
        response.headersSent &&
        !response.writableEnded &&
        !response.destroyed
      )
        response.end();
    }
    if (json !== undefined)
      response.status(200).type('application/json').send(json);
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
      'https://api.agentic.io/v1/chatkit/attachments/atc_0123456789abcdef0123456789abcdef/content?sig=signature',
  })
  @ApiFailure(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'The uploaded file exceeds the configured upload limit.',
    'File too large.',
    '/v1/chatkit/attachments',
  )
  @UseGuards(ChatKitAuthGuard)
  @UseInterceptors(ChatKitUploadInterceptor)
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
    const saved = await store
      .saveUploadedAttachment(attachment, part.buffer, context)
      .catch(rethrow);
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
    'The upload link is invalid, expired, already used, or its attachment was deleted.',
    'Attachment not found.',
    '/v1/chatkit/attachments/atc_1/upload',
  )
  @ApiFailure(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'The uploaded file exceeds the configured upload limit.',
    'File too large.',
    '/v1/chatkit/attachments/atc_1/upload',
  )
  @UseGuards(ChatKitUploadGuard)
  @UseInterceptors(ChatKitUploadInterceptor)
  @Post('attachments/:id/upload')
  async finishUpload(
    @Param('id') id: string,
    @Query('sig') signature: string | undefined,
    @Req() request: ChatKitUploadRequest,
    @UploadedFile() file: UploadedPart | undefined,
    @Res() response: Response,
  ) {
    // ChatKitUploadGuard checked the signed link and loaded the waiting attachment.
    const found = request.upload!;
    const part = this.checkPart(file);
    if (part.size > found.size)
      throw new BadRequestException('The file is larger than announced.');
    const context: ChatKitContext = {
      userId: found.userId,
      baseUrl: baseUrl(request),
    };
    const saved = await this.server.chatkitStore
      .saveAttachmentContent(found.attachment, part.buffer, context)
      .catch(rethrow);
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
    const allowed = await this.signedAttachment(id, signature);
    const { attachment, content } = await this.server.chatkitStore
      .loadAttachmentContent(id, allowed.userId)
      .catch(rethrow);
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

  @ApiOperation({
    summary: 'Recover a paused chat',
    description:
      'An admin calls this after checking an interrupted browser tool or retry, to run it again or close it.',
  })
  @ApiSecurity('admin')
  @ApiSuccess('The chat can take new messages again.', {
    threadId: 'thr_0123456789abcdef0123456789abcdef',
    decision: 'cancel',
  })
  @ApiFailure(
    HttpStatus.BAD_REQUEST,
    'The note is blank, or a required field is missing.',
    'A reconciliation note is required.',
    '/v1/chatkit/threads/thr_1/recover',
  )
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'The chat does not exist for this user.',
    'Thread not found.',
    '/v1/chatkit/threads/thr_1/recover',
  )
  @ApiFailure(
    HttpStatus.CONFLICT,
    'The operation or attempt is no longer the interrupted one the admin checked.',
    'This operation changed since it was checked. Read it again.',
    '/v1/chatkit/threads/thr_1/recover',
  )
  @UseGuards(AdminKeyGuard)
  @HttpCode(HttpStatus.OK)
  @Post('threads/:threadId/recover')
  async recoverThread(
    @Param('threadId') threadId: string,
    @Body() body: ChatKitThreadRecoveryDto,
    @Req() request: ChatKitRequest,
  ) {
    await this.server
      .recoverOperation(
        threadId,
        {
          operationId: body.operationId,
          attempt: body.attempt,
          decision: body.decision,
          note: body.note,
        },
        { userId: body.userId, baseUrl: baseUrl(request) },
      )
      .catch(rethrow);
    return { threadId, operationId: body.operationId, decision: body.decision };
  }

  @ApiOperation({
    summary: 'Show a chat operation',
    description:
      'An admin reads the chat’s current browser tool or retry operation here, with the id and attempt that a recovery must name.',
  })
  @ApiSecurity('admin')
  @ApiSuccess(
    'This is the chat’s current operation, or null when it has none.',
    {
      id: '0192f1e2-0000-7000-8000-000000000003',
      kind: 'retry',
      itemId: 'msg_0123456789abcdef0123456789abcdef',
      status: 'recovery_required',
      attempt: 1,
    },
  )
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'The chat does not exist for this user.',
    'Thread not found.',
    '/v1/chatkit/threads/thr_1/operation',
  )
  @UseGuards(AdminKeyGuard)
  @Get('threads/:threadId/operation')
  async operation(
    @Param('threadId') threadId: string,
    @Query() query: ChatKitThreadOwnerDto,
    @Req() request: ChatKitRequest,
  ) {
    return await this.server
      .loadOperation(threadId, {
        userId: query.userId,
        baseUrl: baseUrl(request),
      })
      .catch(rethrow);
  }

  @ApiOperation({
    summary: 'Recover an approval',
    description:
      'An admin calls this after checking whether an interrupted approved action already happened, so the user can answer its card again.',
  })
  @ApiSecurity('admin')
  @ApiSuccess('The approval card is shown again with a new version.', {
    type: 'widget',
    id: 'msg_approval_0192f1e2000070008000000000000001_2',
    thread_id: 'thr_0123456789abcdef0123456789abcdef',
  })
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'The chat or the approval does not exist for this user.',
    'Approval not found.',
    '/v1/chatkit/threads/thr_1/approvals/0192f1e2-0000-7000-8000-000000000001/recover',
  )
  @ApiFailure(
    HttpStatus.BAD_REQUEST,
    'The run id is not a UUID, or the note is blank.',
    'The run id must be a UUID.',
    '/v1/chatkit/threads/thr_1/approvals/not-a-uuid/recover',
  )
  @ApiFailure(
    HttpStatus.CONFLICT,
    'The approval is not interrupted, or its version changed since the admin checked it.',
    'This approval changed since it was checked. Reload the approvals list.',
    '/v1/chatkit/threads/thr_1/approvals/0192f1e2-0000-7000-8000-000000000001/recover',
  )
  @UseGuards(AdminKeyGuard)
  @HttpCode(HttpStatus.OK)
  @Post('threads/:threadId/approvals/:runId/recover')
  async recoverApproval(
    @Param('threadId') threadId: string,
    @Param('runId') runId: string,
    @Body() body: ChatKitApprovalRecoveryDto,
    @Req() request: ChatKitRequest,
  ) {
    return await this.server
      .recoverApproval(
        threadId,
        runId,
        { version: body.version, note: body.note },
        { userId: body.userId, baseUrl: baseUrl(request) },
      )
      .catch(rethrow);
  }

  //1. Waits for the first event before sending headers, so a missing thread is a clean 404.
  //2. After that, errors arrive as ChatKit error events inside the stream.
  //3. A browser that leaves keeps the loop draining, so the cancel path saves what arrived.
  private async stream(
    events: AsyncGenerator<string>,
    response: Response,
    cancel: (error: unknown) => void = () => {},
  ) {
    const first = await events.next().catch(rethrow);
    try {
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      // Stops proxies such as nginx from holding events back.
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      if (!first.done) await this.writeEvent(response, first.value);
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        await this.writeEvent(response, next.value);
      }
    } catch (error) {
      cancel(error);
      this.logger.error({
        message: 'A ChatKit stream ended with an error.',
        error: error instanceof Error ? error.name : 'Error',
      });
      // Keep the thread lease through cancellation and partial-history persistence,
      // even when the socket fails before emitting its close event.
      try {
        while (!(await events.next()).done) {}
      } catch {
        // The cancelled run may reject after its own cleanup has completed.
      }
    } finally {
      // process() ends the response once the thread lock is released.
      await events.return(undefined);
    }
  }

  private async writeEvent(response: Response, value: string) {
    if (response.writableEnded || response.destroyed || response.write(value))
      return;
    await new Promise<void>((resolve) => {
      const done = () => {
        response.off('drain', done);
        response.off('close', done);
        response.off('error', done);
        resolve();
      };
      response.once('drain', done);
      response.once('close', done);
      response.once('error', done);
      if (
        response.writableEnded ||
        response.destroyed ||
        response.writableNeedDrain === false
      )
        done();
    });
  }

  private async signedAttachment(id: string, signature: string | undefined) {
    this.auth.assertEnabled();
    try {
      const found = await this.server.chatkitStore.loadAttachmentInfo(id);
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

// ChatKit errors become the HTTP errors the client expects.
function rethrow(error: unknown): never {
  if (error instanceof NotFoundError)
    throw new NotFoundException(error.message);
  if (error instanceof ConflictError)
    throw new ConflictException(error.message);
  if (error instanceof InvalidRequestError || error instanceof RangeError)
    throw new BadRequestException(error.message);
  throw error;
}
