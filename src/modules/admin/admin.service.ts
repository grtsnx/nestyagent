import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PausedRun } from '@/generated/prisma/client.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60_000;
const RECOVERY_REQUIRED = Prisma.sql`
  p.status IN ('recovery_required', 'taken') OR (
    p.status = 'running' AND NOT EXISTS (
      SELECT 1 FROM execution_locks l
      WHERE l.key = 'run:' || p.id::text AND l.expires_at > clock_timestamp()
    )
  )`;
const USAGE_TOTALS = Prisma.sql`
  count(*) AS runs,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  coalesce(sum(input_tokens), 0) AS input_tokens,
  coalesce(sum(output_tokens), 0) AS output_tokens,
  coalesce(sum(cached_tokens), 0) AS cached_tokens,
  avg(duration_ms) AS average_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms`;

export type ListOptions = { limit?: number };

//1. Read-only numbers and lists for the admin routes. Nothing here changes data.
//2. No message text is read. Saved run state and machine claim tokens are never returned.
@Injectable()
export class AdminService {
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
      this.recoveryCount(),
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
               ${USAGE_TOTALS}
        FROM agent_runs WHERE created_at >= ${from}
        GROUP BY 1 ORDER BY 1`,
      db.$queryRaw<UsageRow[]>`
        SELECT coalesce(model, 'unknown') AS model,
               ${USAGE_TOTALS}
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
    const filter =
      options.status === 'recovery_required'
        ? RECOVERY_REQUIRED
        : Prisma.sql`p.status = 'waiting'`;
    const rows = await this.db().$queryRaw<ApprovalRow[]>`
      SELECT p.id, p.status, p.chat_id AS "chatId", p.agent_name AS "agentName",
             p.agent_version AS "agentVersion", p.owner_id AS "ownerId",
             p.recovery_note AS "recoveryNote", p.created_at AS "createdAt",
             p.updated_at AS "updatedAt"
      FROM paused_runs p WHERE ${filter}
      ORDER BY p.created_at ASC, p.id ASC LIMIT ${limit(options)}`;
    return rows.map((row) => ({ ...row, waitingMs: age(row.createdAt) }));
  }

  // Most recent first, with message count and last activity. No message text.
  async chats(options: ListOptions) {
    const rows = await this.db().$queryRaw<ChatRow[]>`
      SELECT c.id, c.created_at, c.updated_at,
             (SELECT count(*) FROM chat_items i WHERE i.chat_id = c.id) AS messages,
             (SELECT count(*) FROM agent_runs r WHERE r.chat_id = c.id) AS runs
      FROM (SELECT id, created_at, updated_at FROM chats
            ORDER BY updated_at DESC, id ASC LIMIT ${limit(options)}) c
      ORDER BY c.updated_at DESC, c.id ASC`;
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
      SELECT ${USAGE_TOTALS}
      FROM agent_runs WHERE created_at >= ${since}`;
    return usageNumbers(row);
  }

  private async recoveryCount() {
    const [row] = await this.db().$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM paused_runs p WHERE ${RECOVERY_REQUIRED}`;
    return Number(row.count);
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

type ApprovalRow = Pick<
  PausedRun,
  | 'id'
  | 'status'
  | 'chatId'
  | 'agentName'
  | 'agentVersion'
  | 'ownerId'
  | 'recoveryNote'
  | 'createdAt'
  | 'updatedAt'
>;

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
