import { type Tx } from '@database/prisma.service';
import { type NotificationAudience, type NotificationChannel } from '@generated/prisma/client';

import { type DomainEventEnvelope } from '../events/domain-events';

export interface Recipient {
  audience: NotificationAudience;
  type: 'user' | 'party';
  id: string;
  tenantId: string | null;
  language: string;
  line?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface NotificationPlanInput {
  recipients: Recipient[];
  data: Record<string, unknown>;
  /** Template key; defaults to the event type. */
  templateKey?: string;
  /** Explicit channels (test sends) instead of the routing matrix. */
  channels?: NotificationChannel[];
  /** Urgent messages ignore quiet hours (e.g. security). */
  urgent?: boolean;
  /** Consent purpose required for resident recipients (D-025). */
  consentPurpose?: string;
}

/**
 * Which domain events notify whom (B1.3 routing): each resolver returns the recipients and the template data. The
 * routing matrix (`platform.notification_route`, event × audience × channel, tenant overrides) decides the channels.
 * Later deliverables add resolvers here (invoice.issued in B4, …).
 */
export type NotifiableResolver = (
  tx: Tx,
  event: DomainEventEnvelope,
) => Promise<NotificationPlanInput | null>;

async function operators(
  tx: Tx,
  tenantId: string,
  roles: string[],
  audience: NotificationAudience,
): Promise<Recipient[]> {
  const rows = await tx.membership.findMany({
    where: { tenantId, role: { in: roles }, status: 'active', deletedAt: null, user: { status: 'active' } },
    include: { user: true },
  });
  return rows.map((m) => ({
    audience: (m.role as NotificationAudience) ?? audience,
    type: 'user' as const,
    id: m.user.id,
    tenantId,
    language: m.user.language,
    line: m.user.lineUserId,
    phone: m.user.phoneVerifiedAt ? m.user.phoneE164 : null,
    email: m.user.emailVerifiedAt ? m.user.email : null,
  }));
}

/** The lessee of a lease as a resident recipient (LINE of the party or of its linked login). */
async function lessee(tx: Tx, leaseId: string): Promise<Recipient[]> {
  const lease = await tx.lease.findUnique({ where: { id: leaseId }, include: { lessee: true } });
  if (!lease) return [];
  const link = await tx.partyUserLink.findFirst({
    where: { partyId: lease.lesseePartyId, state: 'active' },
    include: { user: true },
  });
  return [
    {
      audience: 'resident',
      type: 'party',
      id: lease.lessee.id,
      tenantId: lease.tenantId,
      language: lease.lessee.language,
      line: lease.lessee.lineUserId ?? link?.user.lineUserId ?? null,
      phone: lease.lessee.phoneE164,
      email: lease.lessee.email,
    },
  ];
}

export async function tenantName(tx: Tx, tenantId: string): Promise<string> {
  return (
    (await tx.tenant.findUnique({ where: { id: tenantId }, select: { displayName: true } }))?.displayName ??
    ''
  );
}

/** B3.4: "unit 305 · electric" / "common area CA-PUMP · water" for meter health messages (D-034). */
async function meterLabel(tx: Tx, payload: Record<string, unknown>): Promise<string> {
  const unit = payload.unitId
    ? await tx.unit.findUnique({ where: { id: payload.unitId as string }, select: { unitNo: true } })
    : null;
  return `${unit?.unitNo ?? (payload.code as string | undefined) ?? ''} · ${typeof payload.utility === 'string' ? payload.utility : ''}`.trim();
}

const meterHealth: NotifiableResolver = async (tx, e) =>
  e.tenantId
    ? {
        recipients: await operators(tx, e.tenantId, ['owner', 'manager', 'staff'], 'owner'),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          meter: { label: await meterLabel(tx, e.payload), lastSeenAt: e.payload.lastSeenAt ?? '-' },
        },
      }
    : null;

/** A billed party as a resident recipient (its LINE, or the LINE of its linked login). */
export async function billedParty(tx: Tx, partyId: string): Promise<Recipient[]> {
  const party = await tx.party.findUnique({ where: { id: partyId } });
  if (!party) return [];
  const link = await tx.partyUserLink.findFirst({
    where: { partyId, state: 'active' },
    include: { user: true },
  });
  return [
    {
      audience: 'resident',
      type: 'party',
      id: party.id,
      tenantId: party.tenantId,
      language: party.language,
      line: party.lineUserId ?? link?.user.lineUserId ?? null,
      phone: party.phoneE164,
      email: party.email,
    },
  ];
}

async function propertyName(tx: Tx, propertyId: unknown): Promise<string> {
  if (typeof propertyId !== 'string') return '';
  return (await tx.property.findUnique({ where: { id: propertyId }, select: { name: true } }))?.name ?? '';
}

/**
 * Modules add (or refine) resolvers when their module loads (B4.3 billing documents: invoice Flex messages). The
 * notifications subscriber reads the map at dispatch time.
 */
export function registerNotifiable(eventType: string, resolver: NotifiableResolver): void {
  NOTIFIABLE_EVENTS[eventType] = resolver;
}

