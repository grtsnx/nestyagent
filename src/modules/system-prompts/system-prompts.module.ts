import { Module } from '@nestjs/common';
import { InstructionsController } from './instructions.controller.js';

@Module({
  controllers: [InstructionsController],
})
export class InstructionsModule {}
