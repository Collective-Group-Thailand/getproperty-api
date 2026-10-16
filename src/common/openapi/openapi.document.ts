import { join } from 'node:path';

import { type INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  getSchemaPath,
  type OpenAPIObject,
  type OperationObject,
  type ParameterObject,
  type PathItemObject,
  type ReferenceObject,
  type ResponseObject,
  SwaggerModule,
} from '@nestjs/swagger';

import {
  type Audience,
  AUDIENCES,
  SECURITY_SCHEMES,
  SURFACE_EXTENSION,
  SURFACE_PREFIX,
  SURFACES,
} from '../../surfaces/surfaces';
import { ERROR_CODES, type ErrorCode } from '../errors/error-codes';
import { ProblemDetails, ProblemFieldError } from '../errors/problem-details.dto';
import {
  EXAMPLE_REQUEST_ID,
  type HeaderName,
  HEADERS,
  type ParameterName,
  PARAMETERS,
  problemExampleName,
  problemExamples,
  RESPONSE_HEADER_NAMES,
} from './components';
import { EXT, PUBLISHED_EXT } from './decorators';
import { FAKE } from './examples';
import { SERVERS } from './servers';
import { API_TAGS } from './tags';

export const OPENAPI_VERSION = '3.1.0';
const I18N_DIR = join(__dirname, '..', '..', 'i18n');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

const AUDIENCE_DESCRIPTIONS: Record<Audience, string> = {
  operator:
    'Access token with `aud=operator` — `/v1/owner/*` and `/v1/staff/*`: people working for a tenant (Owner, Manager, Accountant, building Staff; scopes `tenant:<uuid>`, `building:<uuid>`; D-151).',
  resident:
    'Access token with `aud=resident` — `/v1/resident/*`, served by the getproperty-liff LINE Mini App: lessees, co-occupants, condo owners (scopes `lease:<uuid>`, `unit:<uuid>`; D-154).',
  technician:
    'Access token with `aud=technician` — `/v1/technician/*`, external technicians and contractors in LIFF (scopes `work_order:<uuid>`; R2).',
  platform: 'Access token with `aud=platform` — `/v1/admin/*` (Collective Group staff, TOTP mandatory).',
  device: 'Device JWT with `aud=device` minted at mTLS bootstrap — `/v1/device/*` (one gateway).',
};

const INFO_DESCRIPTION = `getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย, operated by Collective Group (Thailand) (D-001).
Rules: \`docs/contract/api-conventions.md\` (shared with getproperty-web and getproperty-edge); MQTT payloads: \`docs/contract/device-protocol.md\` / \`contract/device-protocol.json\` (D-130).

- **Surfaces:** \`/v1/auth\`, \`/v1/owner\` (operator), \`/v1/staff\` (operator, Staff role), \`/v1/resident\` (resident), \`/v1/technician\` (technician, R2), \`/v1/admin\` (platform), \`/v1/device\` (device), \`/webhooks\`. A token is accepted only on its own audience's prefix.
- **Tenancy:** a *tenant* is the SaaS customer organisation (D-151). Every owner/staff request runs in one tenant (\`tenant:<uuid>\` scope or \`X-Tenant-Id\`); a cross-tenant id is a 404 (contract §8, D-152).
- **Money:** decimal strings with exactly 2 decimals (\`"1234.50"\`) plus \`currency: "THB"\` on the object; never JSON numbers. Clients never compute prices (D-046).
- **Meter quantities:** \`register\` and \`units\` are decimal strings with up to 3 decimals (\`"12345.678"\`), \`unit\` is \`kwh | m3\`; tariff \`pricePerUnit\` has up to 4 decimals.
- **Dates:** ISO 8601 with offset, rendered in \`Asia/Bangkok\` (\`2026-11-01T00:00:00+07:00\`); date-only fields \`YYYY-MM-DD\`.
- **IDs:** uuid only; business keys (\`invoiceNumber\`, \`unitNo\`, \`deviceSerial\`) are separate fields.
- **Errors:** RFC 9457 \`application/problem+json\` with a stable \`code\`; \`title\`/\`detail\` localised by \`Accept-Language\` (\`th\` default, \`en\`). \`compliance.*\` refusals carry \`legalRef\` (D-020).
- **Lists:** \`?page&perPage(≤100)&sort&order&q\` → \`{ data, meta: { page, perPage, total } }\`; feeds use \`?cursor&limit\` → \`{ data, meta: { nextCursor } }\`; series take \`from\`, \`to\`, \`bucket\` (\`15m | 1h | 1d\`).
- **Idempotency:** irreversible POSTs require \`Idempotency-Key\` (uuid); replays within 24 h return the original response.
- **Concurrency:** editable resources return \`ETag\`; updates send \`If-Match\` (412 \`concurrency.stale\`).
- **Files:** presign → PUT to the returned URL → reference the \`fileId\`; downloads are short-lived signed URLs.`;

