import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { sameDigest } from '@common/crypto/hashing';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type TokenPair } from '@core/identity/auth.service';
import { verifyPassword } from '@core/identity/crypto/password';
import { opaqueToken, tokenHash } from '@core/identity/crypto/secrets';
import { SessionService } from '@core/identity/session.service';
import { guardScopes } from '@core/identity/subjects.service';
import { TokenService } from '@core/identity/token.service';
import { SettingsService } from '@core/settings/settings.service';
import { AccessService, permissionsOf } from '@core/tenancy/access.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type GuardShiftEndReason } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

export interface EnrolResult {
  deviceId: string;
  deviceSecret: string;
  gate: { id: string; name: string };
  property: { id: string; name: string };
  tenant: { id: string; name: string };
}

/**
 * Gate tablets and guard sign-in (J4.1, D-320, D-327). A tablet enrols once with the owner's one-time code and keeps
 * a device secret (sha256 at rest). On the tablet a guard of the gate's property signs in with a PIN (argon2id;
 * lockout after `gate.pin_max_attempts`): the sign-in is a shift and a refresh family of audience `guard` whose scopes
 * name the tenant, property, gate, tablet and shift. Ending a shift (sign-out, another shift of the same guard, a
 * revoked tablet or guard) revokes the family at once. Identity lookups run as gp_platform.
 */
