import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client.js';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private client?: PrismaClient;
  private readonly locks = new Set<AbortController>();
  private readonly logger = new Logger(PrismaService.name);
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

  //1. A lock is a row in execution_locks with an expiry. No connection is held while work runs,
  //   so any number of chats can run at once.
  //2. The owner renews the row. If the row is lost, or cannot be renewed before it expires,
  //   the signal aborts. Callers must honour it and keep external side effects idempotent.
  //3. A crashed owner stops renewing, so its lock frees itself after lockTtlMs.
  async withLock<T>(
    key: string | string[],
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(Array.isArray(key) ? key : [key])].sort();
    const owner = randomUUID();
    const controller = new AbortController();
    this.locks.add(controller);
    let held = 0;
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
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
      let renewedAt = Date.now();
      renewal = setInterval(() => {
        void this.db.$executeRaw`
          UPDATE execution_locks
          SET expires_at = now() + ${this.lockTtlMs} * interval '1 millisecond'
          WHERE owner = ${owner}::uuid`
          .then((count) => {
            if (count !== held)
              controller.abort(new Error('Database execution lock was lost.'));
            else renewedAt = Date.now();
          })
          .catch(() => {
            // One failed renewal is fine. Stop only when the lock may already have expired.
            if (Date.now() - renewedAt >= this.lockTtlMs - this.lockRenewMs)
              controller.abort(
                new Error('Database execution lock could not be renewed.'),
              );
          });
      }, this.lockRenewMs);
      renewal.unref();
      const result = await work(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      clearInterval(renewal);
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
