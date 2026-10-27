import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { MonitoringService } from './monitoring.service.js';

@Module({
  controllers: [AdminController],
  providers: [MonitoringService],
})
export class AdminModule {}
