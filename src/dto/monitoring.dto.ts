import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListQueryDto {
  @ApiPropertyOptional({
    description: 'This is how many rows to return, from 1 to 200.',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class RunsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    description: 'This keeps only runs that ended this way.',
    enum: ['completed', 'waiting', 'failed'],
  })
  @IsOptional()
  @IsIn(['completed', 'waiting', 'failed'])
  status?: 'completed' | 'waiting' | 'failed';

  @ApiPropertyOptional({
    description: 'This keeps only runs from one chat.',
    example: 'chat-c-42',
  })
  @IsOptional()
  @IsString()
  chatId?: string;

  @ApiPropertyOptional({
    description: 'This keeps only runs of one helper.',
    example: 'Agentic',
  })
  @IsOptional()
  @IsString()
  agent?: string;
}

export class ApprovalsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    description:
      'This picks runs waiting for a person, or runs a crash left for checking.',
    enum: ['waiting', 'recovery_required'],
    default: 'waiting',
  })
  @IsOptional()
  @IsIn(['waiting', 'recovery_required'])
  status?: 'waiting' | 'recovery_required';
}

export class WebhooksQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    description: 'This keeps only events in this state.',
    enum: ['pending', 'processing', 'completed', 'reconciliation'],
  })
  @IsOptional()
  @IsIn(['pending', 'processing', 'completed', 'reconciliation'])
  status?: 'pending' | 'processing' | 'completed' | 'reconciliation';
}

export class MachinesQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    description: 'This keeps only machines in this state.',
    enum: ['pending', 'creating', 'ready', 'reconciliation', 'deleted'],
  })
  @IsOptional()
  @IsIn(['pending', 'creating', 'ready', 'reconciliation', 'deleted'])
  status?: 'pending' | 'creating' | 'ready' | 'reconciliation' | 'deleted';
}

export class UsageQueryDto {
  @ApiPropertyOptional({
    description: 'This is how many days back to count, from 1 to 90.',
    example: 14,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}
