import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { SandboxService } from './sandbox.service.js';

@Controller({ path: 'sandbox', version: '1' })
@ApiTags('Sandbox')
export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  // OpenAI calls this when a self-hosted session needs a machine, and when that session fails.
  @ApiOperation({ summary: 'Create or delete a self-hosted machine' })
  @SkipThrottle()
  @Post('hosted-webhook')
  @HttpCode(200)
  async hostedWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) throw new UnauthorizedException('Missing webhook body.');
    await this.sandbox.handleHostedWebhook(rawBody, headers);
    return { accepted: true };
  }
}