export const NOTIFIABLE_EVENTS: Record<string, NotifiableResolver> = {
  /** B3.4 (D-034): meter health and gateway offline reach the operators of the building's tenant. */
  'meter.stale': meterHealth,
  'meter.silent': meterHealth,
  'device.offline': async (tx, e) =>
    e.tenantId
      ? {
          recipients: await operators(tx, e.tenantId, ['owner', 'manager', 'staff'], 'owner'),
          data: {
            tenant: { name: await tenantName(tx, e.tenantId) },
            device: { serial: e.payload.serial, since: e.payload.since ?? e.occurredAt },
          },
        }
      : null,
  'tenant.bank_account.changed': async (tx, e) => ({
    recipients: await operators(tx, e.tenantId!, ['owner'], 'owner'),
    data: {
      tenant: { name: await tenantName(tx, e.tenantId!) },
      account: { masked: e.payload.accountNoMasked },
    },
    urgent: true,
  }),
  'support_grant.requested': async (tx, e) => ({
    recipients: await operators(tx, e.tenantId!, ['owner'], 'owner'),
    data: { tenant: { name: await tenantName(tx, e.tenantId!) }, reason: e.payload.reason },
    urgent: true,
  }),
  'workflow.sla_reminder': async (tx, e) => ({
    recipients: await operators(tx, e.tenantId!, ['owner', 'manager'], 'owner'),
    data: { workflow: e.payload, tenant: { name: await tenantName(tx, e.tenantId!) } },
  }),
  'workflow.sla_breached': async (tx, e) => ({
    recipients: await operators(tx, e.tenantId!, ['owner', 'manager'], 'owner'),
    data: { workflow: e.payload, tenant: { name: await tenantName(tx, e.tenantId!) } },
  }),
  /** B2.4: the resident reviews the proposed deposit settlement in the LIFF (D-023). */
  'deposit.settlement_proposed': async (tx, e) => ({
    recipients: await lessee(tx, e.payload.leaseId as string),
    data: {
      tenant: { name: await tenantName(tx, e.tenantId!) },
      settlement: e.payload,
    },
    consentPurpose: 'resident.service',
  }),
  'deposit.refunded': async (tx, e) => ({
    recipients: await lessee(tx, e.payload.leaseId as string),
    data: {
      tenant: { name: await tenantName(tx, e.tenantId!) },
      settlement: e.payload,
    },
    consentPurpose: 'resident.service',
  }),
  /** B4.2: the billed party receives the issued invoice by LINE (D-011, D-022); 4.3 adds the Flex card and QR. */
  'invoice.issued': async (tx, e) => {
    const p = e.payload as { billedPartyId?: string; unitId?: string | null };
    if (!p.billedPartyId || !e.tenantId) return null;
    const unit = p.unitId
      ? await tx.unit.findUnique({ where: { id: p.unitId }, select: { unitNo: true } })
      : null;
    return {
      recipients: await billedParty(tx, p.billedPartyId),
      data: {
        tenant: { name: await tenantName(tx, e.tenantId) },
        invoice: e.payload,
        unit: { unitNo: unit?.unitNo ?? '' },
      },
      consentPurpose: 'resident.service',
    };
  },
  /** B4.2 (D-031): staff are asked for the readings the cut-off did not bring. */
  'billing_cycle.readings_requested': async (tx, e) =>
    e.tenantId
      ? {
          recipients: await operators(tx, e.tenantId, ['owner', 'manager', 'staff'], 'owner'),
          data: {
            tenant: { name: await tenantName(tx, e.tenantId) },
            property: { name: await propertyName(tx, e.payload.propertyId) },
            cycle: e.payload,
          },
        }
      : null,
  'billing_cycle.computed': async (tx, e) =>
    e.tenantId && e.payload.firstComputed === true
      ? {
          recipients: await operators(tx, e.tenantId, ['owner', 'manager'], 'owner'),
          data: {
            tenant: { name: await tenantName(tx, e.tenantId) },
            property: { name: await propertyName(tx, e.payload.propertyId) },
            cycle: e.payload,
          },
        }
      : null,
  'dsr.received': async (tx, e) =>
    e.tenantId
      ? {
          recipients: await operators(tx, e.tenantId, ['owner'], 'owner'),
          data: {
            dsr: { kind: e.payload.kind, dueAt: e.payload.dueAt },
            tenant: { name: await tenantName(tx, e.tenantId) },
          },
        }
      : null,
  /** Platform admin test send / integration tests: one recipient, explicit channels, the template's sample data. */
  'notification.test_requested': async (tx, e) => {
    const p = e.payload as {
      templateKey: string;
      channel: NotificationChannel;
      audience: NotificationAudience;
      recipientType: 'user' | 'party';
      recipientId: string;
      data?: Record<string, unknown>;
      urgent?: boolean;
    };
    const recipient: Recipient | null =
      p.recipientType === 'user'
        ? await tx.userAccount.findUnique({ where: { id: p.recipientId } }).then((u) =>
            u
              ? {
                  audience: p.audience,
                  type: 'user' as const,
                  id: u.id,
                  tenantId: e.tenantId,
                  language: u.language,
                  line: u.lineUserId,
                  phone: u.phoneE164,
                  email: u.email,
                }
              : null,
          )
        : await tx.party.findUnique({ where: { id: p.recipientId } }).then(async (party) => {
            if (!party) return null;
            const link = await tx.partyUserLink.findFirst({
              where: { partyId: party.id, state: 'active' },
              include: { user: true },
            });
            return {
              audience: p.audience,
              type: 'party' as const,
              id: party.id,
              tenantId: party.tenantId,
              language: party.language,
              line: party.lineUserId ?? link?.user.lineUserId ?? null,
              phone: party.phoneE164,
              email: party.email,
            };
          });
    if (!recipient) return null;
    return {
      recipients: [recipient],
      data: p.data ?? {},
      templateKey: p.templateKey,
      channels: [p.channel],
      urgent: p.urgent ?? false,
    };
  },
};
