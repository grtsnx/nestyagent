import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/lib/prisma/prisma.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

describe('Composed persistence transactions', () => {
  const prisma = new PrismaService(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  );
  const ids: string[] = [];
  afterAll(async () => {
    await prisma.db.chat.deleteMany({ where: { id: { in: ids } } });
    await prisma.onModuleDestroy();
  });

  it('requires execution locks before opening a transaction', async () => {
    let executed = false;
    await expect(
      prisma.transaction(() =>
        prisma.withLock(`nested:${randomUUID()}`, async () => {
          executed = true;
        }),
      ),
    ).rejects.toThrow(/before.*transaction/i);
    expect(executed).toBe(false);
  });

  it('uses one connection and rolls nested writes back with their parent', async () => {
    const id = randomUUID();
    ids.push(id);
    await expect(
      prisma.transaction(async (outer) => {
        expect(prisma.connection === outer).toBe(true);
        await prisma.transaction(async (inner) => {
          expect(inner === outer).toBe(true);
          await inner.chat.create({ data: { id } });
        });
        expect(
          await prisma.connection.chat.findUnique({ where: { id } }),
        ).not.toBeNull();
        throw new Error('rollback parent');
      }),
    ).rejects.toThrow('rollback parent');
    expect(await prisma.db.chat.findUnique({ where: { id } })).toBeNull();
    expect(prisma.connection === prisma.db).toBe(true);
  });
});
