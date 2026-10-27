import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { HostedWebhookDto } from '@/dto/index.js';
import { ApiFailure, ApiSuccess } from '@/middleware';
import { SandboxService } from '@/lib/index.js';

@ApiTags('Webhook')
@Controller({ path: 'webhook', version: '1' })
export class WebhookController {
  constructor(private readonly sandbox: SandboxService) {}

  // OpenAI calls this when a self-hosted session needs a machine, and when that session fails.
  @ApiOperation({
    summary: 'OpenAI self-hosted webhook',
    description:
      'OpenAI calls this route to start a self-hosted machine when a session needs one and to delete it when the session fails or its environment expires.',
  })
  @ApiConsumes('application/json')
  @ApiHeader({
    name: 'webhook-id',
    required: true,
    description:
      'This is the delivery id, which stays the same when OpenAI repeats a delivery.',
  })
  @ApiHeader({
    name: 'webhook-timestamp',
    required: true,
    description: 'This is the time OpenAI sent the event, in Unix seconds.',
  })
  @ApiHeader({
    name: 'webhook-signature',
    required: true,
    description:
      'This is the OpenAI signature, which the server verifies with OPENAI_WEBHOOK_SECRET.',
  })
  @ApiBody({
    description: 'This is the event exactly as OpenAI sends it.',
    schema: {
      type: 'object',
      example: {
        id: 'evt_685343a1381c819085d44c354e1b330e',
        object: 'event',
        created_at: 1761555600,
        type: 'agent.session.action_required',
        data: {
          id: 'sess_68534389f1a48190b0a5a3bbf0a1d3e4',
          required_action: { type: 'environment_connection' },
        },
      },
    },
  })
  @ApiSuccess(
    'The event was stored, or it was a repeat or an event type this server ignores.',
    {
      accepted: true,
    },
  )
  @ApiFailure(
    HttpStatus.UNAUTHORIZED,
    'The signature is invalid or OPENAI_WEBHOOK_SECRET is missing, so OpenAI will retry the delivery.',
    'Webhook signature was rejected.',
    '/v1/webhook',
  )
  @SkipThrottle()
  @Post()
  @HttpCode(200)
  async hostedWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<HostedWebhookDto> {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) throw new UnauthorizedException('Missing webhook body.');
    await this.sandbox.handleHostedWebhook(rawBody, headers);
    return { accepted: true };
  }
}
