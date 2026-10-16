import { DomainException } from '../errors/domain.exception';
import { RequestContext } from './request-context';
import { resolveTenantContext, tenantScopesOf } from './tenant-context';

const TENANT_A = '0d0c7a4e-5b0e-4c55-9d7c-3f2b8a1e6c11';
const TENANT_B = '7b9f1c2e-3d4a-4f5b-8c6d-9e0f1a2b3c4d';

describe('resolveTenantContext (contract §8, D-151/D-152)', () => {
  it('returns nothing without a header or scopes (no auth yet)', () => {
    expect(resolveTenantContext(undefined)).toBeUndefined();
    expect(resolveTenantContext('   ')).toBeUndefined();
  });

  it('reads and normalises X-Tenant-Id from the header', () => {
    expect(resolveTenantContext(TENANT_A.toUpperCase())).toEqual({ tenantId: TENANT_A, source: 'header' });
    expect(resolveTenantContext([TENANT_A, TENANT_B])).toEqual({ tenantId: TENANT_A, source: 'header' });
  });

  it('refuses a header that is not a uuid with 400 tenant.context_invalid', () => {
    expect.assertions(3);
    try {
      resolveTenantContext('tenant-1');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('tenant.context_invalid');
      expect((error as DomainException).errors?.[0]?.path).toBe('x-tenant-id');
    }
  });

  it('with token scopes: a single tenant needs no header, several need one, foreign ones are refused', () => {
    expect(resolveTenantContext(undefined, [`tenant:${TENANT_A}`, 'building:x'])).toEqual({
      tenantId: TENANT_A,
      source: 'token',
    });
    expect(() => resolveTenantContext(undefined, [`tenant:${TENANT_A}`, `tenant:${TENANT_B}`])).toThrow(
      expect.objectContaining({ code: 'tenant.context_required', status: 400 }),
    );
    expect(resolveTenantContext(TENANT_B, [`tenant:${TENANT_A}`, `tenant:${TENANT_B}`])).toEqual({
      tenantId: TENANT_B,
      source: 'header',
    });
    expect(() => resolveTenantContext(TENANT_B, [`tenant:${TENANT_A}`])).toThrow(
      expect.objectContaining({ code: 'tenant.not_in_scope', status: 403 }),
    );
    expect(resolveTenantContext(undefined, ['lease:abc'])).toBeUndefined();
    expect(tenantScopesOf([`tenant:${TENANT_A}`, 'lease:x'])).toEqual([TENANT_A]);
  });

  it('ignores the retired org: scope prefix (renamed to tenant:, D-151)', () => {
    expect(resolveTenantContext(undefined, [`org:${TENANT_A}`])).toBeUndefined();
  });

  it('is carried by the request context for repositories', () => {
    RequestContext.run({}, () => {
      expect(RequestContext.tenant()).toBeUndefined();
      RequestContext.setTenant(resolveTenantContext(TENANT_A));
      expect(RequestContext.tenant()).toEqual({ tenantId: TENANT_A, source: 'header' });
    });
    expect(RequestContext.tenant()).toBeUndefined();
  });
});
