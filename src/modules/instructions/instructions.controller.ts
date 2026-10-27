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
  CreateInstructionDto,
  InstructionVersionDto,
  UpdateInstructionDto,
} from '@/dto/index.js';
import { InstructionsService } from '@/lib/index.js';
import { AdminKeyGuard, ApiFailure, ApiSuccess } from '@/middleware';

const PATH = '/v1/instructions/mssuzie';
const SAMPLE = 'You are MsSuzie’s assistant. You speak for MsSuzie...';
const custom = {
  name: 'mssuzie',
  content: SAMPLE,
  source: 'custom',
  version: 2,
  updatedAt: '2026-10-27T09:00:00.000Z',
};
const fallback = {
  name: 'mssuzie',
  content: SAMPLE,
  source: 'default',
  version: null,
  updatedAt: null,
};

@ApiTags('Instructions')
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
@Controller({ path: 'instructions', version: '1' })
export class InstructionsController {
  constructor(private readonly instructions: InstructionsService) {}

  @ApiOperation({
    summary: 'List instructions',
    description:
      'This route lists every helper’s instructions and says whether each one is custom or the default.',
  })
  @ApiSuccess('These are the instructions each helper uses now.', [fallback])
  @Get()
  list() {
    return this.instructions.list();
  }

  @ApiOperation({
    summary: 'Get instructions',
    description:
      'This route returns the instructions a helper uses now, which is the custom version when one exists.',
  })
  @ApiSuccess('These are the instructions the helper uses now.', custom)
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'No custom version or default exists for this name.',
    'No instructions named mssuzie.',
    PATH,
  )
  @Get(':name')
  get(@Param('name') name: string) {
    return this.instructions.get(name);
  }

  @ApiOperation({
    summary: 'Create custom instructions',
    description:
      'This route saves a custom version that replaces the default from the next message on.',
  })
  @ApiSuccess(
    'The custom version was saved as version 1.',
    { ...custom, version: 1 },
    HttpStatus.CREATED,
  )
  @ApiFailure(
    HttpStatus.CONFLICT,
    'A custom version already exists, so it must be updated instead.',
    'Custom instructions named mssuzie already exist. Update them instead.',
    PATH,
  )
  @Post(':name')
  create(@Param('name') name: string, @Body() body: CreateInstructionDto) {
    return this.instructions.create(name, body.content);
  }

  @ApiOperation({
    summary: 'Update instructions',
    description:
      'This route replaces the custom version when the version you send is still the latest one.',
  })
  @ApiSuccess('The custom version was saved with a new version number.', custom)
  @ApiFailure(
    HttpStatus.CONFLICT,
    'Someone saved a newer version since you read it, so reload and try again.',
    'These instructions changed. Reload version 3 and try again.',
    PATH,
  )
  @ApiFailure(
    HttpStatus.NOT_FOUND,
    'No custom version exists yet, so it must be created first.',
    'No custom instructions named mssuzie.',
    PATH,
  )
  @Put(':name')
  update(@Param('name') name: string, @Body() body: UpdateInstructionDto) {
    return this.instructions.update(name, body.content, body.version);
  }

  @ApiOperation({
    summary: 'Restore default instructions',
    description:
      'This route deletes the custom version, so the helper goes back to its default instructions.',
  })
  @ApiSuccess(
    'The custom version was deleted and the default is in use again.',
    fallback,
  )
  @ApiFailure(
    HttpStatus.CONFLICT,
    'Someone saved a newer version since you read it, so reload and try again.',
    'These instructions changed. Reload version 3 and try again.',
    PATH,
  )
  @HttpCode(HttpStatus.OK)
  @Delete(':name')
  remove(@Param('name') name: string, @Query() query: InstructionVersionDto) {
    return this.instructions.remove(name, query.version);
  }
}