/** Builds the OpenAPI document served at `/docs*` and written to `contract/openapi.json`. */
export function buildOpenApiDocument(app: INestApplication, version: string): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setOpenAPIVersion(OPENAPI_VERSION)
    .setTitle('getproperty API')
    .setDescription(INFO_DESCRIPTION)
    .setVersion(version)
    .setContact('Collective Group (Thailand) — getproperty', 'https://getproperty.co', 'dev@getproperty.co');
  for (const server of SERVERS) {
    builder.addServer(
      server.url,
      server.description,
      server.host
        ? { host: { default: server.host, description: `${server.description} host (to be confirmed)` } }
        : undefined,
    );
  }
  for (const audience of AUDIENCES) {
    builder.addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: AUDIENCE_DESCRIPTIONS[audience] },
      SECURITY_SCHEMES[audience],
    );
  }

  const document = SwaggerModule.createDocument(app, builder.build(), {
    extraModels: [ProblemDetails, ProblemFieldError],
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
  const enriched = enrichDocument(document);
  addWebhooks(enriched);
  pruneUnusedComponents(enriched);
  enriched.tags = usedTags(enriched);
  return normaliseDocument(enriched);
}

const ref = (kind: 'parameters' | 'headers' | 'examples', name: string): ReferenceObject => ({
  $ref: `#/components/${kind}/${name}`,
});

/** Collects the values of every `x-getproperty-<base>-*` extension on an operation. */
function collect<T>(operation: Record<string, unknown>, base: string): { source: string; values: T[] }[] {
  return Object.keys(operation)
    .filter((key) => key.startsWith(`${base}-`))
    .map((key) => ({ source: key.slice(base.length + 1), values: operation[key] as T[] }));
}

/**
 * Turns the `x-getproperty-*` intents recorded by the documentation decorators into shared-component
 * references: problem responses per status with per-code examples, parameters, response headers,
 * explicit `security: []` for public operations, compliance rule ids and rate-limit documentation.
 */
export function enrichDocument(document: OpenAPIObject): OpenAPIObject {
  document.components = {
    ...document.components,
    examples: problemExamples(I18N_DIR),
    parameters: PARAMETERS,
    headers: HEADERS,
  };

  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method] as (OperationObject & Record<string, unknown>) | undefined;
      if (!operation) continue;

      const errors = new Set(collect<ErrorCode>(operation, EXT.errors).flatMap((c) => c.values));
      const parameters = new Set(collect<ParameterName>(operation, EXT.parameters).flatMap((c) => c.values));
      const successHeaders = collect<HeaderName>(operation, EXT.successHeaders);
      const isPublic = operation[EXT.public] === true;
      const optionalAudience = operation[EXT.optionalAuth] as Audience | undefined;
      const throttled = operation[EXT.unthrottled] !== true;
      const poll = operation[EXT.async] as string | false | undefined;
      const compliance = operation[EXT.compliance] as string[] | undefined;
      const surface = operation[SURFACE_EXTENSION] as string | undefined;
      for (const key of Object.keys(operation)) if (key.startsWith('x-getproperty-')) delete operation[key];

      if (surface) operation[PUBLISHED_EXT.surface] = surface;
      if (isPublic) operation.security = [];
      if (optionalAudience) operation.security = [{}, { [SECURITY_SCHEMES[optionalAudience]]: [] }];
      if (throttled) errors.add('http.too_many_requests');
      if (compliance?.length) operation[PUBLISHED_EXT.complianceRules] = [...compliance].sort();

      operation.parameters = [
        ...(operation.parameters ?? []),
        ...[...parameters].map((name) => ref('parameters', name)),
        ref('parameters', 'AcceptLanguage'),
      ] as (ParameterObject | ReferenceObject)[];

      addProblemResponses(operation, [...errors]);

      for (const [status, response] of Object.entries(operation.responses)) {
        const headers: Record<string, ReferenceObject> = { 'X-Request-Id': ref('headers', 'XRequestId') };
        if (status.startsWith('2')) {
          for (const { source, values } of successHeaders) {
            if (source.startsWith('status') && source !== `status${status}`) continue;
            for (const name of values) headers[RESPONSE_HEADER_NAMES[name]] = ref('headers', name);
          }
          if (throttled) {
            for (const name of ['RateLimitLimit', 'RateLimitRemaining', 'RateLimitReset'] as const) {
              headers[RESPONSE_HEADER_NAMES[name]] = ref('headers', name);
            }
          }
        }
        if (status === '429') headers['Retry-After'] = ref('headers', 'RetryAfter');
        const target = response as ResponseObject;
        if (status === '202' && poll !== undefined)
          target.description = asyncDescription(target.description, poll);
        target.headers = { ...target.headers, ...headers };
      }
    }
  }
  addUploadFlow(document);
  return document;
}

