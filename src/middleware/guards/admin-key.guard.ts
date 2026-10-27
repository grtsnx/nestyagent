import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const ADMIN_KEY_HEADER = 'x-admin-key';

//1. Admin routes need the x-admin-key header to match ADMIN_API_KEY.
//2. Without ADMIN_API_KEY the routes stay off, so nothing is exposed by accident.
//3. Both keys are hashed first, so the comparison takes the same time whatever is sent.
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const expected = this.config.get<string>('ADMIN_API_KEY');
    if (!expected)
      throw new ForbiddenException(
        'Admin routes are off. Set ADMIN_API_KEY to turn them on.',
      );
    const given =
      context.switchToHttp().getRequest<Request>().get(ADMIN_KEY_HEADER) ?? '';
    if (!timingSafeEqual(digest(given), digest(expected)))
      throw new UnauthorizedException(
        `A valid ${ADMIN_KEY_HEADER} header is required.`,
      );
    return true;
  }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}
