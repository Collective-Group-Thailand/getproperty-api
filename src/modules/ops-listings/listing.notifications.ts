import { AppConfig } from '@config/app-config';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import {
  billedParty,
  type NotificationPlanInput,
  operators,
  type Recipient,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { type Tx } from '@database/prisma.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { PROSPECT_CONSENT_PURPOSE } from './listing-leads.service';

const BANGKOK = 'Asia/Bangkok';
const FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: BANGKOK,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** "ส. 1 พ.ย. 2569 10:00" / "Sat, 1 Nov 2026, 10:00" in Bangkok time, for LINE texts. */
export function viewingTime(iso: unknown): { th: string; en: string } {
  if (typeof iso !== 'string') return { th: '-', en: '-' };
  const at = new Date(iso);
  return {
    th: new Intl.DateTimeFormat('th-TH-u-ca-buddhist', FORMAT).format(at),
    en: new Intl.DateTimeFormat('en-GB', FORMAT).format(at),
  };
}

/** The prospect (party copy in the owner's tenant) as a `prospect` recipient. */
async function prospect(tx: Tx, partyId: unknown): Promise<Recipient[]> {
  if (typeof partyId !== 'string') return [];
  return (await billedParty(tx, partyId)).map((r) => ({ ...r, audience: 'prospect' as const }));
}

async function listingData(tx: Tx, listingId: unknown) {
  if (typeof listingId !== 'string') return null;
  const listing = await tx.listing.findUnique({
    where: { id: listingId },
    select: {
      id: true,
      slug: true,
      titleTh: true,
      titleEn: true,
      unitId: true,
      unit: { select: { unitNo: true } },
    },
  });
  if (!listing) return null;
  return {
    id: listing.id,
    slug: listing.slug,
    title: listing.titleTh,
    titleEn: listing.titleEn ?? listing.titleTh,
    unitNo: listing.unit.unitNo,
  };
}

async function partyName(tx: Tx, partyId: unknown): Promise<string> {
  if (typeof partyId !== 'string') return '';
  return (
    (await tx.party.findUnique({ where: { id: partyId }, select: { displayName: true } }))?.displayName ?? ''
  );
}

const VERIFICATION_LABEL: Record<string, { th: string; en: string }> = {
  approved: {
    th: 'ยืนยันแล้ว — ประกาศของห้องนี้จะแสดงป้าย "เจ้าของตัวจริง"',
    en: 'approved — listings of this unit show the verified-owner badge',
  },
  rejected: {
    th: 'ไม่ผ่าน — ดูเหตุผลและส่งเอกสารใหม่ได้ในหน้าประกาศ',
    en: 'not approved — see the reason and send new documents on the listing page',
  },
};

/**
 * Notifications of listings and enquiries (B7.2 / B7.3, D-252). The owner hears about moderation decisions
 * (rejected, hidden, verification decided), new enquiries and messages, viewing requests and cancellations, an
 * enquiry left unanswered and an upcoming viewing (in-app + LINE). The prospect hears the owner's replies and the
 * owner's viewing decisions and reminders in LINE — consent `prospect.enquiry` and quiet hours apply — each message
 * carrying the app screen it opens (`PUBLIC_RESIDENT_APP_URL/rentals/enquiries/{leadId}`).
 */
@Injectable()
export class ListingNotifications implements OnModuleInit {
  constructor(private readonly config: AppConfig) {}

  private link(leadId: unknown): string {
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/rentals/enquiries/${String(leadId)}`;
  }

  private async base(tx: Tx, e: DomainEventEnvelope) {
    if (!e.tenantId) return null;
    const listing = await listingData(tx, e.payload.listingId);
    if (!listing) return null;
    return { tenant: { name: await tenantName(tx, e.tenantId) }, listing };
  }

  /** Owner-side message about a lead (in-app + LINE for the tenant's owners). */
  private toOwner(extra: (e: DomainEventEnvelope) => Record<string, unknown> = () => ({})) {
    return async (tx: Tx, e: DomainEventEnvelope): Promise<NotificationPlanInput | null> => {
      const base = await this.base(tx, e);
      if (!base) return null;
      return {
        recipients: await operators(tx, e.tenantId!, ['owner'], 'owner'),
        data: {
          ...base,
          lead: { id: e.payload.leadId, name: await partyName(tx, e.payload.partyId) },
          ...extra(e),
        },
      };
    };
  }

  /** Prospect-side LINE message about their enquiry. */
  private toProspect(extra: (e: DomainEventEnvelope) => Record<string, unknown> = () => ({})) {
    return async (tx: Tx, e: DomainEventEnvelope): Promise<NotificationPlanInput | null> => {
      const base = await this.base(tx, e);
      if (!base) return null;
      return {
        recipients: await prospect(tx, e.payload.partyId),
        data: { ...base, link: this.link(e.payload.leadId), ...extra(e) },
        consentPurpose: PROSPECT_CONSENT_PURPOSE,
      };
    };
  }

  onModuleInit(): void {
    const excerpt = (e: DomainEventEnvelope) => ({
      message: { excerpt: (e.payload.excerpt as string | null) ?? '' },
    });
    const viewing = (e: DomainEventEnvelope) => {
      const at = viewingTime(e.payload.startsAt);
      return { viewing: { at: at.th, atEn: at.en, reason: (e.payload.reason as string | null) ?? '' } };
    };

    // --- owner: moderation decisions (B7.2)
    const moderation = async (tx: Tx, e: DomainEventEnvelope): Promise<NotificationPlanInput | null> => {
      const base = await this.base(tx, e);
      if (!base) return null;
      return {
        recipients: await operators(tx, e.tenantId!, ['owner'], 'owner'),
        data: { ...base, reason: e.payload.reason ?? '' },
      };
    };
    registerNotifiable('listing.rejected', moderation);
    registerNotifiable('listing.hidden', moderation);
    registerNotifiable('listing.verification_decided', async (tx, e) => {
      if (!e.tenantId || typeof e.payload.unitId !== 'string') return null;
      const unit = await tx.unit.findUnique({
        where: { id: e.payload.unitId },
        select: { unitNo: true, building: { select: { name: true } } },
      });
      const label = VERIFICATION_LABEL[e.payload.state as string] ?? VERIFICATION_LABEL.rejected!;
      return {
        recipients: await operators(tx, e.tenantId, ['owner'], 'owner'),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          unit: { name: unit ? `${unit.building.name} ${unit.unitNo}`.trim() : '' },
          verification: { result: label.th, resultEn: label.en },
        },
      };
    });

    // --- owner: enquiries and viewings (B7.3)
    registerNotifiable('listing.lead_received', this.toOwner(excerpt));
    registerNotifiable('listing.lead_message', this.toOwner(excerpt));
    registerNotifiable(
      'listing.lead_unanswered',
      this.toOwner((e) => ({ hours: e.payload.hours })),
    );
    registerNotifiable(
      'listing.viewing_requested',
      this.toOwner((e) => ({
        ...viewing(e),
        rescheduled: Boolean(e.payload.rescheduledFrom),
      })),
    );

    // --- prospect: the owner's answers (B7.3)
    registerNotifiable(
      'listing.lead_replied',
      this.toProspect((e) => ({ message: { excerpt: (e.payload.excerpt as string | null) ?? '' } })),
    );
    registerNotifiable('listing.viewing_confirmed', this.toProspect(viewing));
    registerNotifiable('listing.viewing_declined', this.toProspect(viewing));

    // --- both sides
    const toOwner = this.toOwner(viewing);
    const toProspect = this.toProspect(viewing);
    registerNotifiable('listing.viewing_cancelled', (tx, e) =>
      e.payload.by === 'prospect' ? toOwner(tx, e) : toProspect(tx, e),
    );
    registerNotifiable('listing.viewing_reminder', async (tx, e) => {
      const owner = await toOwner(tx, e);
      const guest = await toProspect(tx, e);
      if (!owner || !guest) return owner ?? guest;
      return {
        recipients: [...owner.recipients, ...guest.recipients],
        data: { ...owner.data, ...guest.data },
        consentPurpose: PROSPECT_CONSENT_PURPOSE,
      };
    });
  }
}