/**
 * OpenAPI 3.1 `webhooks` (contract §5): every inbound provider callback, keyed by its operation id
 * without the `webhooks.` prefix. Each entry references the callback's path item, so the payload,
 * signature and expected response are defined once. Until the first real provider lands (B4), a
 * clearly marked placeholder shows consumers the shape every callback definition will have.
 */
export function addWebhooks(document: OpenAPIObject): void {
  const webhooks: Record<string, PathItemObject | ReferenceObject> = {};
  for (const [route, item] of Object.entries(document.paths)) {
    if (!route.startsWith(SURFACE_PREFIX.webhooks)) continue;
    const id = HTTP_METHODS.map((m) => item[m]?.operationId).find(Boolean);
    if (!id) continue;
    webhooks[id.replace(/^webhooks\./, '')] = {
      $ref: `#/paths/${route.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    };
  }
  const hasProvider = Object.keys(webhooks).some((key) => !key.startsWith('system.'));
  if (!hasProvider) webhooks['placeholder.providerCallback'] = placeholderWebhook();
  (document as OpenAPIObject & { webhooks?: unknown }).webhooks = webhooks;
}

/** The shape of a provider callback definition; replaced by real providers in B4 (D-042, D-043). */
function placeholderWebhook(): PathItemObject {
  const problem = (codes: ErrorCode[]): ResponseObject => ({
    description: `Problem: ${codes.map((c) => `\`${c}\``).join(', ')}`,
    content: {
      'application/problem+json': {
        schema: { $ref: getSchemaPath(ProblemDetails) },
        examples: Object.fromEntries(codes.map((code) => [code, ref('examples', problemExampleName(code))])),
      },
    },
    headers: { 'X-Request-Id': ref('headers', 'XRequestId') },
  });
  return {
    post: {
      operationId: 'webhooks.placeholder.providerCallback',
      summary: 'PLACEHOLDER — shape of an inbound provider callback',
      description:
        'PLACEHOLDER (not served): every real callback (payment QR confirmation, slip verification, LINE Messaging, ' +
        'lock vendors, e-Tax) is documented like this — the provider POSTs a signed JSON payload, the API verifies ' +
        'the signature header over the raw body, answers 200 at once and processes the event idempotently in the ' +
        'worker. Replaced by the real providers in B4.\n\nImplements: D-042, D-043.',
      tags: ['webhooks.placeholder'],
      security: [],
      parameters: [
        {
          name: 'X-Provider-Signature',
          in: 'header',
          required: true,
          description:
            'HMAC-SHA256 of the raw body with the provider secret (name and algorithm vary per provider).',
          schema: {
            type: 'string',
            example: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              description: 'Provider event; the real schema is per provider.',
              additionalProperties: true,
            },
            example: {
              eventId: FAKE.uuid,
              type: 'payment.confirmed',
              reference: 'INV-2026-000001',
              amount: '4500.00',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Callback accepted (processing continues in the worker)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['received'],
                properties: { received: { type: 'boolean', example: true } },
              },
              example: { received: true },
            },
          },
          headers: { 'X-Request-Id': ref('headers', 'XRequestId') },
        },
        '400': problem(['http.bad_request', 'http.malformed_json']),
        '401': problem(['auth.unauthenticated']),
        '500': problem(['internal.unexpected']),
      },
    },
  };
}

/** The 202 description with its polling instruction (`@ApiAsync`). */
export function asyncDescription(description: string, poll: string | false): string {
  return poll ? `${description}. Poll \`${poll}\` until it completes.` : `${description}. Nothing to poll.`;
}

const UPLOAD_SURFACES = new Set<string>([
  SURFACES.owner,
  SURFACES.resident,
  SURFACES.staff,
  SURFACES.technician,
  SURFACES.admin,
]);
const FILE_FIELD = /^(fileId|fileIds|[a-z][A-Za-z]*FileIds?)$/;
const UPLOAD_FLOW =
  '**Files:** upload first — `<surface>.files.presign` → PUT the bytes to the returned URL → ' +
  '`…/actions/complete` — then send the `fileId` (contract §3).';

/**
 * File-upload flow (contract §5): every operation whose request body references uploaded files
 * (`fileId`, `fileIds`, `…FileId`, at any depth) gets the presign → PUT → reference note.
 */
function addUploadFlow(document: OpenAPIObject): void {
  const schemas = (document.components?.schemas ?? {}) as Record<string, Record<string, unknown>>;
  const memo = new Map<string, boolean>();
  const takesFiles = (node: unknown, seen: Set<string>): boolean => {
    if (Array.isArray(node)) return node.some((child) => takesFiles(child, seen));
    if (!node || typeof node !== 'object') return false;
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      const name = record.$ref.split('/').pop()!;
      if (memo.has(name)) return memo.get(name)!;
      if (seen.has(name)) return false;
      const result = takesFiles(schemas[name], new Set([...seen, name]));
      memo.set(name, result);
      return result;
    }
    const properties = (record.properties ?? {}) as Record<string, unknown>;
    if (Object.keys(properties).some((key) => FILE_FIELD.test(key))) return true;
    return Object.values(record).some((child) => takesFiles(child, seen));
  };
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      const body = operation?.requestBody as { content?: Record<string, unknown> } | undefined;
      const [surface, resource] = operation?.operationId?.split('.') ?? [];
      if (!operation || !body?.content || !surface || !UPLOAD_SURFACES.has(surface) || resource === 'files')
        continue;
      if (!takesFiles(body.content, new Set())) continue;
      const note = UPLOAD_FLOW.replace('<surface>', surface);
      if (!operation.description?.includes('.files.presign')) {
        operation.description = `${operation.description ?? ''}\n\n${note}`;
      }
    }
  }
}

