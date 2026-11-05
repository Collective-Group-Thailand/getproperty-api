import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { hashPassword } from '@core/identity/crypto/password';
import { readableCode, tokenHash } from '@core/identity/crypto/secrets';
import { residentUnitRoles } from '@core/identity/resident-units';
import { SettingsService } from '@core/settings/settings.service';
import { AccessService } from '@core/tenancy/access.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type GateKind,
  type GateState,
  type Prisma,
  type VisitInviteState,
  type VisitKind,
} from '@generated/prisma/client';
import { residentUserId } from '@modules/ops-juristic/resident-unit-access';
import { Inject, Injectable } from '@nestjs/common';

import { newInviteToken, normalisePlate, type PlateInput, type PolicyActionName } from './gate-rules';
import { GuardAuthService } from './guard-auth.service';
import { GATE_UNIT_ROLES, HOUSEHOLD_DECIDERS, VisitsService } from './visits.service';

const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

const reasonText = (value: string | null | undefined, path = 'reason', min = 5, max = 500): string => {
  const text = value?.trim() ?? '';
  if (text.length < min || text.length > max) throw invalid(path, 'length', `${min}–${max} characters`);
  return text;
};

const pinOk = (pin: string) => {
  if (!/^[0-9]{4,6}$/.test(pin)) throw invalid('pin', 'pin', '4–6 digits');
  if (/^(\d)\1+$/.test(pin)) throw invalid('pin', 'pin_weak', 'not the same digit repeated');
  return pin;
};

export interface PolicyInput {
  timeoutSeconds?: number | null;
  action?: PolicyActionName | null;
  deliverySkipApproval?: boolean | null;
  householdNote?: string | null;
}

export interface InviteInput {
  usage: 'single' | 'multi';
  visitorKind: Exclude<VisitKind, 'resident_vehicle'>;
  validFrom: string;
  validTo: string;
  maxUses?: number | null;
  plate?: PlateInput | null;
  visitorName?: string | null;
  note?: string | null;
}

/**
 * The operator side of the gate (J4.1, D-315, D-320, D-327): gates, tablets (enrolment codes, revoke), guards and
 * PINs, unit house policies, the estate blacklist, contractor invite approvals and the reason-logged visit log — and
 * the resident household side (house policy, invites, remembered cars) of a unit the resident holds a role on.
 */
