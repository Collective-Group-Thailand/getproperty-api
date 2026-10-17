import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { type ExecutionContext } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';

import { SupportGrantGuard } from './support-grant.guard';

const TENANT = '0199f2a0-0000-7000-8000-000000000001';

function setup(roles: string[], grant: { id: string } | null) {
  const audit = { recordAlone: jest.fn().mockResolvedValue(undefined) };
  const guard = new SupportGrantGuard(
    { getAllAndOverride: () => 'tenantId' } as unknown as Reflector,
    { platform: () => Promise.resolve({ roles, permissions: new Set<string>() }) } as never,
    { activeFor: () => Promise.resolve(grant) } as never,
    audit as never,
  );
  const context = (method: string) =>
    ({
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          params: { tenantId: TENANT },
          originalUrl: `/v1/admin/tenants/${TENANT}/x`,
        }),
      }),
    }) as unknown as ExecutionContext;
  const run = (method: string) =>
    RequestContext.run(
      { actor: { type: 'user', publicId: 'u1', audience: 'platform', sessionId: 's', scopes: [] } as never },
      () => guard.canActivate(context(method)),
    );
  return { run, audit };
}

describe('SupportGrantGuard — "view as tenant" is read-only (D-090, B6.1)', () => {
  it('Support with an active grant reads', async () => {
    const { run, audit } = setup(['support'], { id: 'g1' });
    await expect(run('GET')).resolves.toBe(true);
    expect(audit.recordAlone).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_grant.used', supportGrantId: 'g1' }),
    );
  });

  it('Support with an active grant never writes: 403 support.read_only, audited as denied', async () => {
    const { run, audit } = setup(['support'], { id: 'g1' });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const error = await run(method).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('support.read_only');
    }
    expect(audit.recordAlone).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        metadata: expect.objectContaining({ reason: 'read_only' }),
      }),
    );
  });

  it('without a grant Support gets support.grant_required; a Platform admin bypasses (audited)', async () => {
    const none = setup(['support'], null);
    expect(((await none.run('GET').catch((e: unknown) => e)) as DomainException).code).toBe(
      'support.grant_required',
    );
    const admin = setup(['platform_admin'], null);
    await expect(admin.run('POST')).resolves.toBe(true);
    expect(admin.audit.recordAlone).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_grant.bypassed' }),
    );
  });
});
