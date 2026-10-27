import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client.js';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private client?: PrismaClient;

  constructor(private readonly configService: ConfigService) {}

  //1. The database client. It connects on first use, so the app starts without a database.
  //2. A feature that stores data throws here when DATABASE_URL is not set.
  get db() {
    this.client ??= new PrismaClient({
      adapter: new PrismaPg({
        connectionString: this.configService
          .getOrThrow<string>('DATABASE_URL')
          .trim(),
      }),
    });
    return this.client;
  }

  async onModuleDestroy() {
    await this.client?.$disconnect();
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
