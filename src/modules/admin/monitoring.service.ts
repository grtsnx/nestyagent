import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60_000;

export type ListOptions = { limit?: number };

//1. Read-only numbers and lists for the admin routes. Nothing here changes data.
//2. No message text is read. Saved run state and machine claim tokens are never returned.
@Injectable()
export class MonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // Everything that needs a person, plus the last 24 hours at a glance.
  async overview() {
    const db = this.db();
    const since = new Date(Date.now() - DAY_MS);
    const [
      chats,
      chatsToday,
      messagesToday,
      approvalsWaiting,
      runsNeedingRecovery,
      webhooksRetrying,
      webhooksNeedingCheck,
      machinesNeedingCheck,
      runs,
    ] = await Promise.all([
      db.chat.count(),
      db.chat.count({ where: { createdAt: { gte: since } } }),
      db.chatItem.count({ where: { createdAt: { gte: since } } }),
      db.pausedRun.count({ where: { status: 'waiting' } }),
      db.pausedRun.count({
        where: { status: { in: ['recovery_required', 'taken'] } },
      }),
      db.hostedWebhook.count({
        where: { status: 'pending', attempts: { gt: 0 } },
      }),
      db.hostedWebhook.count({ where: { status: 'reconciliation' } }),
      db.remoteMachine.count({ where: { status: 'reconciliation' } }),
      this.runTotals(since),
    ]);
    return {
      needsAttention: {
        approvalsWaiting,
        runsNeedingRecovery,
        webhooksRetrying,
        webhooksNeedingCheck,
        machinesNeedingCheck,
      },
      last24Hours: { chats: chatsToday, messages: messagesToday, ...runs },
      totals: { chats },
    };
  }

  // Runs per day, with tokens, failures, and speed. days counts back from today (UTC).
  async usage(days = 14) {
    const db = this.db();
    const from = new Date(Date.now() - days * DAY_MS);
    const [daily, models] = await Promise.all([
      db.$queryRaw<UsageRow[]>`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               count(*) AS runs,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               coalesce(sum(input_tokens), 0) AS input_tokens,
               coalesce(sum(output_tokens), 0) AS output_tokens,
               coalesce(sum(cached_tokens), 0) AS cached_tokens,
               avg(duration_ms) AS average_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
        FROM agent_runs WHERE created_at >= ${from}
        GROUP BY 1 ORDER BY 1`,
      db.$queryRaw<UsageRow[]>`
        SELECT coalesce(model, 'unknown') AS model,
               count(*) AS runs,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               coalesce(sum(input_tokens), 0) AS input_tokens,
               coalesce(sum(output_tokens), 0) AS output_tokens,
               coalesce(sum(cached_tokens), 0) AS cached_tokens,
               avg(duration_ms) AS average_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
        FROM agent_runs WHERE created_at >= ${from}
        GROUP BY 1 ORDER BY runs DESC`,
    ]);
    return {
      days,
      daily: daily.map(({ day, ...row }) => ({ day, ...usageNumbers(row) })),
      models: models.map(({ model, ...row }) => ({
        model,
        ...usageNumbers(row),
      })),
    };
  }

  // Newest first. Filter by status, chat, or helper.
  async runs(
    options: ListOptions & {
      status?: 'completed' | 'waiting' | 'failed';
      chatId?: string;
      agent?: string;
    },
  ) {
    return await this.db().agentRun.findMany({
      where: {
        ...(options.status && { status: options.status }),
        ...(options.chatId && { chatId: options.chatId }),
        ...(options.agent && { agent: options.agent }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit(options),
    });
  }

  // Oldest first, so the longest wait is at the top. The saved run state is left out.
  async approvals(
    options: ListOptions & { status?: 'waiting' | 'recovery_required' },
  ) {
    const rows = await this.db().pausedRun.findMany({
      where: {
        status:
          options.status === 'recovery_required'
            ? { in: ['recovery_required', 'taken'] }
            : (options.status ?? 'waiting'),
      },
      orderBy: { createdAt: 'asc' },
      take: limit(options),
      select: {
        id: true,
        status: true,
        chatId: true,
        agentName: true,
        agentVersion: true,
        ownerId: true,
        recoveryNote: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((row) => ({ ...row, waitingMs: age(row.createdAt) }));
  }

  // Most recent first, with message count and last activity. No message text.
  async chats(options: ListOptions) {
    const rows = await this.db().$queryRaw<ChatRow[]>`
      SELECT c.id, c.created_at, c.updated_at, count(i.id) AS messages,
             (SELECT count(*) FROM agent_runs r WHERE r.chat_id = c.id) AS runs
      FROM chats c LEFT JOIN chat_items i ON i.chat_id = c.id
      GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ${limit(options)}`;
    return rows.map((row) => ({
      id: row.id,
      messages: Number(row.messages),
      runs: Number(row.runs),
      createdAt: row.created_at,
      lastActivityAt: row.updated_at,
    }));
  }

  // Lease tokens stay out. lastError is a short code, never the event body.
  async webhooks(
    options: ListOptions & {
      status?: 'pending' | 'processing' | 'completed' | 'reconciliation';
    },
  ) {
    return await this.db().hostedWebhook.findMany({
      where: { ...(options.status && { status: options.status }) },
      orderBy: { createdAt: 'desc' },
      take: limit(options),
      select: {
        id: true,
        type: true,
        resourceId: true,
        status: true,
        attempts: true,
        availableAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Claim tokens stay out.
  async machines(
    options: ListOptions & {
      status?: 'pending' | 'creating' | 'ready' | 'reconciliation' | 'deleted';
    },
  ) {
    return await this.db().remoteMachine.findMany({
      where: { ...(options.status && { status: options.status }) },
      orderBy: { updatedAt: 'desc' },
      take: limit(options),
      select: {
        sessionId: true,
        environmentId: true,
        provider: true,
        machineId: true,
        status: true,
        desiredState: true,
        lastError: true,
        claimedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  private async runTotals(since: Date) {
    const [row] = await this.db().$queryRaw<UsageRow[]>`
      SELECT count(*) AS runs,
             count(*) FILTER (WHERE status = 'failed') AS failed,
             coalesce(sum(input_tokens), 0) AS input_tokens,
             coalesce(sum(output_tokens), 0) AS output_tokens,
             coalesce(sum(cached_tokens), 0) AS cached_tokens,
             avg(duration_ms) AS average_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
      FROM agent_runs WHERE created_at >= ${since}`;
    return usageNumbers(row);
  }

  private db() {
    if (!this.config.get<string>('DATABASE_URL'))
      throw new ServiceUnavailableException('Monitoring needs DATABASE_URL.');
    return this.prisma.db;
  }
}

type UsageRow = {
  day?: string;
  model?: string;
  runs: bigint;
  failed: bigint;
  input_tokens: bigint;
  output_tokens: bigint;
  cached_tokens: bigint;
  average_ms: Prisma.Decimal | number | null;
  p95_ms: number | null;
};

type ChatRow = {
  id: string;
  created_at: Date;
  updated_at: Date;
  messages: bigint;
  runs: bigint;
};

// Postgres counts come back as big integers. cacheHitRate is cached input over all input.
function usageNumbers(row: UsageRow) {
  const input = Number(row.input_tokens);
  const cached = Number(row.cached_tokens);
  return {
    runs: Number(row.runs),
    failed: Number(row.failed),
    inputTokens: input,
    outputTokens: Number(row.output_tokens),
    cachedTokens: cached,
    cacheHitRate: input ? Math.round((cached / input) * 1000) / 1000 : 0,
    averageMs:
      row.average_ms === null ? null : Math.round(Number(row.average_ms)),
    p95Ms: row.p95_ms === null ? null : Math.round(Number(row.p95_ms)),
  };
}

function limit(options: ListOptions) {
  return Math.min(Math.max(options.limit ?? 50, 1), 200);
}

function age(from: Date) {
  return Date.now() - from.getTime();
}
