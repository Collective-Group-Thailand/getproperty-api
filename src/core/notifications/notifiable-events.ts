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

async function tenantName(tx: Tx, tenantId: string): Promise<string> {
  return (
    (await tx.tenant.findUnique({ where: { id: tenantId }, select: { displayName: true } }))?.displayName ??
    ''
  );
}

export const NOTIFIABLE_EVENTS: Record<string, NotifiableResolver> = {
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
  'workflow.sla_breached': async (tx, e) => ({
    recipients: await operators(tx, e.tenantId!, ['owner', 'manager'], 'owner'),
    data: { workflow: e.payload, tenant: { name: await tenantName(tx, e.tenantId!) } },
  }),
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
