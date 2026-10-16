import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { type Request, type Response } from 'express';
import { I18nService } from 'nestjs-i18n';

import { resolveLanguage } from '../i18n/language';
import { requestIdOf } from '../request-id/request-id';
import { DomainException } from './domain.exception';
import { codeForStatus, type ErrorCode, PROBLEM_TYPE_BASE } from './error-codes';
import { type ProblemDetails, type ProblemExtensions, type ProblemFieldError } from './problem-details.dto';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

interface NormalisedError {
  code: ErrorCode;
  status: number;
  params: Record<string, string | number>;
  errors?: ProblemFieldError[];
  extensions?: ProblemExtensions;
  headers: Record<string, string>;
}

/**
 * Renders every error as RFC 9457 problem details (contract §3), localised by `Accept-Language`.
 * Internal messages and stack traces never reach the client; 5xx are logged and sent to Sentry.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const error = this.normalise(exception);

    if (error.status >= 500) {
      this.logger.error({ err: exception, code: error.code }, 'Unhandled error');
      Sentry.captureException(exception);
    }

    const lang = resolveLanguage(req.headers['accept-language']);
    const problem = this.render(error, lang, requestIdOf(req) ?? '');

    if (res.headersSent) return;
    for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
    res
      .status(error.status)
      .setHeader('Content-Language', lang)
      .type(PROBLEM_CONTENT_TYPE)
      .send(JSON.stringify(problem));
  }

  /** The problem body for a normalised error (also used by unit tests). */
  render(error: NormalisedError, lang: string, requestId: string): ProblemDetails {
    return {
      type: `${PROBLEM_TYPE_BASE}${error.code}`,
      title: this.translate(`errors.${error.code}.title`, lang, error.params),
      status: error.status,
      code: error.code,
      detail: this.translate(`errors.${error.code}.detail`, lang, error.params),
      ...(error.errors?.length ? { errors: error.errors } : {}),
      ...error.extensions,
      requestId,
    };
  }

  normalise(exception: unknown): NormalisedError {
    if (exception instanceof DomainException) {
      return {
        code: exception.code,
        status: exception.status,
        params: exception.params,
        errors: exception.errors,
        extensions: exception.extensions,
        headers: exception.headers,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { code: codeForStatus(status), status, params: {}, headers: {} };
    }
    // Other Express/body-parser errors carry a 4xx `status`.
    const status = (exception as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { code: codeForStatus(status), status, params: {}, headers: {} };
    }
    return { code: 'internal.unexpected', status: 500, params: {}, headers: {} };
  }

  private translate(key: string, lang: string, args: Record<string, string | number>): string {
    return String(this.i18n.translate(key, { lang, args }));
  }
}
