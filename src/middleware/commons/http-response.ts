import { HttpException, HttpStatus } from '@nestjs/common';

export function statusType(statusCode: number): string {
  const name = HttpStatus[statusCode as HttpStatus];
  return typeof name === 'string' ? name : 'UNKNOWN';
}

export function httpResponse(
  statusCode: number,
  message: string,
  data?: unknown,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    statusCode,
    statusType: statusType(statusCode),
    message,
    ...metadata,
  };

  if (data !== undefined) {
    body.data = data;
  }

  return body;
}

export function describeException(exception: unknown): {
  statusCode: number;
  message: string;
  data?: unknown;
} {
  if (!(exception instanceof HttpException)) {
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }

  const statusCode = exception.getStatus();

  if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
    return {
      statusCode,
      message: 'Internal server error',
    };
  }

  const body = exception.getResponse();

  if (typeof body === 'string') {
    return { statusCode, message: body };
  }

  if (typeof body !== 'object' || body === null) {
    return { statusCode, message: exception.message };
  }

  const record = body as Record<string, unknown>;
  const rawMessage = record.message;
  const message = Array.isArray(rawMessage)
    ? rawMessage.map(String).join(', ')
    : typeof rawMessage === 'string'
      ? rawMessage
      : exception.message;

  if ('data' in record) {
    return { statusCode, message, data: record.data };
  }

  const rest = { ...record };
  delete rest.message;
  delete rest.error;
  delete rest.statusCode;

  return {
    statusCode,
    message,
    data: Object.keys(rest).length > 0 ? rest : undefined,
  };
}
