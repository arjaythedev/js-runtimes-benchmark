import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

// Every error leaves as RealWorld's {"errors": {"body": [...]}} shape (docs: "Catch everything").
// 400s (malformed JSON from the body parser, failed validation) become 422, as RealWorld wants.
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let messages: string[] = ['internal error'];
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      const msg = typeof res === 'string' ? res : (res as { message?: unknown }).message;
      messages = Array.isArray(msg) ? msg.map(String) : [String(msg ?? exception.message)];
    } else if (typeof (exception as { statusCode?: unknown })?.statusCode === 'number') {
      // Errors thrown by the platform itself (e.g. Fastify's content-type parser).
      status = (exception as { statusCode: number }).statusCode;
      messages = [String((exception as Error).message)];
    } else {
      console.error(exception);
    }
    if (status === HttpStatus.BAD_REQUEST) status = HttpStatus.UNPROCESSABLE_ENTITY;
    httpAdapter.reply(ctx.getResponse(), { errors: { body: messages } }, status);
  }
}
