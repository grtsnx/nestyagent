import type { PrismaService } from '@/lib/prisma/prisma.service.js';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

// Equality per field, plus { lt: Date } for the claim age check.
function matches(row: Row, where: Where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'lt' in expected) {
      const limit = (expected as { lt: Date }).lt;
      return row[key] instanceof Date && row[key] < limit;
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
    orderBy?: { id: 'asc' | 'desc' };
    take?: number;
  }) {
    const rows = this.rows.filter((row) => matches(row, args.where));
    if (args.orderBy?.id === 'desc') rows.reverse();
    return args.take === undefined ? rows : rows.slice(0, args.take);
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
    for (const row of hits) Object.assign(row, data);
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
    })),
    remoteMachine: new Table(['sessionId', 'environmentId'], () => ({
      claimedAt: new Date(),
      machineId: null,
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
      const tables = [db.chat, db.chatItem, db.pausedRun, db.remoteMachine];
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
  return { db, prisma: { db } as unknown as PrismaService };
}