@Injectable()
export class GateAdminService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
    private readonly guards: GuardAuthService,
    private readonly visits: VisitsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private now(): Date {
    return this.clock.now();
  }

  private by(): string | null {
    return userIdOf(RequestContext.actor());
  }

  private async property(tx: Tx, ctx: TenantContext, propertyId: string) {
    return this.found(
      await tx.property.findFirst({ where: { id: propertyId, tenantId: ctx.tenantId, deletedAt: null } }),
    );
  }

  private async gate(tx: Tx, ctx: TenantContext, gateId: string) {
    return this.found(await tx.gate.findFirst({ where: this.own(ctx, { id: gateId }) }));
  }

  // ------------------------------------------------------------------------------------------------ gates

  async createGate(ctx: TenantContext, input: { propertyId: string; name: string; kind?: GateKind }) {
    const name = input.name?.trim() ?? '';
    if (name.length < 1 || name.length > 120) throw invalid('name', 'length', '1–120 characters');
    return this.db.tenant(ctx, async (tx) => {
      await this.property(tx, ctx, input.propertyId);
      const clash = await tx.gate.findFirst({ where: { propertyId: input.propertyId, name } });
      if (clash) throw new DomainException('http.conflict');
      const gate = await tx.gate.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId: input.propertyId,
          name,
          kind: input.kind ?? 'main',
          createdBy: this.by(),
          updatedBy: this.by(),
        },
      });
      await this.audit.record(tx, {
        action: 'gate.created',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate',
        subjectId: gate.id,
        after: { name, kind: gate.kind, propertyId: gate.propertyId },
      });
      await this.events.record(tx, {
        type: 'gate.created',
        aggregateType: 'gate',
        aggregateId: gate.id,
        tenantId: ctx.tenantId,
        payload: { gateId: gate.id, propertyId: gate.propertyId },
      });
      return gate;
    });
  }

  listGates(ctx: TenantContext, propertyId?: string) {
    return this.db.tenant(ctx, (tx) =>
      tx.gate.findMany({
        where: this.own(ctx, propertyId ? { propertyId } : {}),
        orderBy: [{ propertyId: 'asc' }, { name: 'asc' }],
        include: { devices: { where: { state: { not: 'revoked' } }, select: { id: true } } },
      }),
    );
  }

  getGate(ctx: TenantContext, gateId: string) {
    return this.db.tenant(ctx, (tx) => this.gate(tx, ctx, gateId));
  }

  async updateGate(
    ctx: TenantContext,
    gateId: string,
    input: { name?: string; kind?: GateKind; state?: GateState; barrier?: boolean; lpr?: boolean },
  ) {
    const name = input.name?.trim();
    if (name !== undefined && (name.length < 1 || name.length > 120))
      throw invalid('name', 'length', '1–120 characters');
    return this.db.tenant(ctx, async (tx) => {
      const before = await this.gate(tx, ctx, gateId);
      if (name && name !== before.name) {
        const clash = await tx.gate.findFirst({ where: { propertyId: before.propertyId, name } });
        if (clash) throw new DomainException('http.conflict');
      }
      const gate = await tx.gate.update({
        where: { id: gateId },
        data: {
          ...(name ? { name } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.state ? { state: input.state } : {}),
          ...(input.barrier !== undefined ? { barrier: input.barrier } : {}),
          ...(input.lpr !== undefined ? { lpr: input.lpr } : {}),
          updatedBy: this.by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'gate.updated',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate',
        subjectId: gateId,
        before: {
          name: before.name,
          kind: before.kind,
          state: before.state,
          barrier: before.barrier,
          lpr: before.lpr,
        },
        after: { name: gate.name, kind: gate.kind, state: gate.state, barrier: gate.barrier, lpr: gate.lpr },
      });
      await this.events.record(tx, {
        type: 'gate.changed',
        aggregateType: 'gate',
        aggregateId: gateId,
        tenantId: ctx.tenantId,
        payload: { gateId, state: gate.state },
      });
      return gate;
    });
  }

  // ------------------------------------------------------------------------------------------------ tablets

  /** A tablet slot with a one-time enrolment code (shown once, `gate.device_enrol_hours`). */
  async addDevice(ctx: TenantContext, gateId: string, name: string) {
    const label = name?.trim() ?? '';
    if (label.length < 1 || label.length > 120) throw invalid('name', 'length', '1–120 characters');
    const code = readableCode(3);
    const now = this.now();
    return this.db.tenant(ctx, async (tx) => {
      const gate = await this.gate(tx, ctx, gateId);
      const hours = await this.settings.valueAt<number>('gate.device_enrol_hours', now, {
        tenantId: ctx.tenantId,
      });
      const expiresAt = new Date(now.getTime() + hours * 3_600_000);
      const device = await tx.gateDevice.create({
        data: {
          tenantId: ctx.tenantId,
          gateId: gate.id,
          kind: 'guard_tablet',
          name: label,
          state: 'pending',
          enrolCodeHash: tokenHash(code),
          enrolExpiresAt: expiresAt,
          createdBy: this.by(),
          updatedBy: this.by(),
        },
      });
      await this.audit.record(tx, {
        action: 'gate.device_added',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_device',
        subjectId: device.id,
        metadata: { gateId },
      });
      await this.events.record(tx, {
        type: 'gate.device_added',
        aggregateType: 'gate_device',
        aggregateId: device.id,
        tenantId: ctx.tenantId,
        payload: { gateId, gateDeviceId: device.id },
      });
      return { device, enrolCode: code, expiresAt };
    });
  }

  listDevices(ctx: TenantContext, gateId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.gate(tx, ctx, gateId);
      return tx.gateDevice.findMany({ where: this.own(ctx, { gateId }), orderBy: { createdAt: 'asc' } });
    });
  }

  /** Revokes a tablet: its open shifts end and their sessions stop at once. Idempotent. */
  async revokeDevice(ctx: TenantContext, gateId: string, deviceId: string, reason: string) {
    const text = reasonText(reason, 'reason', 3);
    const families: (string | null)[] = [];
    const device = await this.db.tenant(ctx, async (tx) => {
      await this.gate(tx, ctx, gateId);
      const d = this.found(await tx.gateDevice.findFirst({ where: this.own(ctx, { id: deviceId, gateId }) }));
      if (d.state === 'revoked') return d;
      const updated = await tx.gateDevice.update({
        where: { id: d.id },
        data: {
          state: 'revoked',
          revokedAt: this.now(),
          revokedBy: this.by(),
          revokeReason: text,
          enrolCodeHash: null,
          secretHash: null,
          version: { increment: 1 },
        },
      });
      const open = await tx.guardShift.findMany({ where: { gateDeviceId: d.id, endedAt: null } });
      for (const s of open) families.push(await this.guards.closeShift(tx, s.id, 'device_revoked'));
      await this.audit.record(tx, {
        action: 'gate.device_revoked',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_device',
        subjectId: d.id,
        metadata: { reason: text, shiftsEnded: open.length },
      });
      await this.events.record(tx, {
        type: 'gate.device_revoked',
        aggregateType: 'gate_device',
        aggregateId: d.id,
        tenantId: ctx.tenantId,
        payload: { gateId, gateDeviceId: d.id },
      });
      return updated;
    });
    await this.guards.afterClose(families);
    return device;
  }

  // ------------------------------------------------------------------------------------------------ guards

  /** A guard of a property: credential-less login + membership role `guard` + the PIN (argon2id). */
  async createGuard(ctx: TenantContext, input: { propertyId: string; displayName: string; pin: string }) {
    const name = input.displayName?.trim() ?? '';
    if (name.length < 1 || name.length > 80) throw invalid('displayName', 'length', '1–80 characters');
    const pinHash = await hashPassword(pinOk(input.pin));
    await this.db.tenant(ctx, (tx) => this.property(tx, ctx, input.propertyId));
    const by = this.by();
    const guard = await this.db.platform(async (tx) => {
      // core.user_account needs a contact (asset-core CHECK); a guard has none — a never-verified, non-routable
      // address under the reserved `.invalid` TLD (RFC 2606) satisfies it and can never receive anything (D-327)
      const userId = uuidv7(this.now().getTime());
      const user = await tx.userAccount.create({
        data: {
          id: userId,
          email: `guard-${userId}@gate.getproperty.invalid`,
          displayName: name,
          language: 'th',
          createdBy: by,
          updatedBy: by,
        },
      });
      await tx.membership.create({
        data: {
          tenantId: ctx.tenantId,
          userId: user.id,
          role: 'guard',
          status: 'active',
          joinedAt: this.now(),
          createdBy: by,
          updatedBy: by,
        },
      });
      const g = await tx.gateGuard.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId: input.propertyId,
          userId: user.id,
          displayName: name,
          pinHash,
          createdBy: by,
          updatedBy: by,
        },
      });
      await this.audit.record(tx, {
        action: 'gate.guard_created',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_guard',
        subjectId: g.id,
        metadata: { propertyId: input.propertyId, userId: user.id },
      });
      await this.events.record(tx, {
        type: 'gate.guard_changed',
        aggregateType: 'gate_guard',
        aggregateId: g.id,
        tenantId: ctx.tenantId,
        payload: { guardId: g.id, change: 'created' },
      });
      return g;
    });
    return guard;
  }

  listGuards(ctx: TenantContext, propertyId?: string) {
    return this.db.tenant(ctx, (tx) =>
      tx.gateGuard.findMany({
        where: this.own(ctx, propertyId ? { propertyId } : {}),
        orderBy: [{ state: 'asc' }, { displayName: 'asc' }],
        include: {
          shifts: { where: { endedAt: null }, select: { id: true, gateId: true, startedAt: true } },
        },
      }),
    );
  }

  private async guardRow(tx: Tx, ctx: TenantContext, guardId: string) {
    return this.found(await tx.gateGuard.findFirst({ where: this.own(ctx, { id: guardId }) }));
  }

  async updateGuard(ctx: TenantContext, guardId: string, input: { displayName?: string; pin?: string }) {
    const name = input.displayName?.trim();
    if (name !== undefined && (name.length < 1 || name.length > 80))
      throw invalid('displayName', 'length', '1–80 characters');
    const pinHash = input.pin ? await hashPassword(pinOk(input.pin)) : null;
    return this.db.tenant(ctx, async (tx) => {
      const g = await this.guardRow(tx, ctx, guardId);
      if (g.state !== 'active') throw new DomainException('http.conflict');
      const updated = await tx.gateGuard.update({
        where: { id: g.id },
        data: {
          ...(name ? { displayName: name } : {}),
          ...(pinHash ? { pinHash, pinSetAt: this.now(), failedAttempts: 0, lockedUntil: null } : {}),
          updatedBy: this.by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: pinHash ? 'gate.guard_pin_reset' : 'gate.guard_updated',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_guard',
        subjectId: g.id,
        metadata: { renamed: Boolean(name), pinReset: Boolean(pinHash) },
      });
      await this.events.record(tx, {
        type: 'gate.guard_changed',
        aggregateType: 'gate_guard',
        aggregateId: g.id,
        tenantId: ctx.tenantId,
        payload: { guardId: g.id, change: pinHash ? 'pin_reset' : 'renamed' },
      });
      return updated;
    });
  }

  /** Revokes a guard: membership removed, open shift ended, sessions stop at once. Idempotent. */
  async revokeGuard(ctx: TenantContext, guardId: string, reason: string) {
    const text = reasonText(reason, 'reason', 3);
    const families: (string | null)[] = [];
    const g0 = await this.db.tenant(ctx, (tx) => this.guardRow(tx, ctx, guardId));
    if (g0.state === 'revoked') return g0;
    const guard = await this.db.platform(async (tx) => {
      const g = await tx.gateGuard.update({
        where: { id: g0.id },
        data: {
          state: 'revoked',
          revokedAt: this.now(),
          revokeReason: text,
          updatedBy: this.by(),
          version: { increment: 1 },
        },
      });
      await tx.membership.updateMany({
        where: { tenantId: ctx.tenantId, userId: g.userId, role: 'guard', deletedAt: null },
        data: {
          status: 'removed',
          removedAt: this.now(),
          removedReason: 'guard_revoked',
          updatedBy: this.by(),
        },
      });
      await tx.userAccount.update({
        where: { id: g.userId },
        data: { status: 'disabled', disabledAt: this.now(), disabledReason: 'guard_revoked' },
      });
      const open = await tx.guardShift.findMany({ where: { guardId: g.id, endedAt: null } });
      for (const s of open) families.push(await this.guards.closeShift(tx, s.id, 'guard_revoked'));
      await this.audit.record(tx, {
        action: 'gate.guard_revoked',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_guard',
        subjectId: g.id,
        metadata: { reason: text },
      });
      await this.events.record(tx, {
        type: 'gate.guard_changed',
        aggregateType: 'gate_guard',
        aggregateId: g.id,
        tenantId: ctx.tenantId,
        payload: { guardId: g.id, change: 'revoked' },
      });
      return g;
    });
    await this.guards.afterClose(families);
    await this.access.changed(guard.userId);
    return guard;
  }

  // ------------------------------------------------------------------------------------------------ house policy

  /** The unit's effective policy (its own row or the estate defaults). */
  async unitPolicy(ctx: TenantContext, unitId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const unit = this.found(
        await tx.unit.findFirst({ where: { id: unitId, tenantId: ctx.tenantId, deletedAt: null } }),
      );
      return { unit, policy: await this.visits.policyOf(tx, ctx.tenantId, unit.propertyId, unit.id) };
    });
  }

  async setUnitPolicy(ctx: TenantContext, unitId: string, input: PolicyInput) {
    await this.db.tenant(ctx, async (tx) => {
      const unit = this.found(
        await tx.unit.findFirst({ where: { id: unitId, tenantId: ctx.tenantId, deletedAt: null } }),
      );
      await this.writePolicy(tx, ctx.tenantId, unit, input, 'operator');
    });
    return this.unitPolicy(ctx, unitId);
  }

  private async writePolicy(
    tx: Tx,
    tenantId: string,
    unit: { id: string; propertyId: string },
    input: PolicyInput,
    by: 'operator' | 'resident',
  ) {
    if (
      input.timeoutSeconds != null &&
      (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 60 || input.timeoutSeconds > 900)
    )
      throw invalid('timeoutSeconds', 'range', 'an integer 60–900');
    const note = input.householdNote === undefined ? undefined : input.householdNote?.trim() || null;
    if (note && note.length > 300) throw invalid('householdNote', 'maxLength', 'at most 300 characters');
    const current = await this.visits.policyOf(tx, tenantId, unit.propertyId, unit.id);
    const data = {
      timeoutSeconds: input.timeoutSeconds ?? current.timeoutSeconds,
      action: input.action ?? current.action,
      deliverySkipApproval:
        input.deliverySkipApproval === undefined ? current.deliverySkipApproval : input.deliverySkipApproval,
      householdNote: note === undefined ? current.householdNote : note,
    };
    const row = await tx.houseGatePolicy.upsert({
      where: { unitId: unit.id },
      create: { tenantId, unitId: unit.id, ...data, createdBy: this.by(), updatedBy: this.by() },
      update: { ...data, updatedBy: this.by(), updatedAt: this.now(), version: { increment: 1 } },
    });
    await this.audit.record(tx, {
      action: 'gate.policy_updated',
      tenantId,
      subjectType: 'smart.house_gate_policy',
      subjectId: row.id,
      before: {
        timeoutSeconds: current.timeoutSeconds,
        action: current.action,
        deliverySkipApproval: current.deliverySkipApproval,
      },
      after: {
        timeoutSeconds: data.timeoutSeconds,
        action: data.action,
        deliverySkipApproval: data.deliverySkipApproval,
      },
      metadata: { unitId: unit.id, by },
    });
    await this.events.record(tx, {
      type: 'gate.policy.changed',
      aggregateType: 'house_gate_policy',
      aggregateId: row.id,
      tenantId,
      payload: { unitId: unit.id, by },
    });
    return row;
  }

  // ------------------------------------------------------------------------------------------------ blacklist

  listBlacklist(ctx: TenantContext, propertyId?: string, includeRevoked = false) {
    return this.db.tenant(ctx, (tx) =>
      tx.gateBlacklist.findMany({
        where: this.own(ctx, {
          ...(propertyId ? { propertyId } : {}),
          ...(includeRevoked ? {} : { revokedAt: null }),
        }),
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async addBlacklist(ctx: TenantContext, input: { propertyId: string; plate: PlateInput; reason: string }) {
    const plate = normalisePlate(input.plate);
    if (!plate) throw invalid('plate', 'required', 'the full plate');
    const reason = reasonText(input.reason);
    return this.db.tenant(ctx, async (tx) => {
      await this.property(tx, ctx, input.propertyId);
      const live = await tx.gateBlacklist.findFirst({
        where: {
          propertyId: input.propertyId,
          plateCategory: plate.category,
          plateNumber: plate.number,
          plateProvince: plate.province,
          revokedAt: null,
        },
      });
      if (live) throw new DomainException('gate.blacklist_exists');
      const row = await tx.gateBlacklist.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId: input.propertyId,
          plateCategory: plate.category,
          plateNumber: plate.number,
          plateProvince: plate.province,
          reason,
          createdBy: this.by(),
          createdAt: this.now(),
        },
      });
      await this.audit.record(tx, {
        action: 'gate.blacklist_added',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_blacklist',
        subjectId: row.id,
        metadata: { propertyId: input.propertyId, reason },
      });
      await this.events.record(tx, {
        type: 'gate.blacklist.changed',
        aggregateType: 'gate_blacklist',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        payload: { blacklistId: row.id, change: 'added' },
      });
      return row;
    });
  }

  async revokeBlacklist(ctx: TenantContext, id: string, reason: string) {
    const text = reasonText(reason);
    return this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.gateBlacklist.findFirst({ where: this.own(ctx, { id }) }));
      if (row.revokedAt) return row;
      const updated = await tx.gateBlacklist.update({
        where: { id },
        data: { revokedAt: this.now(), revokedBy: this.by(), revokeReason: text },
      });
      await this.audit.record(tx, {
        action: 'gate.blacklist_revoked',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_blacklist',
        subjectId: id,
        metadata: { reason: text },
      });
      await this.events.record(tx, {
        type: 'gate.blacklist.changed',
        aggregateType: 'gate_blacklist',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { blacklistId: id, change: 'revoked' },
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------------ invites (operator)

  listInvites(ctx: TenantContext, filter: { state?: VisitInviteState; unitId?: string }) {
    return this.db.tenant(ctx, (tx) =>
      tx.visitInvite.findMany({
        where: this.own(ctx, {
          ...(filter.state ? { state: filter.state } : {}),
          ...(filter.unitId ? { unitId: filter.unitId } : {}),
        }),
        include: { unit: { select: { unitNo: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  /** Contractor invites wait for the operator (D-315): approve or reject (reason) — the resident is told. */
  async decideInvite(ctx: TenantContext, id: string, decision: 'approve' | 'reject', reason?: string | null) {
    const text = decision === 'reject' ? reasonText(reason, 'reason', 3) : null;
    return this.db.tenant(ctx, async (tx) => {
      const inv = this.found(await tx.visitInvite.findFirst({ where: this.own(ctx, { id }) }));
      const target = decision === 'approve' ? 'active' : 'rejected';
      if (inv.state === target) return inv;
      if (inv.state !== 'pending_approval')
        throw new DomainException('visit_invite.not_active', { params: { state: inv.state } });
      const updated = await tx.visitInvite.update({
        where: { id },
        data:
          decision === 'approve'
            ? { state: 'active', approvedAt: this.now(), approvedBy: this.by(), version: { increment: 1 } }
            : {
                state: 'rejected',
                rejectedAt: this.now(),
                rejectedBy: this.by(),
                rejectReason: text,
                version: { increment: 1 },
              },
      });
      await this.audit.record(tx, {
        action: decision === 'approve' ? 'gate.invite_approved' : 'gate.invite_rejected',
        tenantId: ctx.tenantId,
        subjectType: 'smart.visit_invite',
        subjectId: id,
        metadata: text ? { reason: text } : {},
      });
      await this.events.record(tx, {
        type: decision === 'approve' ? 'gate.invite.approved' : 'gate.invite.rejected',
        aggregateType: 'visit_invite',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { inviteId: id, unitId: inv.unitId, createdByUserId: inv.createdByUserId },
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------------ visit log

  /**
   * The estate's visit log (D-315 PDPA): only with a reason, one audit row per read. Staff limited to buildings see
   * only visits to units of their buildings (and none without a unit).
   */
  async visitLog(
    ctx: TenantContext,
    reason: string,
    filter: {
      propertyId?: string;
      gateId?: string;
      unitId?: string;
      state?: string;
      from?: string;
      to?: string;
    },
    skip: number,
    take: number,
  ) {
    const text = reasonText(reason);
    const where: Prisma.VisitWhereInput = this.own(ctx, {
      ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
      ...(filter.gateId ? { gateId: filter.gateId } : {}),
      ...(filter.unitId ? { unitId: filter.unitId } : {}),
      ...(filter.state ? { state: filter.state as never } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: new Date(filter.from) } : {}),
              ...(filter.to ? { lt: new Date(filter.to) } : {}),
            },
          }
        : {}),
      ...(ctx.buildingIds ? { unit: { buildingId: { in: [...ctx.buildingIds] } } } : {}),
    });
    return this.db.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.visit.findMany({
          where,
          include: {
            unit: { select: { id: true, unitNo: true, buildingId: true } },
            gate: { select: { id: true, name: true } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take,
        }),
        tx.visit.count({ where }),
      ]);
      await this.audit.record(tx, {
        action: 'gate.visit_log_read',
        tenantId: ctx.tenantId,
        subjectType: 'smart.visit',
        subjectId: null,
        metadata: { reason: text, filter, returned: rows.length },
      });
      return { rows, total };
    });
  }

  async visitLogGet(ctx: TenantContext, id: string, reason: string) {
    const text = reasonText(reason);
    return this.db.tenant(ctx, async (tx) => {
      const v = this.found(
        await tx.visit.findFirst({
          where: {
            id,
            tenantId: ctx.tenantId,
            ...(ctx.buildingIds ? { unit: { buildingId: { in: [...ctx.buildingIds] } } } : {}),
          },
          include: {
            unit: { select: { id: true, unitNo: true, buildingId: true } },
            gate: { select: { id: true, name: true } },
          },
        }),
      );
      const events = await tx.visitEvent.findMany({ where: { visitId: id }, orderBy: { id: 'asc' } });
      await this.audit.record(tx, {
        action: 'gate.visit_log_read',
        tenantId: ctx.tenantId,
        subjectType: 'smart.visit',
        subjectId: id,
        metadata: { reason: text },
      });
      return { visit: v, events };
    });
  }

  // ------------------------------------------------------------------------------------------------ resident household

  /** A unit the resident holds one of `roles` on today, with its gate tenant context; else 404. */
  private async householdUnit(unitId: string, roles: readonly string[]) {
    const userId = residentUserId();
    const today = bangkokDate(this.now());
    return this.db.platform(async (tx) => {
      const onUnit = (await residentUnitRoles(tx, userId, today)).filter((r) => r.unitId === unitId);
      if (!onUnit.some((r) => roles.includes(r.role))) throw new DomainException('http.not_found');
      const unit = this.found(await tx.unit.findUnique({ where: { id: unitId } }));
      return {
        userId,
        unit,
        canDecide: onUnit.some((r) => (HOUSEHOLD_DECIDERS as readonly string[]).includes(r.role)),
        ctx: { tenantId: unit.tenantId, source: 'path' as const },
      };
    });
  }

  /** `GET /v1/resident/units/{unitId}/gate`: my house policy, whether the estate has a gate, the privacy notice. */
  async residentGate(unitId: string) {
    const { unit, ctx, canDecide } = await this.householdUnit(unitId, GATE_UNIT_ROLES);
    return this.db.tenant(ctx, async (tx) => ({
      unit,
      policy: await this.visits.policyOf(tx, unit.tenantId, unit.propertyId, unit.id),
      gates: await tx.gate.findMany({
        where: { tenantId: unit.tenantId, propertyId: unit.propertyId, state: 'active' },
        select: { id: true, name: true, kind: true },
        orderBy: { name: 'asc' },
      }),
      notice: await this.visits.privacyNotice(unit.tenantId),
      canEdit: canDecide,
    }));
  }

  async residentSetPolicy(unitId: string, input: PolicyInput) {
    const { unit, ctx } = await this.householdUnit(unitId, HOUSEHOLD_DECIDERS);
    await this.db.tenant(ctx, (tx) => this.writePolicy(tx, unit.tenantId, unit, input, 'resident'));
    return this.residentGate(unitId);
  }

  /** A visitor invite of my unit; the QR token is returned once. Contractors wait for the operator. */
  async createInvite(unitId: string, input: InviteInput) {
    const { userId, unit, ctx } = await this.householdUnit(unitId, HOUSEHOLD_DECIDERS);
    const now = this.now();
    const from = new Date(input.validFrom);
    const to = new Date(input.validTo);
    if (Number.isNaN(from.getTime())) throw invalid('validFrom', 'isDate', 'an ISO 8601 instant');
    if (Number.isNaN(to.getTime()) || to <= from) throw invalid('validTo', 'after', 'after validFrom');
    if (to <= now) throw invalid('validTo', 'future', 'in the future');
    const maxDays = await this.settings.valueAt<number>('gate.invite_max_days', now, {
      tenantId: unit.tenantId,
      propertyId: unit.propertyId,
    });
    if (to.getTime() - from.getTime() > maxDays * 86_400_000)
      throw new DomainException('visit_invite.window_too_long', { params: { days: maxDays } });
    const maxUses = input.usage === 'single' ? 1 : (input.maxUses ?? 10);
    if (input.usage === 'multi' && (!Number.isInteger(maxUses) || maxUses < 2 || maxUses > 100))
      throw invalid('maxUses', 'range', 'an integer 2–100 for a multi-use invite');
    const plate = normalisePlate(input.plate);
    const visitorName = input.visitorName?.trim() || null;
    if (visitorName && visitorName.length > 120)
      throw invalid('visitorName', 'maxLength', 'at most 120 characters');
    const note = input.note?.trim() || null;
    if (note && note.length > 300) throw invalid('note', 'maxLength', 'at most 300 characters');
    const { token, hash } = newInviteToken();
    const state: VisitInviteState = input.visitorKind === 'contractor' ? 'pending_approval' : 'active';
    const invite = await this.db.tenant(ctx, async (tx) => {
      const gates = await tx.gate.count({ where: { tenantId: unit.tenantId, propertyId: unit.propertyId } });
      if (!gates) throw new DomainException('http.not_found');
      const row = await tx.visitInvite.create({
        data: {
          tenantId: unit.tenantId,
          propertyId: unit.propertyId,
          unitId: unit.id,
          createdByUserId: userId,
          usage: input.usage,
          visitorKind: input.visitorKind,
          state,
          validFrom: from,
          validTo: to,
          maxUses,
          plateCategory: plate?.category ?? null,
          plateNumber: plate?.number ?? null,
          plateProvince: plate?.province ?? null,
          visitorName,
          note,
          tokenHash: new Uint8Array(hash),
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'gate.invite_created',
        tenantId: unit.tenantId,
        subjectType: 'smart.visit_invite',
        subjectId: row.id,
        metadata: { unitId: unit.id, usage: input.usage, visitorKind: input.visitorKind, state },
      });
      await this.events.record(tx, {
        type: state === 'pending_approval' ? 'gate.invite.approval_required' : 'gate.invite.created',
        aggregateType: 'visit_invite',
        aggregateId: row.id,
        tenantId: unit.tenantId,
        buildingId: unit.buildingId,
        payload: { inviteId: row.id, unitId: unit.id, state },
      });
      return row;
    });
    return { invite, token };
  }

  async residentInvites(unitId: string) {
    const { unit, ctx } = await this.householdUnit(unitId, GATE_UNIT_ROLES);
    return this.db.tenant(ctx, (tx) =>
      tx.visitInvite.findMany({
        where: { unitId: unit.id, tenantId: unit.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  async revokeInvite(unitId: string, inviteId: string) {
    const { userId, unit, ctx } = await this.householdUnit(unitId, HOUSEHOLD_DECIDERS);
    return this.db.tenant(ctx, async (tx) => {
      const inv = this.found(await tx.visitInvite.findFirst({ where: { id: inviteId, unitId: unit.id } }));
      if (inv.state === 'revoked') return inv;
      const updated = await tx.visitInvite.update({
        where: { id: inv.id },
        data: { state: 'revoked', revokedAt: this.now(), revokedBy: userId, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'gate.invite_revoked',
        tenantId: unit.tenantId,
        subjectType: 'smart.visit_invite',
        subjectId: inv.id,
        metadata: { unitId: unit.id },
      });
      await this.events.record(tx, {
        type: 'gate.invite.revoked',
        aggregateType: 'visit_invite',
        aggregateId: inv.id,
        tenantId: unit.tenantId,
        payload: { inviteId: inv.id, unitId: unit.id },
      });
      return updated;
    });
  }

  async residentVehicles(unitId: string) {
    const { unit, ctx } = await this.householdUnit(unitId, GATE_UNIT_ROLES);
    return this.db.tenant(ctx, (tx) =>
      tx.rememberedVehicle.findMany({
        where: { unitId: unit.id, revokedAt: null, expiresAt: { gt: this.now() } },
        orderBy: { expiresAt: 'desc' },
      }),
    );
  }

  async rememberVehicle(
    unitId: string,
    input: { plate: PlateInput; kind?: 'resident' | 'visitor'; label?: string | null; days?: number | null },
  ) {
    const { userId, unit, ctx } = await this.householdUnit(unitId, HOUSEHOLD_DECIDERS);
    const plate = normalisePlate(input.plate);
    if (!plate) throw invalid('plate', 'required', 'the full plate');
    const label = input.label?.trim() || null;
    if (label && label.length > 80) throw invalid('label', 'maxLength', 'at most 80 characters');
    if (input.days != null && (!Number.isInteger(input.days) || input.days < 1))
      throw invalid('days', 'min', 'at least 1 day');
    return this.db.tenant(ctx, (tx) =>
      this.visits.rememberIn(tx, {
        tenantId: unit.tenantId,
        propertyId: unit.propertyId,
        unitId: unit.id,
        plate,
        kind: input.kind ?? 'visitor',
        label,
        userId,
        ...(input.days ? { days: input.days } : {}),
      }),
    );
  }

  async forgetVehicle(unitId: string, vehicleId: string) {
    const { unit, ctx } = await this.householdUnit(unitId, HOUSEHOLD_DECIDERS);
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(
        await tx.rememberedVehicle.findFirst({ where: { id: vehicleId, unitId: unit.id } }),
      );
      if (row.revokedAt) return;
      await tx.rememberedVehicle.update({
        where: { id: row.id },
        data: { revokedAt: this.now(), updatedAt: this.now() },
      });
      await this.audit.record(tx, {
        action: 'gate.vehicle_forgotten',
        tenantId: unit.tenantId,
        subjectType: 'smart.remembered_vehicle',
        subjectId: row.id,
        metadata: { unitId: unit.id },
      });
      await this.events.record(tx, {
        type: 'gate.vehicle_remembered',
        aggregateType: 'remembered_vehicle',
        aggregateId: row.id,
        tenantId: unit.tenantId,
        payload: { rememberedVehicleId: row.id, unitId: unit.id, forgotten: true },
      });
    });
  }
}
