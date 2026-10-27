import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  ApprovalsQueryDto,
  ListQueryDto,
  MachinesQueryDto,
  RunsQueryDto,
  UsageQueryDto,
  WebhooksQueryDto,
} from '@/dto/index.js';
import { AdminService } from './admin.service.js';
import { AdminKeyGuard, ApiFailure, ApiSuccess } from '@/middleware';

const PATH = '/v1/admin/overview';
const TIME = '2026-10-27T09:00:00.000Z';
const usage = {
  runs: 120,
  failed: 2,
  inputTokens: 480000,
  outputTokens: 36000,
  cachedTokens: 360000,
  cacheHitRate: 0.75,
  averageMs: 3200,
  p95Ms: 7400,
};

@ApiTags('Admin')
@ApiSecurity('admin')
@UseGuards(AdminKeyGuard)
@ApiFailure(
  HttpStatus.UNAUTHORIZED,
  'The x-admin-key header is missing or does not match ADMIN_API_KEY.',
  'A valid x-admin-key header is required.',
  PATH,
)
@ApiFailure(
  HttpStatus.FORBIDDEN,
  'ADMIN_API_KEY is not set, so these routes are off.',
  'Admin routes are off. Set ADMIN_API_KEY to turn them on.',
  PATH,
)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @ApiOperation({
    summary: 'Monitoring overview',
    description:
      'This route shows what needs a person now and how the helpers did in the last 24 hours.',
  })
  @ApiSuccess('These are the current counts and the last 24 hours.', {
    needsAttention: {
      approvalsWaiting: 3,
      runsNeedingRecovery: 0,
      webhooksRetrying: 1,
      webhooksNeedingCheck: 0,
      machinesNeedingCheck: 0,
    },
    last24Hours: { chats: 18, messages: 240, ...usage },
    totals: { chats: 1250 },
  })
  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @ApiOperation({
    summary: 'Daily usage',
    description:
      'This route shows runs, failures, tokens, cache hits, and speed per day and per model.',
  })
  @ApiSuccess('These are the totals per day and per model.', {
    days: 14,
    daily: [{ day: '2026-10-27', ...usage }],
    models: [{ model: 'gpt-6-astra', ...usage }],
  })
  @Get('usage')
  usage(@Query() query: UsageQueryDto) {
    return this.admin.usage(query.days);
  }

  @ApiOperation({
    summary: 'List helper runs',
    description:
      'This route lists recent helper runs with their tokens, time, result, and trace id.',
  })
  @ApiSuccess('These are the most recent runs, newest first.', [
    {
      id: '0192f1e2-0000-7000-8000-000000000001',
      chatId: 'chat-c-42',
      conversationType: 'chat',
      agent: 'Agentic',
      model: 'gpt-6-astra',
      userId: 'guardian-7',
      status: 'completed',
      error: null,
      requests: 2,
      inputTokens: 5200,
      outputTokens: 310,
      cachedTokens: 4096,
      durationMs: 2800,
      traceId: 'trace_0123456789abcdef0123456789abcdef',
      requestId: '6f1c2b9e-4d3a-4c8b-9e2f-1a7d5b3c8e40',
      createdAt: TIME,
    },
  ])
  @Get('runs')
  runs(@Query() query: RunsQueryDto) {
    return this.admin.runs(query);
  }

  @ApiOperation({
    summary: 'List paused runs',
    description:
      'This route lists runs waiting for a person to approve, or left by a crash for checking, oldest first.',
  })
  @ApiSuccess('These are the paused runs, with how long each has waited.', [
    {
      id: '0192f1e2-0000-7000-8000-000000000002',
      status: 'waiting',
      chatId: 'chat-c-42',
      chatkitThreadId: null,
      version: 0,
      agentName: 'Agentic',
      agentVersion: 'orders-v1',
      ownerId: 'guardian-7',
      recoveryNote: null,
      createdAt: TIME,
      updatedAt: TIME,
      waitingMs: 540000,
    },
  ])
  @Get('approvals')
  approvals(@Query() query: ApprovalsQueryDto) {
    return this.admin.approvals(query);
  }

  @ApiOperation({
    summary: 'List recent chats',
    description:
      'This route lists recent database chats and ChatKit threads with their message and run counts, without any message text.',
  })
  @ApiSuccess('These are the most recently active chats.', [
    {
      id: 'chat-c-42',
      conversationType: 'chat',
      messages: 12,
      runs: 6,
      createdAt: TIME,
      lastActivityAt: TIME,
    },
  ])
  @Get('chats')
  chats(@Query() query: ListQueryDto) {
    return this.admin.chats(query);
  }

  @ApiOperation({
    summary: 'List webhook events',
    description:
      'This route lists OpenAI webhook events with their state, attempts, and last error code.',
  })
  @ApiSuccess('These are the most recent webhook events.', [
    {
      id: 'evt_685343a1381c819085d44c354e1b330e',
      type: 'agent.session.action_required',
      resourceId: 'sess_68534389f1a48190b0a5a3bbf0a1d3e4',
      status: 'pending',
      attempts: 2,
      availableAt: TIME,
      lastError: 'processing_failed',
      createdAt: TIME,
      updatedAt: TIME,
    },
  ])
  @Get('webhooks')
  webhooks(@Query() query: WebhooksQueryDto) {
    return this.admin.webhooks(query);
  }

  @ApiOperation({
    summary: 'List self-hosted machines',
    description:
      'This route lists self-hosted machines with their provider, state, and last error code.',
  })
  @ApiSuccess('These are the most recently changed machines.', [
    {
      sessionId: 'sess_68534389f1a48190b0a5a3bbf0a1d3e4',
      environmentId: 'env_68534389f1a48190b0a5a3bbf0a1d3e4',
      provider: 'digitalocean',
      machineId: 'digitalocean:do_1',
      status: 'ready',
      desiredState: 'active',
      lastError: null,
      claimedAt: TIME,
      createdAt: TIME,
      updatedAt: TIME,
    },
  ])
  @Get('machines')
  machines(@Query() query: MachinesQueryDto) {
    return this.admin.machines(query);
  }
}
