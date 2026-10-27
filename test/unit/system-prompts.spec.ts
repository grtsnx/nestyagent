import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { defaultSystemPrompts } from '@/config/system-prompts/index.js';
import { SystemPromptsService } from '@/modules/system-prompts/system-prompts.service.js';
import { AdminKeyGuard } from '@/middleware/guards/admin-key.guard.js';
import { fakePrisma } from './fake-prisma.js';

const DATABASE_URL = 'postgresql://localhost/test';

function service(env: Record<string, unknown> = { DATABASE_URL }) {
  const fake = fakePrisma();
  return {
    ...fake,
    systemPrompts: new SystemPromptsService(
      fake.prisma,
      new ConfigService(env),
    ),
  };
}

describe('SystemPromptsService', () => {
  it('never reuses a deleted prompt revision for stale updates or deletes', async () => {
    const { systemPrompts } = service();
    const first = await systemPrompts.create('agentic', 'Original.');
    await systemPrompts.remove('agentic', first.version!);
    const replacement = await systemPrompts.create('agentic', 'Replacement.');
    expect(replacement.version).toBeGreaterThan(first.version!);
    await expect(
      systemPrompts.update('agentic', 'Stale edit.', first.version!),
    ).rejects.toThrow(/changed/);
    await expect(
      systemPrompts.remove('agentic', first.version!),
    ).rejects.toThrow(/changed/);
    expect((await systemPrompts.get('agentic')).content).toBe('Replacement.');
  });

  it('returns its own updated row when another writer edits immediately afterward', async () => {
    const { db, systemPrompts } = service();
    const first = await systemPrompts.create('agentic', 'Original.');
    let edited = false;
    const editAgain = async () => {
      if (edited) return;
      edited = true;
      const current = await systemPrompts.get('agentic');
      await systemPrompts.update('agentic', 'Writer B.', current.version!);
    };
    const update = db.systemPrompt.updateMany.bind(db.systemPrompt);
    vi.spyOn(db.systemPrompt, 'updateMany').mockImplementation(async (args) => {
      const result = await update(args);
      await editAgain();
      return result;
    });
    const query = db.$queryRaw.bind(db);
    vi.spyOn(db, '$queryRaw').mockImplementation(async (...args) => {
      const result = await query(...args);
      if (args[0].join(' ').includes('UPDATE system_prompts'))
        await editAgain();
      return result;
    });
    const result = await systemPrompts.update(
      'agentic',
      'Writer A.',
      first.version!,
    );
    expect(edited).toBe(true);
    expect(result.content).toBe('Writer A.');
    expect((await systemPrompts.get('agentic')).content).toBe('Writer B.');
  });

  it.each(['update', 'remove'] as const)(
    'discards an in-flight stale read after %s',
    async (operation) => {
      const { db, systemPrompts } = service();
      const first = await systemPrompts.create('agentic', 'Old.');
      const old = { ...db.systemPrompt.rows[0] };
      let finish!: (row: typeof old) => void;
      vi.spyOn(db.systemPrompt, 'findUnique').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = systemPrompts.content('agentic');
      if (operation === 'update')
        await systemPrompts.update('agentic', 'New.', first.version!);
      else await systemPrompts.remove('agentic', first.version!);
      finish(old);
      const expected =
        operation === 'update' ? 'New.' : defaultSystemPrompts.agentic;
      expect(await pending).toBe(expected);
      expect(await systemPrompts.content('agentic')).toBe(expected);
    },
  );

  it('does not treat inherited object properties as built-in prompts', async () => {
    const { systemPrompts } = service();
    await expect(systemPrompts.get('constructor')).rejects.toThrow(
      /No system prompt/,
    );
    expect(() => systemPrompts.forAgent('constructor')).toThrow(/default file/);
    const custom = await systemPrompts.create(
      'constructor',
      'A custom prompt.',
    );
    await expect(
      systemPrompts.remove('constructor', custom.version!),
    ).resolves.toBeUndefined();
  });

  it('ships the Agentic prompt as the default', async () => {
    const { systemPrompts } = service();
    expect(defaultSystemPrompts.agentic).toContain(
      'You are Agentic’s assistant',
    );
    await expect(systemPrompts.get('agentic')).resolves.toMatchObject({
      source: 'default',
      version: null,
    });
  });

  it('creates, updates, and deletes a custom version, then falls back to the default', async () => {
    const { systemPrompts } = service();
    const run = systemPrompts.forAgent('agentic');

    await systemPrompts.create('agentic', 'Be brief.');
    expect(await run()).toBe('Be brief.');
    await expect(systemPrompts.get('agentic')).resolves.toMatchObject({
      source: 'custom',
      version: 1,
    });

    await systemPrompts.update('agentic', 'Be kind and brief.', 1);
    expect(await run()).toBe('Be kind and brief.');

    await expect(systemPrompts.remove('agentic', 2)).resolves.toMatchObject({
      source: 'default',
    });
    expect(await run()).toBe(defaultSystemPrompts.agentic);
  });

  it('refuses a second create and a stale update or delete', async () => {
    const { systemPrompts } = service();
    await systemPrompts.create('agentic', 'One.');
    await expect(systemPrompts.create('agentic', 'Two.')).rejects.toThrow(
      /already exist/,
    );
    await systemPrompts.update('agentic', 'Two.', 1);
    await expect(systemPrompts.update('agentic', 'Three.', 1)).rejects.toThrow(
      'This system prompt changed. Reload version 2 and try again.',
    );
    await expect(systemPrompts.remove('agentic', 1)).rejects.toThrow(
      /Reload version 2/,
    );
    await expect(systemPrompts.update('menu', 'New.', 1)).rejects.toThrow(
      'No custom system prompt named menu.',
    );
  });

  it('keeps a custom-only system prompt, and forgets it when deleted', async () => {
    const { systemPrompts } = service();
    await systemPrompts.create('menu', 'Answer about cakes.');
    expect((await systemPrompts.list()).map((item) => item.name)).toEqual([
      'agentic',
      'menu',
    ]);
    await expect(systemPrompts.remove('menu', 1)).resolves.toBeUndefined();
    await expect(systemPrompts.get('menu')).rejects.toThrow(
      'No system prompt named menu.',
    );
    expect(() => systemPrompts.forAgent('menu')).toThrow(/default file/);
  });

  it('rejects names that are not simple slugs', async () => {
    const { systemPrompts } = service();
    await expect(systemPrompts.get('../etc/passwd')).rejects.toThrow(
      /lowercase letters/,
    );
  });

  it('uses the default and refuses writes without a database', async () => {
    const { systemPrompts } = service({});
    expect(await systemPrompts.forAgent('agentic')()).toBe(
      defaultSystemPrompts.agentic,
    );
    await expect(systemPrompts.create('agentic', 'Hi.')).rejects.toThrow(
      'Saving a system prompt needs DATABASE_URL.',
    );
  });

  it('keeps the last known text when the database is down', async () => {
    const { db, systemPrompts } = service();
    await systemPrompts.create('agentic', 'Saved text.');
    const run = systemPrompts.forAgent('agentic');
    expect(await run()).toBe('Saved text.');

    vi.useFakeTimers({ now: Date.now() + 10_000 });
    try {
      vi.spyOn(db.systemPrompt, 'findUnique').mockRejectedValue(
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
