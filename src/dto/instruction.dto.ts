import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

const SAMPLE =
  'You are MsSuzie’s assistant. You speak for MsSuzie, a personal tutoring company.';

export class CreateInstructionDto {
  @ApiProperty({
    description: 'This is the full instructions text the helper follows.',
    example: SAMPLE,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200_000)
  content: string;
}

export class UpdateInstructionDto extends CreateInstructionDto {
  @ApiProperty({
    description:
      'This is the version you read, so an edit made since then is not overwritten.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  version: number;
}

export class InstructionVersionDto {
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
