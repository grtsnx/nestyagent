import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ChatKitTokenDto {
  @ApiProperty({
    description:
      'This is the signed-in user’s stable id from your own login, never from the browser.',
    example: 'guardian-7',
  })
  @IsString()
  @Length(1, 128)
  userId: string;

  @ApiPropertyOptional({
    description:
      'This is how long the token works, from 60 seconds to one day.',
    example: 3600,
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86_400)
  ttlSeconds?: number;
}

export class ChatKitRequestDto {
  @ApiProperty({
    description: 'This is the ChatKit request type, such as threads.create.',
    example: 'threads.create',
  })
  type: string;

  @ApiProperty({
    description: 'These are the parameters for that request type.',
    example: {
      input: {
        content: [{ type: 'input_text', text: 'How much is tutoring?' }],
        attachments: [],
        inference_options: {},
      },
    },
  })
  params: Record<string, unknown>;
}
