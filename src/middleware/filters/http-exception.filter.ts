import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { describeException, httpResponse } from '../commons/http-response.js';

@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<{
      method?: string;
      originalUrl?: string;
      requestId?: string;
      url?: string;
    }>();
    const response = context.getResponse<unknown>();
    const { statusCode, message, data } = describeException(exception);
    const adapter = this.adapterHost.httpAdapter;

    if (!(exception instanceof HttpException)) {
      this.logger.error({
        error:
          exception instanceof Error
            ? {
                name: exception.name,
                message: exception.message,
                stack: exception.stack,
              }
            : String(exception),
        method: request.method,
        path: request.originalUrl ?? request.url,
        requestId: request.requestId,
      });
    }

    if (adapter.isHeadersSent(response)) return;

    adapter.reply(
      response,
      httpResponse(statusCode, message, data, {
        path: request.originalUrl ?? request.url,
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
      }),
      statusCode,
    );
  }
}
