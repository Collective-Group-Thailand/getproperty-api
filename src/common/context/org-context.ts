import { isUuid } from '@common/ids/uuidv7';

import { DomainException } from '../errors/domain.exception';

export const ORG_ID_HEADER = 'x-org-id';

/**
 * The one organisation a `/v1/owner/*` or `/v1/staff/*` request runs in (contract §8, D-004).
 * Repositories receive it and add `org_id` to every query; a cross-org id is a 404.
 */
export interface OrgContext {
  orgId: string;
  /** How the org was chosen: the single `org:<uuid>` scope of the token, or the `X-Org-Id` header. */
  source: 'token' | 'header';
}

/** `org:<uuid>` scopes of a token (contract §4). */
export function orgScopesOf(scopes: readonly string[] | undefined): string[] {
  return (scopes ?? []).filter((s) => s.startsWith('org:')).map((s) => s.slice('org:'.length));
}

/**
 * Resolves the org context from the `X-Org-Id` header and the token's `org:` scopes:
 * - header present but not a uuid → 400 `org.context_invalid`;
 * - header present and scopes known but the org is not among them → 403 `org.not_in_scope`;
 * - no header, exactly one org scope → that org (`source: 'token'`);
 * - no header, several org scopes → 400 `org.context_required` (the client must choose);
 * - nothing at all → `undefined` (anonymous request, or no auth yet).
 *
 * TODO(B1.3): the audience guard sets the actor before this runs, so `scopes` becomes the token's
 * scopes; until then every call passes `undefined` and only the header is checked.
 */
export function resolveOrgContext(
  header: string | string[] | undefined,
  scopes?: readonly string[],
): OrgContext | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = raw?.trim();
  const orgScopes = scopes === undefined ? undefined : orgScopesOf(scopes);

  if (value) {
    if (!isUuid(value)) {
      throw new DomainException('org.context_invalid', {
        errors: [{ path: ORG_ID_HEADER, code: 'isUuid', message: 'X-Org-Id must be a uuid' }],
      });
    }
    const orgId = value.toLowerCase();
    if (orgScopes !== undefined && !orgScopes.includes(orgId)) throw new DomainException('org.not_in_scope');
    return { orgId, source: 'header' };
  }

  if (orgScopes === undefined || orgScopes.length === 0) return undefined;
  if (orgScopes.length === 1) return { orgId: orgScopes[0]!, source: 'token' };
  throw new DomainException('org.context_required');
}
