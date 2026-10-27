import { HttpStatus } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { httpResponse } from './http-response.js';

// Examples are built by the same httpResponse the app replies with, so the docs cannot drift.
const EXAMPLE_REQUEST_ID = '6f1c2b9e-4d3a-4c8b-9e2f-1a7d5b3c8e40';
const EXAMPLE_TIME = '2026-10-27T09:00:00.000Z';

// A successful reply: data is wrapped in statusCode, statusType, and message.
export function ApiSuccess(
  description: string,
  data: unknown,
  status: HttpStatus = HttpStatus.OK,
) {
  return ApiResponse({
    status,
    description,
    example: httpResponse(status, 'Success', data),
  });
}

// An error reply, with the path, request id, and time every error carries.
export function ApiFailure(
  status: HttpStatus,
  description: string,
  message: string,
  path: string,
) {
  return ApiResponse({
    status,
    description,
    example: httpResponse(status, message, undefined, {
      path,
      requestId: EXAMPLE_REQUEST_ID,
      timestamp: EXAMPLE_TIME,
    }),
  });
}

// The rate limit every route shares, unless it skips throttling.
export function ApiRateLimited(path: string) {
  return ApiFailure(
    HttpStatus.TOO_MANY_REQUESTS,
    'Rate limit exceeded: over 100 requests per minute from this address.',
    'ThrottlerException: Too Many Requests',
    path,
  );
}