@Injectable()
export class GuardAuthService {
  constructor(
    private readonly db: TenantTx,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private now(): Date {
    return this.clock.now();
  }

  /** `POST /v1/auth/guard/devices/enrol`: the one-time code becomes a device secret (shown once). */
  async enrol(code: string, name: string | undefined): Promise<EnrolResult> {
    const now = this.now();
    const secret = opaqueToken();
    return RequestContext.run({ actor: systemActor('gate-enrol') }, () =>
      this.db.platform(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM smart.gate_device
           WHERE enrol_code_hash = ${Buffer.from(tokenHash(normaliseCode(code)))} AND state = 'pending'
             AND enrol_expires_at > ${now.toISOString()}::timestamptz
           FOR UPDATE`;
        if (!rows[0]) throw new DomainException('gate.enrol_code_invalid');
        const device = await tx.gateDevice.update({
          where: { id: rows[0].id },
          data: {
            state: 'active',
            secretHash: tokenHash(secret),
            enrolCodeHash: null,
            enrolExpiresAt: null,
            enrolledAt: now,
            lastSeenAt: now,
            ...(name?.trim() ? { name: name.trim().slice(0, 120) } : {}),
            version: { increment: 1 },
          },
          include: { gate: { include: { property: true, tenant: true } } },
        });
        await this.audit.record(tx, {
          action: 'gate.device_enrolled',
          tenantId: device.tenantId,
          subjectType: 'smart.gate_device',
          subjectId: device.id,
          metadata: { gateId: device.gateId },
        });
        await this.events.record(tx, {
          type: 'gate.device_enrolled',
          aggregateType: 'gate_device',
          aggregateId: device.id,
          tenantId: device.tenantId,
          payload: { gateId: device.gateId, gateDeviceId: device.id },
        });
        return {
          deviceId: device.id,
          deviceSecret: secret,
          gate: { id: device.gate.id, name: device.gate.name },
          property: { id: device.gate.property.id, name: device.gate.property.name },
          tenant: { id: device.gate.tenant.id, name: device.gate.tenant.displayName },
        };
      }),
    );
  }

  /** An active tablet by id + secret (401 `gate.device_unknown` otherwise; never says which part was wrong). */
  async device(tx: Tx, deviceId: string, secret: string) {
    const device = await tx.gateDevice.findUnique({
      where: { id: deviceId },
      include: { gate: { include: { property: true, tenant: true } } },
    });
    if (
      !device?.secretHash ||
      device.state !== 'active' ||
      device.kind !== 'guard_tablet' ||
      !sameDigest(device.secretHash, tokenHash(secret))
    )
      throw new DomainException('gate.device_unknown');
    if (device.gate.state !== 'active') throw new DomainException('gate.inactive');
    return device;
  }

  /** `POST /v1/auth/guard/roster`: the active guards of the tablet's property (id and display name only). */
  async roster(deviceId: string, secret: string) {
    return this.db.platform(async (tx) => {
      const device = await this.device(tx, deviceId, secret);
      await tx.gateDevice.update({ where: { id: device.id }, data: { lastSeenAt: this.now() } });
      const guards = await tx.gateGuard.findMany({
        where: { tenantId: device.tenantId, propertyId: device.gate.propertyId, state: 'active' },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        select: { id: true, displayName: true, lockedUntil: true },
      });
      return { device, guards };
    });
  }

  /**
   * `POST /v1/auth/guard/sign-in`: PIN check (a wrong PIN is counted in its own transaction, so the lockout survives
   * the refusal), then a new shift + refresh family; the guard's open shift elsewhere ends `superseded`.
   */
  async signIn(input: {
    deviceId: string;
    deviceSecret: string;
    guardId: string;
    pin: string;
  }): Promise<TokenPair> {
    const now = this.now();
    const checked = await this.db.platform(async (tx) => {
      const device = await this.device(tx, input.deviceId, input.deviceSecret);
      const guard = await tx.gateGuard.findFirst({
        where: {
          id: input.guardId,
          tenantId: device.tenantId,
          propertyId: device.gate.propertyId,
          state: 'active',
        },
      });
      const ok =
        Boolean(guard) &&
        !(guard!.lockedUntil && guard!.lockedUntil > now) &&
        /^[0-9]{4,6}$/.test(input.pin) &&
        (await verifyPassword(input.pin, guard!.pinHash));
      return { device, guard, ok };
    });
    const { device, guard } = checked;
    if (!guard || (guard.lockedUntil && guard.lockedUntil > now)) {
      await this.audit.recordAlone({
        action: 'gate.guard_sign_in_failed',
        tenantId: device.tenantId,
        outcome: 'denied',
        subjectType: 'smart.gate_device',
        subjectId: device.id,
        metadata: { reason: guard ? 'locked' : 'unknown_guard' },
      });
      if (guard?.lockedUntil)
        throw new DomainException('gate.pin_locked', {
          extensions: { lockedUntil: guard.lockedUntil.toISOString() },
        });
      throw new DomainException('gate.pin_invalid');
    }
    if (!checked.ok) {
      const scope = { tenantId: guard.tenantId, propertyId: device.gate.propertyId };
      const max = await this.settings.valueAt<number>('gate.pin_max_attempts', now, scope);
      const lockMinutes = await this.settings.valueAt<number>('gate.pin_lock_minutes', now, scope);
      const attempts = guard.failedAttempts + 1;
      const locked = attempts >= max;
      const lockedUntil = new Date(now.getTime() + lockMinutes * 60_000);
      await this.db.platform((tx) =>
        tx.gateGuard.update({
          where: { id: guard.id },
          data: locked ? { failedAttempts: 0, lockedUntil } : { failedAttempts: attempts },
        }),
      );
      await this.audit.recordAlone({
        action: 'gate.guard_sign_in_failed',
        tenantId: guard.tenantId,
        outcome: 'denied',
        subjectType: 'smart.gate_guard',
        subjectId: guard.id,
        metadata: { reason: 'wrong_pin', attempts, locked },
      });
      if (locked)
        throw new DomainException('gate.pin_locked', {
          extensions: { lockedUntil: lockedUntil.toISOString() },
        });
      throw new DomainException('gate.pin_invalid');
    }
    const pair = await this.db.platform(async (tx) => {
      const live = await tx.gateGuard.findUniqueOrThrow({ where: { id: guard.id } });
      if (live.state !== 'active') throw new DomainException('gate.pin_invalid');
      const open = await tx.guardShift.findMany({ where: { guardId: guard.id, endedAt: null } });
      for (const s of open) await this.closeShift(tx, s.id, 'superseded');
      const shiftId = uuidv7(now.getTime());
      const scopes = guardScopes({
        id: shiftId,
        tenantId: device.tenantId,
        gateId: device.gateId,
        gateDeviceId: device.id,
        gate: { propertyId: device.gate.propertyId },
      });
      const { session, refreshToken } = await this.sessions.start(tx, {
        audience: 'guard',
        userId: guard.userId,
        scopes,
      });
      await tx.guardShift.create({
        data: {
          id: shiftId,
          tenantId: device.tenantId,
          gateId: device.gateId,
          gateDeviceId: device.id,
          guardId: guard.id,
          sessionFamilyId: session.familyId,
          startedAt: now,
        },
      });
      await tx.gateGuard.update({ where: { id: guard.id }, data: { failedAttempts: 0, lockedUntil: null } });
      await tx.gateDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
      await tx.userAccount.update({ where: { id: guard.userId }, data: { lastLoginAt: now } });
      const access = this.tokens.issue({
        sub: guard.userId,
        aud: 'guard',
        sid: session.familyId,
        scopes,
        amr: ['pin'],
      });
      RequestContext.setActor({
        type: 'user',
        publicId: guard.userId,
        audience: 'guard',
        sessionId: session.familyId,
        scopes,
        amr: ['pin'],
      });
      await this.audit.record(tx, {
        action: 'gate.guard_signed_in',
        tenantId: device.tenantId,
        subjectType: 'smart.guard_shift',
        subjectId: shiftId,
        metadata: {
          gateId: device.gateId,
          gateDeviceId: device.id,
          guardId: guard.id,
          sessionId: session.familyId,
        },
      });
      await this.events.record(tx, {
        type: 'gate.shift_started',
        aggregateType: 'guard_shift',
        aggregateId: shiftId,
        tenantId: device.tenantId,
        payload: { shiftId, gateId: device.gateId, guardId: guard.id },
      });
      return {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken,
        refreshTokenExpiresAt: session.expiresAt,
        subject: {
          id: guard.userId,
          type: 'user' as const,
          audience: 'guard' as const,
          roles: ['guard'],
          permissions: [...permissionsOf(['guard'])].sort(),
          scopes,
        },
      } satisfies TokenPair;
    });
    await this.access.changed(guard.userId);
    return pair;
  }

  /**
   * Ends a shift inside the caller's transaction and revokes its refresh family; returns the family id so the caller
   * marks it revoked in Redis **after** the commit (`afterClose`), which stops its access tokens at once.
   */
  async closeShift(tx: Tx, shiftId: string, reason: GuardShiftEndReason): Promise<string | null> {
    const now = this.now();
    const ended = await tx.guardShift.updateMany({
      where: { id: shiftId, endedAt: null },
      data: { endedAt: now, endReason: reason },
    });
    if (ended.count !== 1) return null;
    const shift = await tx.guardShift.findUniqueOrThrow({ where: { id: shiftId } });
    await this.sessions.revokeFamily(tx, shift.sessionFamilyId, reason === 'signed_out' ? 'logout' : 'admin');
    await this.audit.record(tx, {
      action: 'gate.shift_ended',
      tenantId: shift.tenantId,
      subjectType: 'smart.guard_shift',
      subjectId: shift.id,
      metadata: { reason, gateId: shift.gateId, guardId: shift.guardId },
    });
    await this.events.record(tx, {
      type: 'gate.shift_ended',
      aggregateType: 'guard_shift',
      aggregateId: shift.id,
      tenantId: shift.tenantId,
      payload: { shiftId: shift.id, gateId: shift.gateId, guardId: shift.guardId, reason },
    });
    return shift.sessionFamilyId;
  }

  /** Marks the families of shifts closed in a committed transaction revoked (access tokens stop at once). */
  async afterClose(families: readonly (string | null)[]): Promise<void> {
    for (const f of families) if (f) await this.tokens.markFamilyRevoked(f);
  }

  /** `POST /v1/guard/shift/actions/end`: the guard signs out (shift and session end). */
  async endOwnShift(shiftId: string): Promise<void> {
    const family = await this.db.platform((tx) => this.closeShift(tx, shiftId, 'signed_out'));
    await this.afterClose([family]);
  }
}

/** Enrolment codes are typed by people: upper-case, spaces and dashes dropped. */
export function normaliseCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.match(/.{1,4}/g)?.join('-') ?? raw;
}
