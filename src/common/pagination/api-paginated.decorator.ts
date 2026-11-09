import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtension, ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

import { EXT } from '../openapi/decorators';
import { CursorMeta, PageMeta } from './pagination.dto';

const paginationErrors = ApiExtension(`${EXT.errors}-pagination`, ['validation.failed']);

/** Counts beside a page (J-CR, D-335): the list's tab badges, computed for the same filters minus the tab. */
export interface PageCountsOption {
  model: Type<unknown>;
  example: unknown;
  description: string;
}

/**
 * `{ data: Model[], meta: PageMeta }` with an example built from one item (contract §3 "Lists"); with `counts`, the
 * page also carries `counts` (a named schema).
 */
export function ApiPaginated(
  model: Type<unknown>,
  options: { example: unknown; description?: string; counts?: PageCountsOption },
) {
  const counts = options.counts;
  return applyDecorators(
    ApiExtraModels(PageMeta, model, ...(counts ? [counts.model] : [])),
    ApiOkResponse({
      description: options.description ?? 'One page of results',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: counts ? ['data', 'meta', 'counts'] : ['data', 'meta'],
            properties: {
              data: { type: 'array', items: { $ref: getSchemaPath(model) } },
              meta: { $ref: getSchemaPath(PageMeta) },
              ...(counts
                ? { counts: { $ref: getSchemaPath(counts.model), description: counts.description } }
                : {}),
            },
          },
          example: {
            data: [options.example],
            meta: { page: 1, perPage: 25, total: 1 },
            ...(counts ? { counts: counts.example } : {}),
          },
        },
      },
    }),
    paginationErrors,
  );
}

/** `{ data: Model[], meta: CursorMeta }` for feeds, telemetry and event logs (`?cursor&limit`). */
export function ApiCursor(model: Type<unknown>, options: { example: unknown; description?: string }) {
  return applyDecorators(
    ApiExtraModels(CursorMeta, model),
    ApiOkResponse({
      description: options.description ?? 'One slice of the feed',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['data', 'meta'],
            properties: {
              data: { type: 'array', items: { $ref: getSchemaPath(model) } },
              meta: { $ref: getSchemaPath(CursorMeta) },
            },
          },
          example: { data: [options.example], meta: { nextCursor: 'eyJpZCI6IjEyMyJ9' } },
        },
      },
    }),
    paginationErrors,
  );
}

/** Alias kept for readers of the getpack conventions. */
export const ApiCursorPaginated = ApiCursor;
