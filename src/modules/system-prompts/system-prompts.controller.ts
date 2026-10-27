import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  CreateSystemPromptDto,
  SystemPromptVersionDto,
  UpdateSystemPromptDto,
} from '@/dto/index.js';
import { SystemPromptsService } from './system-prompts.service.js';
import { AdminKeyGuard, ApiFailure, ApiSuccess } from '@/middleware';

const PATH = '/v1/system-prompts/agentic';
const SAMPLE = 'You are Agentic’s assistant. You speak for Agentic...';
const custom = {
  name: 'agentic',
  content: SAMPLE,
  source: 'custom',
  version: 2,
  updatedAt: '2026-10-27T09:00:00.000Z',
};
const fallback = {
  name: 'agentic',
  content: SAMPLE,
  source: 'default',
  version: null,
  updatedAt: null,
};

@ApiTags('System prompts')
@ApiSecurity('admin')
@UseGuards(AdminKeyGuard)
@ApiFailure(
  HttpStatus.UNAUTHORIZED,
  'The x-admin-key header is missing or does not match ADMIN_API_KEY.',
  'A valid x-admin-key header is required.',
  PATH,
)
@ApiFailure(
  HttpStatus.FORBIDDEN,
  'ADMIN_API_KEY is not set, so these routes are off.',
  'Admin routes are off. Set ADMIN_API_KEY to turn them on.',
  PATH,
)
@Controller({ path: 'system-prompts', version: '1' })
export class SystemPromptsController {
  constructor(private readonly systemPrompts: SystemPromptsService) {}

  @ApiOperation({
    summary: 'List system prompts',
    description:
      'This route lists every helper’s system prompt and says whether each one is custom or the default.',
  })
  @ApiSuccess('These are the system prompts each helper uses now.', [fallback])
  @Get()
  list() {
    return this.systemPrompts.list();
  }

  @ApiOperation({
    summary: 'Get system prompt',
    description:
      'This route returns the system prompt a helper uses now, which is the custom version when one exists.',
  })
  @ApiSuccess('This is the system prompt the helper uses now.', custom)
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'No custom version or default exists for this name.',
    'No system prompt named agentic.',
    PATH,
  )
  @Get(':name')
  get(@Param('name') name: string) {
    return this.systemPrompts.get(name);
  }

  @ApiOperation({
    summary: 'Create custom system prompt',
    description:
      'This route saves a custom version that replaces the default from the next message on.',
  })
  @ApiSuccess(
    'The custom version was saved with a new revision number.',
    { ...custom, version: 1 },
    HttpStatus.CREATED,
  )
  @ApiFailure(
    HttpStatus.CONFLICT,
    'A custom version already exists, so it must be updated instead.',
    'A custom system prompt named agentic already exists. Update it instead.',
    PATH,
  )
  @Post(':name')
  create(@Param('name') name: string, @Body() body: CreateSystemPromptDto) {
    return this.systemPrompts.create(name, body.content);
  }

  @ApiOperation({
    summary: 'Update system prompt',
    description:
      'This route replaces the custom version when the version you send is still the latest one.',
  })
  @ApiSuccess('The custom version was saved with a new version number.', custom)
  @ApiFailure(
    HttpStatus.CONFLICT,
    'Someone saved a newer version since you read it, so reload and try again.',
    'This system prompt changed. Reload version 3 and try again.',
    PATH,
  )
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'No custom version exists yet, so it must be created first.',
    'No custom system prompt named agentic.',
    PATH,
  )
  @Put(':name')
  update(@Param('name') name: string, @Body() body: UpdateSystemPromptDto) {
    return this.systemPrompts.update(name, body.content, body.version);
  }

  @ApiOperation({
    summary: 'Restore default system prompt',
    description:
      'This route deletes the custom version, so the helper goes back to its default system prompt.',
  })
  @ApiSuccess(
    'The custom version was deleted and the default is in use again.',
    fallback,
  )
  @ApiFailure(
    HttpStatus.CONFLICT,
    'Someone saved a newer version since you read it, so reload and try again.',
    'This system prompt changed. Reload version 3 and try again.',
    PATH,
  )
  @HttpCode(HttpStatus.OK)
  @Delete(':name')
  remove(@Param('name') name: string, @Query() query: SystemPromptVersionDto) {
    return this.systemPrompts.remove(name, query.version);
  }
}
