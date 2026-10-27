import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requestStore } from '@/lib/langfuse/langfuse.service.js';

const validRequestId = /^[A-Za-z0-9._-]{1,64}$/;

interface RequestWithId {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

interface ResponseWithHeader {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    request: RequestWithId,
    response: ResponseWithHeader,
    next: () => void,
  ): void {
    const supplied = request.headers['x-request-id'];
    const requestId =
      typeof supplied === 'string' && validRequestId.test(supplied)
        ? supplied
        : randomUUID();

    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    requestStore.run({ requestId }, () => next());
  }
}