/**
 * Drops shared examples, parameters and headers that no operation references, so the contract
 * only contains what is used (shared components still appear exactly once when used).
 */
export function pruneUnusedComponents(document: OpenAPIObject): OpenAPIObject {
  const json = JSON.stringify({
    ...document,
    components: { ...document.components, examples: {}, parameters: {}, headers: {} },
  });
  const components = document.components ?? {};
  for (const kind of ['examples', 'parameters', 'headers'] as const) {
    const entries = Object.entries(components[kind] ?? {}).filter(([name]) =>
      json.includes(`"#/components/${kind}/${name}"`),
    );
    if (entries.length > 0) components[kind] = Object.fromEntries(entries);
    else delete components[kind];
  }
  return document;
}

function addProblemResponses(operation: OperationObject, codes: ErrorCode[]): void {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes)
    byStatus.set(ERROR_CODES[code], [...(byStatus.get(ERROR_CODES[code]) ?? []), code]);

  for (const [status, statusCodes] of byStatus) {
    const sorted = [...statusCodes].sort();
    operation.responses[String(status)] = {
      description: `Problem: ${sorted.map((code) => `\`${code}\``).join(', ')}`,
      content: {
        'application/problem+json': {
          schema: { $ref: getSchemaPath(ProblemDetails) },
          examples: Object.fromEntries(
            sorted.map((code) => [code, ref('examples', problemExampleName(code))]),
          ),
        },
      },
    };
  }
}

/** Sorts object keys recursively (arrays keep their order) so the output is byte-for-byte stable. */
export function normaliseDocument<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => normaliseDocument(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normaliseDocument((value as Record<string, unknown>)[key])]),
    ) as T;
  }
  return value;
}

/**
 * Fast checks at build time (the full gate is `pnpm contract:lint`, Spectral): every enum is a
 * named component; every operation tag is surface-prefixed and registered with a description; every
 * surface operation carries the security of its audience (or is explicitly public).
 */
export function contractViolations(document: OpenAPIObject): string[] {
  const problems: string[] = [];
  const allowedPrefixes = [...Object.values(SURFACES), 'ops'].map((p) => `${p}.`);

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const isComponentSchema = /^#\/components\/schemas\/[^/]+$/.test(path);
    if (Array.isArray(record.enum) && !isComponentSchema) {
      problems.push(`inline enum at ${path}: declare it with enumName so it becomes a named component`);
    }
    for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`);
  };
  walk(document, '#');

  // A component that references itself is how a DTO and an enum sharing one name surface (the enum's
  // values are lost); the contract has no recursive schema, so any self-reference is a defect.
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    if (JSON.stringify(schema).includes(`"#/components/schemas/${name}"`))
      problems.push(`schema ${name} references itself: an enum and a DTO probably share the name`);
  }

  const operationIds = new Set<string>();
  for (const item of Object.values(document.paths))
    for (const method of HTTP_METHODS)
      if (item[method]?.operationId) operationIds.add(item[method].operationId);

  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method] as (OperationObject & Record<string, unknown>) | undefined;
      if (!operation) continue;
      const accepted = operation.responses?.['202'] as ResponseObject | undefined;
      if (accepted) {
        const poll = /Poll `([^`]+)`/.exec(accepted.description)?.[1];
        if (!poll && !accepted.description.endsWith('Nothing to poll.'))
          problems.push(
            `${method.toUpperCase()} ${route}: 202 without @ApiAsync (name the operation to poll)`,
          );
        if (poll && !operationIds.has(poll))
          problems.push(`${method.toUpperCase()} ${route}: polls unknown operation ${poll}`);
      }
      const tags = operation.tags ?? [];
      if (tags.length === 0 || tags.some((tag) => !allowedPrefixes.some((p) => tag.startsWith(p)))) {
        problems.push(
          `${method.toUpperCase()} ${route}: tags must be prefixed by a surface (${allowedPrefixes.join(', ')})`,
        );
      }
      for (const tag of tags) {
        if (!API_TAGS[tag])
          problems.push(`${method.toUpperCase()} ${route}: tag "${tag}" is not in API_TAGS`);
      }
      const surface = operation[PUBLISHED_EXT.surface] as string | undefined;
      const expectedPrefix = surface ? SURFACE_PREFIX[surface as keyof typeof SURFACE_PREFIX] : undefined;
      if (expectedPrefix && !route.startsWith(expectedPrefix)) {
        problems.push(
          `${method.toUpperCase()} ${route}: declared surface "${surface}" does not match the path`,
        );
      }
      if (operation.operationId && surface && !operation.operationId.startsWith(`${surface}.`)) {
        problems.push(`${method.toUpperCase()} ${route}: operationId must start with "${surface}."`);
      }
    }
  }
  return problems;
}

/** The tags used by operations (paths and webhooks), with their registered descriptions (sorted). */
export function usedTags(document: OpenAPIObject): { name: string; description: string }[] {
  const names = new Set<string>();
  const items: PathItemObject[] = [
    ...Object.values(document.paths),
    ...Object.values(
      (document as OpenAPIObject & { webhooks?: Record<string, PathItemObject> }).webhooks ?? {},
    ).filter((item): item is PathItemObject => !('$ref' in item)),
  ];
  for (const item of items) {
    for (const method of HTTP_METHODS) for (const tag of item[method]?.tags ?? []) names.add(tag);
  }
  return [...names].sort().map((name) => ({ name, description: API_TAGS[name] ?? '' }));
}

export { EXAMPLE_REQUEST_ID };
