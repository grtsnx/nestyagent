import { ApiProperty } from '@nestjs/swagger';

export class HostedWebhookDto {
  @ApiProperty({ example: true })
  accepted: boolean;
}

export class HostedWebhookResponseDto {
  @ApiProperty({ example: 200 })
  statusCode: number;

  @ApiProperty({ example: 'OK' })
  statusType: string;

  @ApiProperty({ example: 'Success' })
  message: string;

  @ApiProperty({ type: HostedWebhookDto })
  data: HostedWebhookDto;
}
