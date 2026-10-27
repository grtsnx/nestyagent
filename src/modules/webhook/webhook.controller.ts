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
    summary: 'OpenAI webhook for self-hosted environments',
    description: [
      'Signed OpenAI events that start and delete self-hosted machines. Called by OpenAI, not by clients.',
      '',
      '- `agent.session.action_required`: machine start for a session that needs one.',
      '- `agent.session.failed`: machine deletion for a failed session.',
      '- `agent.environment.expired`: permanent machine deletion for an expired environment.',
      '',
      'Events are verified with `OPENAI_WEBHOOK_SECRET`, stored before the reply, and processed by a background worker. Repeat deliveries are processed once; other event types are accepted and ignored.',
    ].join('\n'),
  })
  @ApiConsumes('application/json')
  @ApiHeader({
    name: 'webhook-id',
    required: true,
    description: 'Delivery id. Repeat deliveries keep the same id.',
  })
  @ApiHeader({
    name: 'webhook-timestamp',
    required: true,
    description: 'Send time, in Unix seconds.',
  })
  @ApiHeader({
    name: 'webhook-signature',
    required: true,
    description: 'OpenAI signature, verified with OPENAI_WEBHOOK_SECRET.',
  })
  @ApiBody({
    description: 'OpenAI event payload.',
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
  @ApiSuccess('Event stored, or a repeat or ignored event.', {
    accepted: true,
  })
  @ApiFailure(
    HttpStatus.UNAUTHORIZED,
    'Invalid signature or missing OPENAI_WEBHOOK_SECRET. OpenAI retries the delivery.',
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
