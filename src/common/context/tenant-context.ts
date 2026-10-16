import { isUuid } from '@common/ids/uuidv7';

import { DomainException } from '../errors/domain.exception';

export const TENANT_ID_HEADER = 'x-tenant-id';

/**
 * The one tenant (SaaS customer organisation, D-151) a `/v1/owner/*` or `/v1/staff/*` request runs in
 * (contract §8, D-152). Repositories receive it, add `tenant_id` to every query and set
 * `app.tenant_id` on the connection for row-level security; a cross-tenant id is a 404.
 */
export interface TenantContext {
  tenantId: string;
  /** How the tenant was chosen: the single `tenant:<uuid>` scope of the token, or the `X-Tenant-Id` header. */
  source: 'token' | 'header';
}

/** `tenant:<uuid>` scopes of a token (contract §4). */
export function tenantScopesOf(scopes: readonly string[] | undefined): string[] {
  return (scopes ?? []).filter((s) => s.startsWith('tenant:')).map((s) => s.slice('tenant:'.length));
}

/**
 * Resolves the tenant context from the `X-Tenant-Id` header and the token's `tenant:` scopes:
 * - header present but not a uuid → 400 `tenant.context_invalid`;
 * - header present and scopes known but the tenant is not among them → 403 `tenant.not_in_scope`;
 * - no header, exactly one tenant scope → that tenant (`source: 'token'`);
 * - no header, several tenant scopes → 400 `tenant.context_required` (the client must choose);
 * - nothing at all → `undefined` (anonymous request, or no auth yet).
 *
 * TODO(B1.3): the audience guard sets the actor before this runs, so `scopes` becomes the token's
 * scopes; until then every call passes `undefined` and only the header is checked.
 */
export function resolveTenantContext(
  header: string | string[] | undefined,
  scopes?: readonly string[],
): TenantContext | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = raw?.trim();
  const tenantScopes = scopes === undefined ? undefined : tenantScopesOf(scopes);

  if (value) {
    if (!isUuid(value)) {
      throw new DomainException('tenant.context_invalid', {
        errors: [{ path: TENANT_ID_HEADER, code: 'isUuid', message: 'X-Tenant-Id must be a uuid' }],
      });
    }
    const tenantId = value.toLowerCase();
    if (tenantScopes !== undefined && !tenantScopes.includes(tenantId)) {
      throw new DomainException('tenant.not_in_scope');
    }
    return { tenantId, source: 'header' };
  }

  if (tenantScopes === undefined || tenantScopes.length === 0) return undefined;
  if (tenantScopes.length === 1) return { tenantId: tenantScopes[0]!, source: 'token' };
  throw new DomainException('tenant.context_required');
}
