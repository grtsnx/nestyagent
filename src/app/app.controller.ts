import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { AppService } from './app.service.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

@Controller({ version: ['1', '2'] })
@ApiTags('Server')
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @ApiOperation({ summary: 'ping server' })
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @ApiOperation({ summary: 'Liveness check' })
  @SkipThrottle()
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @ApiOperation({ summary: 'Readiness check' })
  @SkipThrottle()
  @Get('health/ready')
  @HealthCheck({ swaggerDocumentation: false })
  async ready() {
    const result = await this.health.check([
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1_500_000_000),
    ]);
    return result.details;
  }
}
