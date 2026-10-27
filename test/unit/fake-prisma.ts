import type { PrismaService } from '@/lib/prisma/prisma.service.js';
import { ConflictException } from '@nestjs/common';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

// Equality per field, plus { lt: Date } for the claim age check.
function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR')
      return (expected as Where[]).some((clause) => matches(row, clause));
    if (key === 'AND')
      return (expected as Where[]).every((clause) => matches(row, clause));
    if (key === 'chatId_operationId') return matches(row, expected as Where);
    if (expected && typeof expected === 'object') {
      if ('lt' in expected)
        return (row[key] as Date) < (expected as { lt: Date }).lt;
      if ('lte' in expected)
        return (row[key] as Date) <= (expected as { lte: Date }).lte;
      if ('gte' in expected)
        return (row[key] as number) >= (expected as { gte: number }).gte;
      // A JSON path filter, like { item: { path: ['role'], equals: 'user' } }.
      if ('path' in expected) {
        const { path, equals } = expected as {
          path: string[];
          equals: unknown;
        };
        let value: unknown = row[key];
        for (const step of path)
          value = (value as Record<string, unknown> | undefined)?.[step];
        return value === equals;
      }
      if ('in' in expected)
        return (expected as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === expected;
  });
}

// One table. Each write is applied whole, like one SQL statement.
class Table {
  rows: Row[] = [];
  private nextId = 1;

  constructor(
    private readonly unique: string[],
    private readonly defaults: () => Row = () => ({}),
  ) {}

  async create({ data }: { data: Row }) {
    for (const key of this.unique) {
      if (this.rows.some((row) => row[key] === data[key])) {
        throw Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        });
      }
    }
    const row = { id: this.nextId++, ...this.defaults(), ...data };
    this.rows.push(row);
    return row;
  }

  async createMany({ data }: { data: Row[] }) {
    for (const row of data) await this.create({ data: row });
    return { count: data.length };
  }

  async findMany(args: {
    where?: Where;
    orderBy?: Record<string, 'asc' | 'desc'>;
    take?: number;
  }) {
    const rows = this.rows.filter((row) => matches(row, args.where));
    const ordering = Object.entries(args.orderBy ?? {})[0];
    if (ordering)
      rows.sort((a, b) => {
        const [key, direction] = ordering;
        const comparison =
          (a[key] as number) < (b[key] as number)
            ? -1
            : a[key] === b[key]
              ? 0
              : 1;
        return direction === 'asc' ? comparison : -comparison;
      });
    return args.take === undefined ? rows : rows.slice(0, args.take);
  }

  async findFirst(args: { where?: Where; orderBy?: { id: 'asc' | 'desc' } }) {
    return (await this.findMany({ ...args, take: 1 }))[0] ?? null;
  }

  async findUnique({ where }: { where: Where }) {
    return this.rows.find((row) => matches(row, where)) ?? null;
  }

  async findUniqueOrThrow({ where }: { where: Where }) {
    const row = await this.findUnique({ where });
    if (!row) throw new Error('No row found.');
    return row;
  }

  async upsert({
    where,
    create,
    update,
  }: {
    where: Where;
    create: Row;
    update: Row;
  }) {
    const row = await this.findUnique({ where });
    if (!row) return await this.create({ data: create });
    return Object.assign(row, update);
  }

  async updateMany({ where, data }: { where: Where; data: Row }) {
    const hits = this.rows.filter((row) => matches(row, where));
    for (const row of hits)
      for (const [key, value] of Object.entries(data)) {
        row[key] =
          value && typeof value === 'object' && 'increment' in value
            ? Number(row[key] ?? 0) + Number(value.increment)
            : value;
      }
    return { count: hits.length };
  }

  async deleteMany({ where }: { where: Where }) {
    const gone = this.rows.filter((row) => matches(row, where));
    this.rows = this.rows.filter((row) => !gone.includes(row));
    this.onDelete(gone);
    return { count: gone.length };
  }

  // Set by the parent table, like ON DELETE CASCADE.
  onDelete: (rows: Row[]) => void = () => {};
}

type FakeDb = {
  chat: Table;
  chatItem: Table;
  pausedRun: Table;
  remoteMachine: Table;
  hostedWebhook: Table;
  chatHistoryOperation: Table;
  expiredEnvironment: Table;
  $queryRaw(sql: TemplateStringsArray, chatId: string): Promise<Row[]>;
  $transaction<T>(
    work: ((tx: FakeDb) => Promise<T>) | Promise<unknown>[],
  ): Promise<T>;
};

//1. An in-memory stand-in for PrismaService, for unit tests without Postgres.
//2. $transaction puts every row back when the callback throws, like a rollback.
//3. Deleting a chat deletes its items, like the foreign key does.
export function fakePrisma() {
  const db: FakeDb = {
    chat: new Table(['id']),
    chatItem: new Table([]),
    pausedRun: new Table(['id'], () => ({
      id: crypto.randomUUID(),
      status: 'waiting',
      version: 0,
      chatId: null,
      ownerId: null,
      agentName: null,
      agentVersion: null,
      runOptions: null,
    })),
    remoteMachine: new Table(['sessionId', 'environmentId'], () => ({
      claimedAt: new Date(),
      machineId: null,
      provider: null,
      status: 'pending',
      desiredState: 'active',
    })),
    hostedWebhook: new Table(['id'], () => ({
      status: 'pending',
      attempts: 0,
      availableAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    chatHistoryOperation: new Table([]),
    expiredEnvironment: new Table(['environmentId'], () => ({
      expiredAt: new Date(),
    })),

    // Only the chat pop query is used: remove and return the newest item of one chat.
    async $queryRaw(_sql: TemplateStringsArray, chatId: string) {
      const rows = db.chatItem.rows.filter((row) => row.chatId === chatId);
      const newest = rows.at(-1);
      if (!newest) return [];
      db.chatItem.rows = db.chatItem.rows.filter((row) => row !== newest);
      return [{ item: newest.item }];
    },

    // The list form takes calls that already ran, so it only waits for them.
    async $transaction(work) {
      if (Array.isArray(work)) return (await Promise.all(work)) as never;
      const tables = [
        db.chat,
        db.chatItem,
        db.pausedRun,
        db.remoteMachine,
        db.hostedWebhook,
        db.chatHistoryOperation,
        db.expiredEnvironment,
      ];
      const saved = tables.map((table) =>
        table.rows.map((row) => ({ ...row })),
      );
      try {
        return await work(db);
      } catch (error) {
        tables.forEach((table, index) => (table.rows = saved[index]));
        throw error;
      }
    },
  };
  db.chat.onDelete = (chats) => {
    const ids = chats.map((chat) => chat.id);
    db.chatItem.rows = db.chatItem.rows.filter(
      (row) => !ids.includes(row.chatId),
    );
  };
  const locks = new Set<string>();
  const withLock = async <T>(
    key: string | string[],
    work: (signal: AbortSignal) => Promise<T>,
  ) => {
    const keys = Array.isArray(key) ? key : [key];
    if (keys.some((entry) => locks.has(entry)))
      throw new ConflictException('This operation is already running.');
    keys.forEach((entry) => locks.add(entry));
    try {
      return await work(new AbortController().signal);
    } finally {
      keys.forEach((entry) => locks.delete(entry));
    }
  };
  return { db, prisma: { db, withLock } as unknown as PrismaService };
}
