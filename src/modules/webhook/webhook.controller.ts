import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
  ApiConsumes,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { HostedWebhookResponseDto } from '@/dto/index.js';
import { SandboxService } from '@/lib/index.js';

@ApiTags('Webhook')
@Controller({ path: 'webhook', version: '1' })
export class WebhookController {
  constructor(private readonly sandbox: SandboxService) {}

  // OpenAI calls this when a self-hosted session needs a machine, and when that session fails.
  @ApiOperation({
    summary: 'Queue self-hosted environment lifecycle work',
    description:
      'Verifies the OpenAI webhook signature and persists supported events before acknowledging them. A background worker provisions machines and retries cleanup.',
  })
  @ApiConsumes('application/json')
  @ApiHeader({ name: 'webhook-id', required: true })
  @ApiHeader({ name: 'webhook-timestamp', required: true })
  @ApiHeader({ name: 'webhook-signature', required: true })
  @ApiOkResponse({ type: HostedWebhookResponseDto })
  @ApiUnauthorizedResponse({
    description:
      'The webhook signature was rejected or the signing secret is missing.',
  })
  @SkipThrottle()
  @Post()
  @HttpCode(200)
  async hostedWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<HostedWebhookResponseDto['data']> {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) throw new UnauthorizedException('Missing webhook body.');
    await this.sandbox.handleHostedWebhook(rawBody, headers);
    return { accepted: true };
  }
}
