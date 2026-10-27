import { ConflictException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client.js';
import { Pool } from 'pg';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private client?: PrismaClient;
  private lockPool?: Pool;
  private readonly locks = new Set<AbortController>();

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
    for (const lock of this.locks) lock.abort(new Error('Application is shutting down.'));
    await this.client?.$disconnect();
    await this.lockPool?.end();
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

  // A dedicated connection holds a session lock, never a long-running SQL transaction.
  // PostgreSQL releases it when the connection dies. Callers must honour the signal
  // and make external side effects idempotent before retrying an interrupted operation.
  async withLock<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.lockPool ??= new Pool({
      connectionString: this.configService.getOrThrow<string>('DATABASE_URL').trim(),
      max: 10,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
    });
    const connection = await this.lockPool.connect();
    const controller = new AbortController();
    const lost = () => controller.abort(new Error('Database execution lock was lost.'));
    connection.on('error', lost);
    connection.on('end', lost);
    this.locks.add(controller);
    let held = false;
    let broken = false;
    try {
      const result = await connection.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key],
      );
      held = result.rows[0].locked;
      if (!held) throw new ConflictException('This operation is already running. Retry after it finishes.');
      const resultValue = await work(controller.signal);
      controller.signal.throwIfAborted();
      return resultValue;
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      this.locks.delete(controller);
      if (held && !controller.signal.aborted) {
        try { await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); }
        catch { broken = true; }
      }
      connection.removeListener('error', lost);
      connection.removeListener('end', lost);
      connection.release(broken || controller.signal.aborted);
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
