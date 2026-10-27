import { Injectable, type NestMiddleware } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// The HTTP request id, readable anywhere inside that request, for example in a trace.
export const requestStore = new AsyncLocalStorage<{ requestId: string }>();

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
