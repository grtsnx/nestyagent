import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

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

// What every admin recovery needs: whose chat it is, and what the admin checked.
class ChatKitRecoveryDto {
  @ApiProperty({
    description: 'This is the id of the user who owns the chat.',
    example: 'guardian-7',
  })
  @IsString()
  @Length(1, 128)
  userId: string;

  @ApiProperty({
    description:
      'This note records what the admin checked, such as whether the order was really cancelled.',
    example: 'Checked the order system: order 42 was not cancelled.',
  })
  @IsString()
  @Length(1, 1000)
  note: string;
}

export class ChatKitThreadRecoveryDto extends ChatKitRecoveryDto {
  @ApiProperty({
    description:
      'This says whether to run the interrupted step again or to close it as cancelled.',
    enum: ['retry', 'cancel'],
    example: 'cancel',
  })
  @IsIn(['retry', 'cancel'])
  decision: 'retry' | 'cancel';
}

export class ChatKitApprovalRecoveryDto extends ChatKitRecoveryDto {
  @ApiProperty({
    description:
      'This is the checkpoint version the admin checked, from the admin approvals list.',
    example: 1,
  })
  @IsInt()
  @Min(0)
  version: number;
}
