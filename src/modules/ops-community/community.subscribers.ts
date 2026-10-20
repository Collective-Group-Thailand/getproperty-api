import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import {
  billedParty,
  type Recipient,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { registerRealtimeChannels } from '@core/subscribers/subscribers';
import { type Tx } from '@database/prisma.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { residentsOfBuildings } from './announcements.service';
import { cleanAudience, inAudience } from './community-rules';
import { ParcelsService } from './parcels.service';
import { BuildingRulesService } from './rules-contacts.service';

async function partiesAsRecipients(tx: Tx, partyIds: string[]): Promise<Recipient[]> {
  const out: Recipient[] = [];
  for (const id of new Set(partyIds)) out.push(...(await billedParty(tx, id)));
  return out;
}

/**
 * B5.3 notifications and hooks (D-073): an announcement goes to the residents in its audience (LINE; quiet hours,
 * consent and the `announcements` topic apply), a parcel to the recipient or the unit's residents (then `notified`),
 * a new rule version to the building's residents (to acknowledge it); rules confirmed at lease signing (B2.3) are
 * recorded as acknowledgements of the version in force.
 */
@Injectable()
export class CommunitySubscribers implements EventSubscriber, OnModuleInit {
  readonly name = 'community';
  readonly eventTypes = ['parcel.received', 'lease.signed', 'lease.rules_acknowledged'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly parcels: ParcelsService,
    private readonly rules: BuildingRulesService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** LIFF #28 (D-218): the screen of the resident app a LINE message opens. */
  private link(path: string): string {
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}${path}`;
  }

  onModuleInit(): void {
    this.registry.register(this);
    registerNotifiable('announcement.published', async (tx, e) => {
      if (!e.tenantId) return null;
      const a = await tx.announcement.findUnique({ where: { id: e.payload.announcementId as string } });
      if (!a) return null;
      const filter = cleanAudience(a.audienceFilter);
      const residents = await residentsOfBuildings(
        tx,
        e.tenantId,
        a.buildingId ? [a.buildingId] : null,
        bangkokDate(this.clock.now()),
      );
      const parties = residents
        .filter((r) => inAudience(filter, { id: r.unitId, floorId: r.floorId }))
        .map((r) => r.partyId);
      return {
        recipients: await partiesAsRecipients(tx, parties),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          announcement: { title: a.title, excerpt: a.bodyTh.slice(0, 160) },
          link: this.link(`/announcements/${a.id}`),
        },
        consentPurpose: 'resident.service',
      };
    });
    registerNotifiable('parcel.received', async (tx, e) => {
      if (!e.tenantId) return null;
      const parcel = await tx.parcel.findUnique({
        where: { id: e.payload.parcelId as string },
        include: { unit: { select: { unitNo: true } } },
      });
      if (!parcel) return null;
      const today = bangkokDate(this.clock.now());
      const parties = parcel.recipientPartyId
        ? [parcel.recipientPartyId]
        : (
            await tx.occupancy.findMany({
              where: {
                unitId: parcel.unitId,
                validFrom: { lte: new Date(today) },
                OR: [{ validTo: null }, { validTo: { gt: new Date(today) } }],
              },
              select: { partyId: true },
            })
          ).map((o) => o.partyId);
      return {
        recipients: await partiesAsRecipients(tx, parties),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          parcel: { unitNo: parcel.unit.unitNo, carrier: parcel.carrier ?? '-' },
          link: this.link('/parcels'),
        },
        consentPurpose: 'resident.service',
      };
    });
    registerNotifiable('building_rule.published', async (tx, e) => {
      if (!e.tenantId) return null;
      const rule = await tx.buildingRule.findUnique({ where: { id: e.payload.ruleId as string } });
      if (!rule) return null;
      const residents = await residentsOfBuildings(
        tx,
        e.tenantId,
        [rule.buildingId],
        bangkokDate(this.clock.now()),
      );
      return {
        recipients: await partiesAsRecipients(
          tx,
          residents.map((r) => r.partyId),
        ),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          rule: {
            title: rule.title,
            version: rule.version,
            effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10),
          },
        },
        consentPurpose: 'resident.service',
      };
    });
    registerRealtimeChannels(
      ['parcel.received', 'parcel.picked_up', 'parcel.returned', 'facility_booking.changed'],
      (_tx, e) => Promise.resolve(typeof e.payload.unitId === 'string' ? [`unit:${e.payload.unitId}`] : []),
    );
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    switch (event.type) {
      case 'parcel.received':
        // the notification subscriber plans the LINE messages of the same event
        return this.parcels.markNotified(tx, event.payload.parcelId as string);
      case 'lease.signed':
      case 'lease.rules_acknowledged': {
        const lease = await tx.lease.findUnique({
          where: { id: event.payload.leaseId as string },
          select: { id: true, tenantId: true, buildingId: true },
        });
        if (!lease) return;
        const partyIds =
          event.type === 'lease.signed'
            ? typeof event.payload.partyId === 'string'
              ? [event.payload.partyId]
              : []
            : ((event.payload.partyIds as string[] | undefined) ?? []);
        if (!partyIds.length) return;
        await this.rules.acknowledgeIn(tx, {
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          partyIds,
          leaseId: lease.id,
          userId: event.actor.type === 'user' ? event.actor.id : null,
        });
        return;
      }
    }
  }
}
