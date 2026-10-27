import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEnvironment } from '@/config/environment.js';
import { ChatKitAttachmentStore, ChatKitAuth } from '@/config/chatkit/index.js';
import { ChatKitUploadInterceptor } from '@/config/chatkit/chatkit.upload.js';
import type { PrismaService } from '@/lib/prisma/prisma.service.js';

afterEach(() => vi.unstubAllEnvs());

describe('ChatKit upload configuration', () => {
  it.each([
    [undefined, 10 * 1024 * 1024],
    ['', 10 * 1024 * 1024],
    ['   ', 10 * 1024 * 1024],
    ['1024', 1024],
    [1024, 1024],
  ])(
    'normalizes %j consistently for multipart and attachment validation',
    (value, expected) => {
      vi.stubEnv('CHATKIT_MAX_UPLOAD_BYTES', undefined);
      const config = new ConfigService({ CHATKIT_MAX_UPLOAD_BYTES: value });
      const files = new ChatKitAttachmentStore(
        {} as PrismaService,
        new ChatKitAuth(config),
        config,
      );
      expect(() => new ChatKitUploadInterceptor(config)).not.toThrow();
      expect(files.maxBytes).toBe(expected);
      expect(
        validateEnvironment({ CHATKIT_MAX_UPLOAD_BYTES: value })
          .CHATKIT_MAX_UPLOAD_BYTES,
      ).toBe(expected);
    },
  );

  it('initializes through ConfigModule with a blank environment variable', async () => {
    vi.stubEnv('CHATKIT_MAX_UPLOAD_BYTES', '');
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          validate: (values) =>
            validateEnvironment({
              CHATKIT_MAX_UPLOAD_BYTES: values.CHATKIT_MAX_UPLOAD_BYTES,
            }),
        }),
      ],
      providers: [ChatKitUploadInterceptor],
    }).compile();
    try {
      expect(module.get(ConfigService).get('CHATKIT_MAX_UPLOAD_BYTES')).toBe(
        10 * 1024 * 1024,
      );
      expect(module.get(ChatKitUploadInterceptor)).toBeInstanceOf(
        ChatKitUploadInterceptor,
      );
    } finally {
      await module.close();
    }
  });

  it.each([
    'garbage',
    '-1',
    '0',
    '1.5',
    'Infinity',
    String(50 * 1024 * 1024 + 1),
  ])('rejects invalid limit %s before accepting uploads', (value) => {
    const config = new ConfigService({ CHATKIT_MAX_UPLOAD_BYTES: value });
    const files = new ChatKitAttachmentStore(
      {} as PrismaService,
      new ChatKitAuth(config),
      config,
    );
    expect(() =>
      validateEnvironment({ CHATKIT_MAX_UPLOAD_BYTES: value }),
    ).toThrow();
    expect(() => new ChatKitUploadInterceptor(config)).toThrow();
    expect(() => files.maxBytes).toThrow();
  });
});
