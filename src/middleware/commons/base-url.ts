import type { Request } from 'express';

// The public address a request came from. Behind a proxy like Coolify, the forwarded
// headers give the https address callers used. Only use it for links shown back to them.
export function baseUrl(request: Request) {
  const first = (header: string) =>
    request.get(header)?.split(',')[0]?.trim() || undefined;
  const protocol = first('x-forwarded-proto') ?? request.protocol;
  const host = first('x-forwarded-host') ?? request.get('host');
  return `${protocol}://${host}`;
}
