import { ERROR_CODES, type ErrorCode } from './error-codes';
import { type ProblemExtensions, type ProblemFieldError } from './problem-details.dto';

export interface DomainExceptionOptions {
  /** Overrides the default status of the code. */
  status?: number;
  /** Interpolation values for the translated `detail` (e.g. `{ max: 100 }`). */
  params?: Record<string, string | number>;
  errors?: ProblemFieldError[];
  /** Published extension members (RFC 9457 §3.2); unlike `params`, these reach the client. */
  extensions?: ProblemExtensions;
  /** Response headers to add (e.g. `Retry-After`). */
  headers?: Record<string, string>;
  cause?: unknown;
}

/** The only exception business code throws. Rendered as a problem by `ProblemDetailsFilter`. */
export class DomainException extends Error {
  readonly status: number;
  readonly params: Record<string, string | number>;
  readonly errors: ProblemFieldError[] | undefined;
  readonly extensions: ProblemExtensions;
  readonly headers: Record<string, string>;

  constructor(
    readonly code: ErrorCode,
    options: DomainExceptionOptions = {},
  ) {
    super(code, { cause: options.cause });
    this.name = 'DomainException';
    this.status = options.status ?? ERROR_CODES[code];
    this.params = options.params ?? {};
    this.errors = options.errors;
    this.extensions = options.extensions ?? {};
    this.headers = options.headers ?? {};
  }
}
