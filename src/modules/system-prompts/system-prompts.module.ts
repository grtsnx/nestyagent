import { Module } from '@nestjs/common';
import { SystemPromptsController } from './system-prompts.controller.js';
import { SystemPromptsService } from './system-prompts.service.js';

@Module({
  controllers: [SystemPromptsController],
  providers: [SystemPromptsService],
  // Import this module to give a helper its editable system prompt with forAgent.
  exports: [SystemPromptsService],
})
export class SystemPromptsModule {}
