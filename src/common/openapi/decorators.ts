import { applyDecorators, SetMetadata, type Type } from '@nestjs/common';
import {
  ApiBody,
  ApiExtension,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

import { type Audience } from '../../surfaces/surfaces';
import {
  assertDeprecationInfo,
  DEPRECATION_METADATA,
  type DeprecationInfo,
} from '../deprecation/deprecation';
import { type ComplianceCode, type ErrorCode } from '../errors/error-codes';
import { type HeaderName, type ParameterName } from './components';

/**
 * Documentation decorators every module uses (contract §5). They record intent in `x-getproperty-*`
 * extensions; `enrichDocument()` (openapi.document.ts) turns those into responses, headers and
 * parameters that reference the shared components, merging what several decorators contribute
 * (e.g. 422 from validation and from idempotency) instead of overwriting it.
 */
export const EXT = {
  errors: 'x-getproperty-errors',
  parameters: 'x-getproperty-parameters',
  successHeaders: 'x-getproperty-success-headers',
  public: 'x-getproperty-public',
  optionalAuth: 'x-getproperty-optional-auth',
  unthrottled: 'x-getproperty-unthrottled',
  async: 'x-getproperty-async',
  compliance: 'x-getproperty-compliance',
} as const;

/** Extensions kept in the published document (not stripped by `enrichDocument`). */
export const PUBLISHED_EXT = {
  /** The surface a controller declared with `ApiSurface()`; consumers group by it. */
  surface: 'x-surface',
  complianceRules: 'x-compliance-rules',
  requiredPermissions: 'x-required-permissions',
} as const;

/** Each contributing decorator writes its own extension key, so contributions never overwrite each other. */
const ext = (base: string, source: string, value: unknown) => ApiExtension(`${base}-${source}`, value);

export const OPERATION_ID_PATTERN =
  /^(auth|owner|resident|staff|technician|prospect|admin|device|webhooks|public|ops)\.[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;
const REFERENCE_PATTERN = /^(D-\d{3}[a-z]?|ADR-\d{4})$/;

export interface ApiEndpointOptions {
  /** `<surface>.<resource>.<action>`, e.g. `owner.bills.issue`. Stable: the frontend imports it. */
  id: string;
  /** One line, imperative. */
  summary: string;
  /** The business rule in plain words. */
  description: string;
  /** Decision ids (`D-021`) — or ADR ids for platform endpoints — this operation implements. */
  implements: string[];
  /**
   * Kept while clients move to its replacement (named in the description): sends `Deprecation`
   * (and `Sunset` once set) and logs every call (`DeprecationInterceptor`).
   */
  deprecated?: DeprecationInfo;
}

/** Operation id, summary and a description that cites the decisions it implements. */
export function ApiEndpoint(options: ApiEndpointOptions) {
  if (!OPERATION_ID_PATTERN.test(options.id)) {
    throw new Error(`ApiEndpoint: operation id "${options.id}" must match ${String(OPERATION_ID_PATTERN)}`);
  }
  if (options.implements.length === 0 || !options.implements.every((ref) => REFERENCE_PATTERN.test(ref))) {
    throw new Error(`ApiEndpoint(${options.id}): implements must list D-### or ADR-#### ids`);
  }
  const operation = ApiOperation({
    operationId: options.id,
    summary: options.summary,
    description: `${options.description}\n\nImplements: ${options.implements.join(', ')}.`,
    ...(options.deprecated && { deprecated: true }),
  });
  if (!options.deprecated) return operation;
  assertDeprecationInfo(`ApiEndpoint(${options.id})`, options.deprecated);
  return applyDecorators(
    operation,
    SetMetadata(DEPRECATION_METADATA, { ...options.deprecated, operationId: options.id }),
    ext(EXT.successHeaders, 'deprecation', [
      'Deprecation',
      ...(options.deprecated.sunset ? (['Sunset'] as const) : []),
    ] satisfies HeaderName[]),
  );
}

export interface ApiSuccessOptions {
  description: string;
  /** Response DTO; omit for 202/204 or when `schema` is given. */
  type?: Type<unknown> | [Type<unknown>];
  schema?: Record<string, unknown>;
  /** Required for every body-carrying response (contract §5). */
  example?: unknown;
  headers?: HeaderName[];
}

/** A success response with its schema and example. */
export function ApiSuccess(status: 200 | 201 | 202 | 204, options: ApiSuccessOptions) {
  const decorators = [];
  let schema: Record<string, unknown> | undefined = options.schema;
  if (options.type) {
    const model = Array.isArray(options.type) ? options.type[0] : options.type;
    decorators.push(ApiExtraModels(model));
    schema = Array.isArray(options.type)
      ? { type: 'array', items: { $ref: getSchemaPath(model) } }
      : { $ref: getSchemaPath(model) };
  }
  decorators.push(
    ApiResponse({
      status,
      description: options.description,
      ...(schema ? { content: { 'application/json': { schema, example: options.example } } } : {}),
    }),
  );
  if (options.headers?.length) decorators.push(ext(EXT.successHeaders, `status${status}`, options.headers));
  return applyDecorators(...decorators);
}

/**
 * The problem responses this operation can actually return, as `application/problem+json` with
 * the shared per-code examples. `500 internal.unexpected` is always included.
 */
export function ApiStandardErrors(...codes: ErrorCode[]) {
  return ext(EXT.errors, 'standard', [...new Set<ErrorCode>([...codes, 'internal.unexpected'])]);
}

/**
 * Irreversible POST protected by `Idempotency-Key` (contract §3); use through `@Idempotent()`.
 * `optional` documents a header that is deduplicated when sent and passed through when not.
 */
export function ApiIdempotent(options: { optional?: boolean } = {}) {
  return applyDecorators(
    ext(EXT.parameters, 'idempotency', [
      options.optional ? 'IdempotencyKeyOptional' : 'IdempotencyKey',
    ] satisfies ParameterName[]),
    ext(EXT.errors, 'idempotency', [
      ...(options.optional ? [] : ['idempotency.key_required' as const]),
      'idempotency.key_invalid',
      'idempotency.in_progress',
      'idempotency.key_reused',
    ] satisfies ErrorCode[]),
    ext(EXT.successHeaders, 'idempotency', ['IdempotentReplayed'] satisfies HeaderName[]),
  );
}

/**
 * Update guarded by `If-Match` / `ETag` (contract §3 "Concurrency"). `optional`: the header is
 * checked when sent (412 on mismatch) and never required (no 428).
 */
export function ApiConcurrency(options: { optional?: boolean } = {}) {
  return applyDecorators(
    ext(EXT.parameters, 'concurrency', [
      options.optional ? 'IfMatchOptional' : 'IfMatch',
    ] satisfies ParameterName[]),
    ext(EXT.errors, 'concurrency', [
      'concurrency.stale',
      ...(options.optional ? [] : ['concurrency.precondition_required' as const]),
    ] satisfies ErrorCode[]),
    ext(EXT.successHeaders, 'concurrency', ['ETag'] satisfies HeaderName[]),
  );
}

/** Read endpoint that returns an `ETag` (pair with `@UseEtag`). */
export function ApiEtag() {
  return ext(EXT.successHeaders, 'etag', ['ETag'] satisfies HeaderName[]);
}

/**
 * Operation that may be refused by the compliance engine (D-020–D-025): documents each rule's
 * `compliance.*` problem (with `legalRef`) and lists the rule ids as `x-compliance-rules`.
 */
export function ApiCompliance(...ruleIds: [ComplianceCode, ...ComplianceCode[]]) {
  return applyDecorators(
    ext(EXT.errors, 'compliance', ruleIds satisfies ErrorCode[]),
    ApiExtension(EXT.compliance, ruleIds),
  );
}

/** Tenant-scoped operation on `/v1/owner` or `/v1/staff` (contract §8): documents `X-Tenant-Id` and its problems. */
export function ApiTenantContext() {
  return applyDecorators(
    ext(EXT.parameters, 'tenant', ['TenantIdHeader'] satisfies ParameterName[]),
    ext(EXT.errors, 'tenant', [
      'tenant.context_required',
      'tenant.context_invalid',
      'tenant.not_in_scope',
    ] satisfies ErrorCode[]),
  );
}

/** Operation without authentication: documented explicitly as `security: []`. */
export function ApiPublic() {
  return ApiExtension(EXT.public, true);
}

/** Anonymous or with a bearer token of `audience` (`security: [{}, { <scheme>: [] }]`). */
export function ApiOptionalAuth(audience: Audience) {
  return ApiExtension(EXT.optionalAuth, audience);
}

/** Operation excluded from rate limiting (pair with `@SkipThrottle()`): no 429 / rate-limit headers. */
export function ApiUnthrottled() {
  return ApiExtension(EXT.unthrottled, true);
}

/** Errors every secured surface operation can return (audience, permission, scope). */
export function ApiAuthErrors() {
  return ext(EXT.errors, 'auth', [
    'auth.unauthenticated',
    'auth.forbidden',
    'auth.wrong_audience',
  ] satisfies ErrorCode[]);
}

/**
 * Asynchronous operation (contract §5): the 202 response names the operation to poll, or says there
 * is nothing to poll (fire-and-forget). Pair with `@HttpCode(202)` and `@ApiSuccess(202, …)`.
 */
export function ApiAsync(options: { poll: string } | { poll: null }) {
  if (options.poll !== null && !OPERATION_ID_PATTERN.test(options.poll)) {
    throw new Error(`ApiAsync: poll "${options.poll}" must be an operation id`);
  }
  return ApiExtension(EXT.async, options.poll ?? false);
}

/** JSON request body with its schema and a named example (contract §5: every request body has an example). */
export function ApiJsonBody(type: Type<unknown>, example: unknown, description?: string) {
  return ApiBody({ type, description, examples: { default: { summary: 'Example', value: example } } });
}
