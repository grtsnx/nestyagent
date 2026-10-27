import { Global, Module } from '@nestjs/common';
import { ComposioService } from './composio.service.js';

@Global()
@Module({
  providers: [ComposioService],
  exports: [ComposioService],
})
export class ComposioModule {}
