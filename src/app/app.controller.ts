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
    description: 'Returns a fixed greeting to confirm the API is reachable.',
  })
  @ApiSuccess('Server is reachable.', 'Hello World!')
  @ApiRateLimited('/v1')
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @ApiOperation({
    summary: 'Liveness check',
    description:
      'Process liveness for container health checks. Does not check the database.',
  })
  @ApiSuccess('Process is running.', { status: 'ok' })
  @SkipThrottle()
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @ApiOperation({
    summary: 'Readiness check',
    description:
      'Traffic readiness for load balancers: database connectivity and memory usage.',
  })
  @ApiSuccess('Database is reachable and memory usage is within limits.', {
    database: { status: 'up' },
    memory_heap: { status: 'up' },
    memory_rss: { status: 'up' },
  })
  @ApiFailure(
    HttpStatus.SERVICE_UNAVAILABLE,
    'Database is unreachable or memory usage is over its limit.',
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
