import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { baseUrl } from '@/middleware';

const AUDIENCE = 'chatkit';
const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
// A BCP 47 tag like "en", "fr-FR", or "yo-NG". Anything else is ignored.
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Who is asking, from a verified token. Every store call is scoped to userId.
export type ChatKitContext = {
  userId: string;
  // From Accept-Language, which the ChatKit client always sends.
  locale?: string;
  // The public address the request came from, for file links.
  baseUrl: string;
  // Aborts when the browser disconnects or the user stops the reply.
  signal?: AbortSignal;
  // Allocated and locked by the controller before a new thread is published.
  createdThreadId?: string;
};

export type ChatKitRequest = Request & { chatkit?: ChatKitContext };

//1. User tokens and file links for ChatKit, signed with CHATKIT_SECRET (HMAC-SHA256).
//2. A token is a standard HS256 JWT with sub (the user id), aud "chatkit", iat, and exp.
@Injectable()
export class ChatKitAuth {
  constructor(private readonly config: ConfigService) {}

  get enabled() {
    return Boolean(this.config.get<string>('CHATKIT_SECRET'));
  }

  // Short-lived, so a leaked token stops working soon. Default one hour, at most one day.
  issueToken(userId: string, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + Math.min(Math.max(ttlSeconds, 60), MAX_TTL_SECONDS);
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({ sub: userId, aud: AUDIENCE, iat: now, exp });
    const signature = this.sign(`${header}.${payload}`);
    return {
      token: `${header}.${payload}.${signature}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  // The user id inside a valid, unexpired token, or undefined.
  verifyToken(token: string): string | undefined {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [header, payload, signature] = parts;
    if (!safeEqual(signature, this.sign(`${header}.${payload}`)))
      return undefined;
    try {
      const head = decode(header) as { alg?: unknown };
      const claims = decode(payload) as {
        sub?: unknown;
        aud?: unknown;
        exp?: unknown;
      };
      if (
        head.alg !== 'HS256' ||
        claims.aud !== AUDIENCE ||
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        typeof claims.exp !== 'number' ||
        claims.exp * 1000 <= Date.now()
      )
        return undefined;
      return claims.sub;
    } catch {
      return undefined;
    }
  }

  // A signature that ties a file link to its attachment and owner. It does not expire,
  // so images in old chats keep working. Deleting the attachment makes the link fail.
  signAttachment(attachmentId: string, userId: string) {
    return this.sign(`attachment:${attachmentId}:${userId}`);
  }

  verifyAttachment(attachmentId: string, userId: string, signature: string) {
    return safeEqual(signature, this.signAttachment(attachmentId, userId));
  }

  issueUpload(attachmentId: string, userId: string) {
    const payload = encode({
      purpose: 'attachment-upload',
      id: attachmentId,
      userId,
      exp: Math.floor(Date.now() / 1000) + 15 * 60,
    });
    return `${payload}.${this.sign(`upload:${payload}`)}`;
  }

  verifyUpload(attachmentId: string, token: string): string | undefined {
    const [payload, signature, ...extra] = token.split('.');
    if (
      !payload ||
      !signature ||
      extra.length ||
      !safeEqual(signature, this.sign(`upload:${payload}`))
    )
      return undefined;
    try {
      const claims = decode(payload) as {
        purpose?: unknown;
        id?: unknown;
        userId?: unknown;
        exp?: unknown;
      };
      if (
        claims.purpose !== 'attachment-upload' ||
        claims.id !== attachmentId ||
        typeof claims.userId !== 'string' ||
        !claims.userId ||
        typeof claims.exp !== 'number' ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp * 1000 <= Date.now()
      )
        return undefined;
      return claims.userId;
    } catch {
      return undefined;
    }
  }

  private sign(value: string) {
    const secret = this.config.get<string>('CHATKIT_SECRET');
    if (!secret)
      throw new ForbiddenException(
        'ChatKit is off. Set CHATKIT_SECRET to turn it on.',
      );
    return createHmac('sha256', secret).update(value).digest('base64url');
  }
}

//1. ChatKit routes need Authorization: Bearer <token> from POST /v1/chatkit/tokens.
//2. Without CHATKIT_SECRET the routes stay off.
@Injectable()
export class ChatKitAuthGuard implements CanActivate {
  constructor(private readonly auth: ChatKitAuth) {}

  canActivate(context: ExecutionContext) {
    if (!this.auth.enabled)
      throw new ForbiddenException(
        'ChatKit is off. Set CHATKIT_SECRET to turn it on.',
      );
    const request = context.switchToHttp().getRequest<ChatKitRequest>();
    const header = request.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const userId = token ? this.auth.verifyToken(token) : undefined;
    if (!userId)
      throw new UnauthorizedException('A valid ChatKit token is required.');
    request.chatkit = {
      userId,
      locale: requestLocale(request),
      baseUrl: baseUrl(request),
    };
    return true;
  }
}

function requestLocale(request: Request) {
  const first = request
    .get('accept-language')
    ?.split(',')[0]
    ?.split(';')[0]
    ?.trim();
  return first && LOCALE.test(first) ? first : undefined;
}

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
