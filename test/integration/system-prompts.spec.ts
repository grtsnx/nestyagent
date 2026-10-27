import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { SystemPromptsService } from '@/modules/system-prompts/system-prompts.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable, migrated test database.',
  );

describe('System prompt revisions in Postgres', () => {
  const config = new ConfigService({ DATABASE_URL: databaseUrl });
  const prisma = new PrismaService(config);
  const prompts = new SystemPromptsService(prisma, config);
  const otherReplica = new SystemPromptsService(prisma, config);
  const names: string[] = [];
  const name = () => {
    const value = `test-${randomUUID()}`;
    names.push(value);
    return value;
  };

  afterAll(async () => {
    await prisma.db.systemPrompt.deleteMany({ where: { name: { in: names } } });
    await prisma.onModuleDestroy();
  });

  it('rejects stale revisions after a prompt is deleted and recreated', async () => {
    const key = name();
    const original = await prompts.create(key, 'Original.');
    await prompts.remove(key, original.version!);
    const replacement = await otherReplica.create(key, 'Replacement.');
    expect(replacement.version).toBeGreaterThan(original.version!);
    await expect(
      prompts.update(key, 'Stale edit.', original.version!),
    ).rejects.toThrow(/changed/);
    await expect(prompts.remove(key, original.version!)).rejects.toThrow(
      /changed/,
    );
    expect((await prompts.get(key)).content).toBe('Replacement.');
  });

  it('allows only one concurrent update with the same revision', async () => {
    const key = name();
    const original = await prompts.create(key, 'Original.');
    const results = await Promise.allSettled([
      prompts.update(key, 'Writer A.', original.version!),
      otherReplica.update(key, 'Writer B.', original.version!),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await prompts.get(key)).toEqual(winners[0].value);
    expect(winners[0].value.version).toBeGreaterThan(original.version!);
  });
});
