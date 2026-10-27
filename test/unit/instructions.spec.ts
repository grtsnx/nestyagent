import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { defaultInstructions } from '@/config/instructions/index.js';
import { InstructionsService } from '@/lib/instructions/instructions.service.js';
import { AdminKeyGuard } from '@/middleware/guards/admin-key.guard.js';
import { fakePrisma } from './fake-prisma.js';

const DATABASE_URL = 'postgresql://localhost/test';

function service(env: Record<string, unknown> = { DATABASE_URL }) {
  const fake = fakePrisma();
  return {
    ...fake,
    instructions: new InstructionsService(fake.prisma, new ConfigService(env)),
  };
}

describe('InstructionsService', () => {
  it('ships the MsSuzie prompt as the default', async () => {
    const { instructions } = service();
    expect(defaultInstructions.mssuzie).toContain(
      'You are MsSuzie’s assistant',
    );
    await expect(instructions.get('mssuzie')).resolves.toMatchObject({
      source: 'default',
      version: null,
    });
  });

  it('creates, updates, and deletes a custom version, then falls back to the default', async () => {
    const { instructions } = service();
    const run = instructions.forAgent('mssuzie');

    await instructions.create('mssuzie', 'Be brief.');
    expect(await run()).toBe('Be brief.');
    await expect(instructions.get('mssuzie')).resolves.toMatchObject({
      source: 'custom',
      version: 1,
    });

    await instructions.update('mssuzie', 'Be kind and brief.', 1);
    expect(await run()).toBe('Be kind and brief.');

    await expect(instructions.remove('mssuzie', 2)).resolves.toMatchObject({
      source: 'default',
    });
    expect(await run()).toBe(defaultInstructions.mssuzie);
  });

  it('refuses a second create and a stale update or delete', async () => {
    const { instructions } = service();
    await instructions.create('mssuzie', 'One.');
    await expect(instructions.create('mssuzie', 'Two.')).rejects.toThrow(
      /already exist/,
    );
    await instructions.update('mssuzie', 'Two.', 1);
    await expect(instructions.update('mssuzie', 'Three.', 1)).rejects.toThrow(
      'These instructions changed. Reload version 2 and try again.',
    );
    await expect(instructions.remove('mssuzie', 1)).rejects.toThrow(
      /Reload version 2/,
    );
    await expect(instructions.update('menu', 'New.', 1)).rejects.toThrow(
      'No custom instructions named menu.',
    );
  });

  it('keeps custom-only instructions, and forgets them when deleted', async () => {
    const { instructions } = service();
    await instructions.create('menu', 'Answer about cakes.');
    expect((await instructions.list()).map((item) => item.name)).toEqual([
      'menu',
      'mssuzie',
    ]);
    await expect(instructions.remove('menu', 1)).resolves.toBeUndefined();
    await expect(instructions.get('menu')).rejects.toThrow(
      'No instructions named menu.',
    );
    expect(() => instructions.forAgent('menu')).toThrow(/default file/);
  });

  it('rejects names that are not simple slugs', async () => {
    const { instructions } = service();
    await expect(instructions.get('../etc/passwd')).rejects.toThrow(
      /lowercase letters/,
    );
  });

  it('uses the default and refuses writes without a database', async () => {
    const { instructions } = service({});
    expect(await instructions.forAgent('mssuzie')()).toBe(
      defaultInstructions.mssuzie,
    );
    await expect(instructions.create('mssuzie', 'Hi.')).rejects.toThrow(
      'Saving instructions needs DATABASE_URL.',
    );
  });

  it('keeps the last known text when the database is down', async () => {
    const { db, instructions } = service();
    await instructions.create('mssuzie', 'Saved text.');
    const run = instructions.forAgent('mssuzie');
    expect(await run()).toBe('Saved text.');

    vi.useFakeTimers({ now: Date.now() + 10_000 });
    try {
      vi.spyOn(db.instruction, 'findUnique').mockRejectedValue(
        new Error('ECONNREFUSED'),
      );
      expect(await run()).toBe('Saved text.');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AdminKeyGuard', () => {
  const KEY = 'k'.repeat(32);
  const context = (header?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          get: (name: string) => (name === 'x-admin-key' ? header : undefined),
        }),
      }),
    }) as unknown as ExecutionContext;

  it('keeps admin routes off until ADMIN_API_KEY is set', () => {
    const guard = new AdminKeyGuard(new ConfigService({}));
    expect(() => guard.canActivate(context(KEY))).toThrow(/routes are off/);
  });

  it('accepts only the matching key', () => {
    const guard = new AdminKeyGuard(new ConfigService({ ADMIN_API_KEY: KEY }));
    expect(guard.canActivate(context(KEY))).toBe(true);
    expect(() => guard.canActivate(context('wrong'))).toThrow(/x-admin-key/);
    expect(() => guard.canActivate(context())).toThrow(/x-admin-key/);
  });
});
