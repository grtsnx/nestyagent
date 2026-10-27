import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

const SAMPLE =
  'You are MsSuzie’s assistant. You speak for MsSuzie, a personal tutoring company.';

export class CreateSystemPromptDto {
  @ApiProperty({
    description: 'This is the full system prompt the helper follows.',
    example: SAMPLE,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200_000)
  content: string;
}

export class UpdateSystemPromptDto extends CreateSystemPromptDto {
  @ApiProperty({
    description:
      'This is the version you read, so an edit made since then is not overwritten.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  version: number;
}

export class SystemPromptVersionDto {
  @ApiProperty({
    description:
      'This is the version you read, so an edit made since then is not removed.',
    example: 2,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}
