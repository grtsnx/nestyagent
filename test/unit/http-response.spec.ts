import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { describeException, httpResponse, statusType } from '@/middleware';

describe('HTTP response helpers', () => {
  it('maps known and unknown status codes', () => {
    expect(statusType(HttpStatus.BAD_REQUEST)).toBe('BAD_REQUEST');
    expect(statusType(599)).toBe('UNKNOWN');
  });

  it('omits undefined response data', () => {
    expect(httpResponse(200, 'Success')).toEqual({
      statusCode: 200,
      statusType: 'OK',
      message: 'Success',
    });
  });

  it('keeps structured validation details', () => {
    expect(
      describeException(
        new BadRequestException({
          message: ['email must be an email', 'name should not be empty'],
          error: 'Bad Request',
          statusCode: 400,
        }),
      ),
    ).toEqual({
      statusCode: 400,
      message: 'email must be an email, name should not be empty',
    });
  });

  it('redacts messages and arbitrary data from HTTP 5xx exceptions', () => {
    expect(
      describeException(
        new InternalServerErrorException({
          message: 'database failed',
          password: 'secret',
        }),
      ),
    ).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('sanitizes unexpected exceptions', () => {
    expect(describeException(new Error('database password leaked'))).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
  });
});
