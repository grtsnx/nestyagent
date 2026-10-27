import { ApiProperty } from '@nestjs/swagger';

// What the webhook route returns inside data.
export class HostedWebhookDto {
  @ApiProperty({ example: true })
  accepted: boolean;
}
