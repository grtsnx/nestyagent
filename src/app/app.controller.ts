import { Controller, Get, HttpStatus } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { AppService } from './app.service.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { ApiFailure, ApiRateLimited, ApiSuccess } from '@/middleware';

@Controller({ version: ['1', '2'] })
@ApiTags('Server')
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @ApiOperation({
    summary: 'Ping the server',
    description:
      'This route returns a fixed greeting to confirm that the API is reachable.',
  })
  @ApiSuccess(
    'The server is reachable and answered the request.',
    'Hello World!',
  )
  @ApiRateLimited('/v1')
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @ApiOperation({
    summary: 'Liveness check',
    description:
      'This route tells your container platform whether the server process is running, without checking the database.',
  })
  @ApiSuccess('The server process is running.', { status: 'ok' })
  @SkipThrottle()
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @ApiOperation({
    summary: 'Readiness check',
    description:
      'This route tells your load balancer whether the server can take traffic by checking the database connection and memory usage.',
  })
  @ApiSuccess(
    'The database is reachable and memory usage is within its limits.',
    {
      database: { status: 'up' },
      memory_heap: { status: 'up' },
      memory_rss: { status: 'up' },
    },
  )
  @ApiFailure(
    HttpStatus.SERVICE_UNAVAILABLE,
    'The database is unreachable or memory usage is over its limit, so traffic should wait.',
    'Internal server error',
    '/v1/health/ready',
  )
  @SkipThrottle()
  @Get('health/ready')
  @HealthCheck({ swaggerDocumentation: false })
  async ready() {
    const result = await this.health.check([
      () => this.prisma.health(),
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1_500_000_000),
    ]);
    return result.details;
  }
}
