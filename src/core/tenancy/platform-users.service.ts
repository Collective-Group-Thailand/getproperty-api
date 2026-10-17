import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { AuthService } from '../identity/auth.service';
import { TokenService } from '../identity/token.service';
import { type RoleKey, ROLES } from '../rbac/catalogue';
import { AccessService } from './access.service';

const PLATFORM_ROLES = ROLES.filter((r) => r.scopeKind === 'platform').map((r) => r.key);

/**
 * Platform users (Collective Group staff, D-090): created by a platform admin with a temporary password and
 * platform roles; TOTP enrolment is forced at the first sign-in (`auth.totp_enrollment_required`). Role grants and
 * revocations are audited and take effect at once (cached access dropped).
 */
@Injectable()
export class PlatformUsersService {
  constructor(
    private readonly db: TenantTx,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly hasher: LookupHasher,
  ) {}

  list() {
    return this.db.platform((tx) =>
      tx.userAccount.findMany({
        where: { platformRoleAssignmentUser: { some: { revokedAt: null } } },
        include: {
          platformRoleAssignmentUser: { where: { revokedAt: null }, include: { role: true } },
          userCredentialUser: { select: { totpEnabledAt: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  private checkRoles(roles: string[]): RoleKey[] {
    const bad = roles.filter((r) => !PLATFORM_ROLES.includes(r as RoleKey));
    if (bad.length || roles.length === 0)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'roles', code: 'isIn', message: `platform roles only: ${PLATFORM_ROLES.join(', ')}` },
        ],
      });
    return roles as RoleKey[];
  }

  async create(input: {
    email: string;
    displayName: string;
    phone?: string | null;
    roles: string[];
    temporaryPassword: string;
  }) {
    const roles = this.checkRoles(input.roles);
    return this.db.platform(async (tx) => {
      if (await tx.userAccount.findUnique({ where: { email: input.email } }))
        throw new DomainException('http.conflict');
      const user = await tx.userAccount.create({
        data: {
          email: input.email,
          displayName: input.displayName,
          phoneE164: input.phone ?? null,
          phoneHash: input.phone ? this.hasher.phone(input.phone) : null,
          language: 'th',
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.auth.setPassword(tx, user.id, input.temporaryPassword);
      for (const key of roles) {
        const role = await tx.role.findUniqueOrThrow({ where: { key } });
        await tx.platformRoleAssignment.create({
          data: { userId: user.id, roleId: role.id, grantedBy: userIdOf(RequestContext.actor()) },
        });
      }
      await this.audit.record(tx, {
        action: 'platform.user.created',
        subjectType: 'core.user_account',
        subjectId: user.id,
        after: { email: input.email, roles },
      });
      return user;
    });
  }

  async grant(userId: string, roleKey: string, expiresAt?: Date | null) {
    const [key] = this.checkRoles([roleKey]);
    await this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUnique({ where: { id: userId } });
      if (!user) throw new DomainException('http.not_found');
      const role = await tx.role.findUniqueOrThrow({ where: { key: key! } });
      const existing = await tx.platformRoleAssignment.findFirst({
        where: { userId, roleId: role.id, revokedAt: null },
      });
      if (existing) return;
      await tx.platformRoleAssignment.create({
        data: {
          userId,
          roleId: role.id,
          grantedBy: userIdOf(RequestContext.actor()),
          expiresAt: expiresAt ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'platform.role.granted',
        subjectType: 'core.user_account',
        subjectId: userId,
        after: { role: key!, expiresAt: expiresAt?.toISOString() ?? null },
      });
    });
    await this.access.changed(userId);
  }

  async revoke(userId: string, roleKey: string) {
    const [key] = this.checkRoles([roleKey]);
    const families = await this.db.platform(async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { key: key! } });
      const r = await tx.platformRoleAssignment.updateMany({
        where: { userId, roleId: role.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (r.count === 0) throw new DomainException('http.not_found');
      await this.audit.record(tx, {
        action: 'platform.role.revoked',
        subjectType: 'core.user_account',
        subjectId: userId,
        before: { role: key! },
      });
      const remaining = await tx.platformRoleAssignment.count({ where: { userId, revokedAt: null } });
      if (remaining > 0) return [];
      const sessions = await tx.authSession.findMany({
        where: { userId, audience: 'platform', revokedAt: null },
        distinct: ['familyId'],
        select: { familyId: true },
      });
      await tx.authSession.updateMany({
        where: { userId, audience: 'platform', revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'admin' },
      });
      return sessions.map((s) => s.familyId);
    });
    for (const f of families) await this.tokens.markFamilyRevoked(f);
    await this.access.changed(userId);
  }
}
