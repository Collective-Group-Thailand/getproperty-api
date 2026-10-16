import { HttpStatus } from '@nestjs/common';

/** Base of every problem `type` URI (contract §3). */
export const PROBLEM_TYPE_BASE = 'https://errors.getproperty.co/';

/**
 * Stable, machine-readable problem codes (contract §3 "Errors"). The frontend switches on `code`,
 * so a code is never renamed or reused; add new ones. Each code needs `title` + `detail`
 * translations in `src/i18n/{th,en}/errors.json` (a unit test enforces this).
 * `compliance.*` codes are refusals of the compliance engine (D-020–D-025): each carries `legalRef`.
 */
export const ERROR_CODES = {
  'http.bad_request': HttpStatus.BAD_REQUEST,
  'http.malformed_json': HttpStatus.BAD_REQUEST,
  'http.not_found': HttpStatus.NOT_FOUND,
  'http.method_not_allowed': HttpStatus.METHOD_NOT_ALLOWED,
  'http.conflict': HttpStatus.CONFLICT,
  'http.payload_too_large': HttpStatus.PAYLOAD_TOO_LARGE,
  'http.unsupported_media_type': HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  'http.too_many_requests': HttpStatus.TOO_MANY_REQUESTS,
  'http.error': HttpStatus.BAD_REQUEST,
  'auth.unauthenticated': HttpStatus.UNAUTHORIZED,
  'auth.forbidden': HttpStatus.FORBIDDEN,
  'auth.wrong_audience': HttpStatus.FORBIDDEN,
  'auth.scope_unavailable': HttpStatus.FORBIDDEN,
  'validation.failed': HttpStatus.UNPROCESSABLE_ENTITY,
  'tenant.context_required': HttpStatus.BAD_REQUEST,
  'tenant.context_invalid': HttpStatus.BAD_REQUEST,
  'tenant.not_in_scope': HttpStatus.FORBIDDEN,
  'idempotency.key_required': HttpStatus.BAD_REQUEST,
  'idempotency.key_invalid': HttpStatus.BAD_REQUEST,
  'idempotency.key_reused': HttpStatus.UNPROCESSABLE_ENTITY,
  'idempotency.in_progress': HttpStatus.CONFLICT,
  'concurrency.stale': HttpStatus.PRECONDITION_FAILED,
  'concurrency.precondition_required': HttpStatus.PRECONDITION_REQUIRED,
  'compliance.tariff_cap': HttpStatus.UNPROCESSABLE_ENTITY,
  'compliance.deposit_cap': HttpStatus.UNPROCESSABLE_ENTITY,
  'compliance.bill_immutable': HttpStatus.CONFLICT,
  'compliance.no_power_cutoff': HttpStatus.UNPROCESSABLE_ENTITY,
  'device.invalid_payload': HttpStatus.UNPROCESSABLE_ENTITY,
  'provider.unavailable': HttpStatus.SERVICE_UNAVAILABLE,
  'service.unavailable': HttpStatus.SERVICE_UNAVAILABLE,
  'internal.unexpected': HttpStatus.INTERNAL_SERVER_ERROR,
} as const satisfies Record<string, HttpStatus>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** The compliance rule ids (contract §3: the `compliance.*` family). */
export type ComplianceCode = Extract<ErrorCode, `compliance.${string}`>;

export const COMPLIANCE_CODES = (Object.keys(ERROR_CODES) as ErrorCode[]).filter(
  (code): code is ComplianceCode => code.startsWith('compliance.'),
);

/** Maps a bare HTTP status (framework exceptions) to a problem code. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'http.bad_request';
    case 401:
      return 'auth.unauthenticated';
    case 403:
      return 'auth.forbidden';
    case 404:
      return 'http.not_found';
    case 405:
      return 'http.method_not_allowed';
    case 409:
      return 'http.conflict';
    case 413:
      return 'http.payload_too_large';
    case 415:
      return 'http.unsupported_media_type';
    case 422:
      return 'validation.failed';
    case 429:
      return 'http.too_many_requests';
    case 503:
      return 'service.unavailable';
    default:
      return status >= 500 ? 'internal.unexpected' : 'http.error';
  }
}
