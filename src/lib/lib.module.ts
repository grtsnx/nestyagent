import { Module } from '@nestjs/common';
import { OpenaiModule } from './openai/openai.module.js';

@Module({
  imports: [OpenaiModule],
  exports: [OpenaiModule],
})
export class LibModule {}
