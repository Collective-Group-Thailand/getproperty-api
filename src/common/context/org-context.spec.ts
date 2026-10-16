import { DomainException } from '../errors/domain.exception';
import { orgScopesOf, resolveOrgContext } from './org-context';
import { RequestContext } from './request-context';

const ORG_A = '0d0c7a4e-5b0e-4c55-9d7c-3f2b8a1e6c11';
const ORG_B = '7b9f1c2e-3d4a-4f5b-8c6d-9e0f1a2b3c4d';

describe('resolveOrgContext (contract §8)', () => {
  it('returns nothing without a header or scopes (no auth yet)', () => {
    expect(resolveOrgContext(undefined)).toBeUndefined();
    expect(resolveOrgContext('   ')).toBeUndefined();
  });

  it('reads and normalises X-Org-Id from the header', () => {
    expect(resolveOrgContext(ORG_A.toUpperCase())).toEqual({ orgId: ORG_A, source: 'header' });
    expect(resolveOrgContext([ORG_A, ORG_B])).toEqual({ orgId: ORG_A, source: 'header' });
  });

  it('refuses a header that is not a uuid with 400 org.context_invalid', () => {
    expect.assertions(3);
    try {
      resolveOrgContext('org-1');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('org.context_invalid');
      expect((error as DomainException).errors?.[0]?.path).toBe('x-org-id');
    }
  });

  it('with token scopes: a single org needs no header, several need one, foreign ones are refused', () => {
    expect(resolveOrgContext(undefined, [`org:${ORG_A}`, 'property:x'])).toEqual({
      orgId: ORG_A,
      source: 'token',
    });
    expect(() => resolveOrgContext(undefined, [`org:${ORG_A}`, `org:${ORG_B}`])).toThrow(
      expect.objectContaining({ code: 'org.context_required', status: 400 }),
    );
    expect(resolveOrgContext(ORG_B, [`org:${ORG_A}`, `org:${ORG_B}`])).toEqual({
      orgId: ORG_B,
      source: 'header',
    });
    expect(() => resolveOrgContext(ORG_B, [`org:${ORG_A}`])).toThrow(
      expect.objectContaining({ code: 'org.not_in_scope', status: 403 }),
    );
    expect(resolveOrgContext(undefined, ['lease:abc'])).toBeUndefined();
    expect(orgScopesOf([`org:${ORG_A}`, 'lease:x'])).toEqual([ORG_A]);
  });

  it('is carried by the request context for repositories', () => {
    RequestContext.run({}, () => {
      expect(RequestContext.org()).toBeUndefined();
      RequestContext.setOrg(resolveOrgContext(ORG_A));
      expect(RequestContext.org()).toEqual({ orgId: ORG_A, source: 'header' });
    });
    expect(RequestContext.org()).toBeUndefined();
  });
});
