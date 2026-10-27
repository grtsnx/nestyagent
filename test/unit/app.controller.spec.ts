import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { AppController } from '@/app/app.controller.js';
import { AppService } from '@/app/app.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';

describe('AppController', () => {
  let appController: AppController;
  let app: TestingModule;
  let databaseHealth: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    databaseHealth = vi.fn().mockResolvedValue({ database: { status: 'up' } });
    app = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [AppController],
      providers: [
        AppService,
        { provide: PrismaService, useValue: { health: databaseHealth } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('returns an in-process liveness result', () => {
      expect(appController.live()).toEqual({ status: 'ok' });
    });

    it('includes database health in readiness', async () => {
      await expect(appController.ready()).resolves.toEqual({
        database: { status: 'up' },
        memory_heap: { status: 'up' },
        memory_rss: { status: 'up' },
      });
    });

    it('allows database-free readiness when persistence is disabled', async () => {
      databaseHealth.mockResolvedValue({
        database: { status: 'up', disabled: true },
      });

      await expect(appController.ready()).resolves.toMatchObject({
        database: { status: 'up', disabled: true },
      });
    });

    it('rejects readiness when the configured database is unavailable', async () => {
      databaseHealth.mockRejectedValue(new ServiceUnavailableException());

      await expect(appController.ready()).rejects.toMatchObject({
        status: 503,
      });
    });

    it('remains live when the configured database is unavailable', () => {
      databaseHealth.mockRejectedValue(new ServiceUnavailableException());

      expect(appController.live()).toEqual({ status: 'ok' });
      expect(databaseHealth).not.toHaveBeenCalled();
    });
  });
});
