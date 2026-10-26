import {
  Controller,
  Get,
  type INestApplication,
  MiddlewareConsumer,
  Module,
  RequestMethod,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter, RequestIdMiddleware } from '@/middleware';

class ThrowingMiddleware implements NestMiddleware {
  use(): void {
    throw new Error('sensitive middleware detail');
  }
}

@Controller()
class TestController {
  @Get('middleware-error')
  get(): never {
    throw new Error('controller should not run');
  }
}

@Module({
  controllers: [TestController],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
class MiddlewareErrorModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, ThrowingMiddleware)
      .forRoutes({ path: 'middleware-error', method: RequestMethod.GET });
  }
}

describe('global middleware error handling (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const fixture = await Test.createTestingModule({
      imports: [MiddlewareErrorModule],
    }).compile();
    app = fixture.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('sanitizes an exception thrown before route selection', async () => {
    const response = await request(app.getHttpServer())
      .get('/middleware-error')
      .set('x-request-id', 'middleware-test')
      .expect(500);

    expect(response.body).toMatchObject({
      statusCode: 500,
      statusType: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      path: '/middleware-error',
      requestId: 'middleware-test',
    });
    expect(JSON.stringify(response.body)).not.toContain('sensitive');
  });
});
