import { Global, Module } from '@nestjs/common';
import { InstructionsService } from './instructions.service.js';

@Global()
@Module({
  providers: [InstructionsService],
  exports: [InstructionsService],
})
export class InstructionsModule {}
