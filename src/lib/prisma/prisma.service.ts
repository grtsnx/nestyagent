import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client.js';
import type { Prisma } from '@/generated/prisma/client.js';

type ExecutionLease = {
  owner: string;
  keys: string[];
  controller: AbortController;
};

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private client?: PrismaClient;
  private readonly locks = new Set<AbortController>();
  private readonly logger = new Logger(PrismaService.name);
  private readonly execution = new AsyncLocalStorage<ExecutionLease[]>();
  private readonly transactions =
    new AsyncLocalStorage<Prisma.TransactionClient>();
  // A lock lives this long unless its owner renews it. A crashed owner frees it after this.
  lockTtlMs = 60_000;
  lockRenewMs = 15_000;

  constructor(private readonly configService: ConfigService) {}

  //1. The database client. It connects on first use, so the app starts without a database.
  //2. A feature that stores data throws here when DATABASE_URL is not set.
  get db() {
    this.client ??= new PrismaClient({
      adapter: new PrismaPg({
        connectionString: this.configService
          .getOrThrow<string>('DATABASE_URL')
          .trim(),
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
      }),
    });
    return this.client;
  }

  // Composed stores use the same connection, so their writes share one commit.
  get connection(): Prisma.TransactionClient {
    return this.transactions.getStore() ?? this.db;
  }

  async onModuleDestroy() {
    for (const lock of this.locks)
      lock.abort(new Error('Application is shutting down.'));
    await this.client?.$disconnect();
  }

  async health() {
    if (!this.configService.get<string>('DATABASE_URL')) {
      return { database: { status: 'up' as const, disabled: true } };
    }
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { database: { status: 'up' as const } };
    } catch {
      throw new ServiceUnavailableException('Database is unavailable.');
    }
  }

  // Lock ownership and protected writes commit together. A takeover waits for this short
  // transaction, and an expired owner cannot renew or write over its replacement.
  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const current = this.transactions.getStore();
    if (current) return work(current);
    const leases = this.execution.getStore() ?? [];
    return await this.db.$transaction((tx) =>
      this.transactions.run(tx, async () => {
        await this.assertOwnership(tx, leases);
        const result = await work(tx);
        await this.assertOwnership(tx, leases);
        return result;
      }),
    );
  }

  private async assertOwnership(
    tx: Prisma.TransactionClient,
    leases: ExecutionLease[],
  ) {
    for (const lease of leases) {
      lease.controller.signal.throwIfAborted();
      for (const key of lease.keys) {
        const rows = await tx.$queryRaw<
          Array<{ owner: string; valid: boolean }>
        >`
          SELECT owner, expires_at > clock_timestamp() AS valid
          FROM execution_locks WHERE key = ${key} FOR UPDATE`;
        if (rows[0]?.owner !== lease.owner || !rows[0]?.valid) {
          const error = new ConflictException(
            'Database execution lock was lost.',
          );
          lease.controller.abort(error);
          throw error;
        }
      }
    }
  }

  //1. A lock is a row in execution_locks with an expiry. No connection is held while work runs,
  //   so any number of chats can run at once.
  //2. The owner renews the row. If the row is lost, or cannot be renewed before it expires,
  //   the signal aborts. Callers must honour it and keep external side effects idempotent.
  //3. A crashed owner stops renewing, so its lock frees itself after lockTtlMs.
  async withLock<T>(
    key: string | string[],
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.transactions.getStore())
      throw new Error('Acquire execution locks before starting a transaction.');
    const keys = [...new Set(Array.isArray(key) ? key : [key])].sort();
    const owner = randomUUID();
    const controller = new AbortController();
    this.locks.add(controller);
    let held = 0;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let renewing = false;
    let released = false;
    const armDeadline = (started: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(
        () => controller.abort(new Error('Database execution lock expired.')),
        Math.max(0, this.lockTtlMs - (Date.now() - started)),
      );
      deadline.unref();
    };
    try {
      const acquiredAt = Date.now();
      for (const lockKey of keys) {
        const taken = await this.db.$executeRaw`
          INSERT INTO execution_locks (key, owner, expires_at)
          VALUES (${lockKey}, ${owner}::uuid, now() + ${this.lockTtlMs} * interval '1 millisecond')
          ON CONFLICT (key) DO UPDATE
            SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
            WHERE execution_locks.expires_at <= now()`;
        if (taken !== 1)
          throw new ConflictException(
            'This operation is already running. Retry after it finishes.',
          );
        held += 1;
      }
      armDeadline(acquiredAt);
      renewal = setInterval(() => {
        if (renewing || controller.signal.aborted) return;
        renewing = true;
        const started = Date.now();
        void this.db.$executeRaw`
          UPDATE execution_locks
          SET expires_at = clock_timestamp() + ${this.lockTtlMs} * interval '1 millisecond'
          WHERE owner = ${owner}::uuid AND expires_at > clock_timestamp()`
          .then((count) => {
            if (count !== held)
              controller.abort(new Error('Database execution lock was lost.'));
            else if (!released && !controller.signal.aborted)
              armDeadline(started);
          })
          // The independent deadline still aborts if renewals fail or remain pending.
          .catch(() => {})
          .finally(() => {
            renewing = false;
          });
      }, this.lockRenewMs);
      renewal.unref();
      const leases = [
        ...(this.execution.getStore() ?? []),
        { owner, keys, controller },
      ];
      return await this.execution.run(leases, async () => {
        await this.transaction(async () => {});
        const result = await work(controller.signal);
        await this.transaction(async () => {});
        return result;
      });
    } finally {
      released = true;
      clearInterval(renewal);
      clearTimeout(deadline);
      this.locks.delete(controller);
      if (held > 0) {
        // If this fails, the rows expire by themselves after lockTtlMs.
        await this.db.$executeRaw`
          DELETE FROM execution_locks WHERE owner = ${owner}::uuid`.catch(() =>
          this.logger.warn('An execution lock will be freed when it expires.'),
        );
      }
    }
  }
}

// Prisma's error code when a unique column already holds the value.
export function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
