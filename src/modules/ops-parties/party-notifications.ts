import { type DomainEventEnvelope } from '@core/events/domain-events';
import { operators, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { registerRealtimeChannels } from '@core/subscribers/subscribers';
import { Injectable, type OnModuleInit } from '@nestjs/common';

/**
 * LIFF #31 (D-228): a link change — confirmed or rejected link request, unlink — is also heard on the login's own
 * `user:` channel (the tenant channels already carry it). Ids and type only, like every realtime message.
 */
export function partyLinkUserChannels(event: Pick<DomainEventEnvelope, 'payload'>): string[] {
  const userId = event.payload.userId;
  return typeof userId === 'string' && userId.length === 36 ? [`user:${userId}`] : [];
}

/** D-226 (review #6): the Owner is told when an SMS-OTP login matched one of their parties and waits to be linked. */
@Injectable()
export class PartyNotifications implements OnModuleInit {
  onModuleInit(): void {
    registerRealtimeChannels(['party.link_changed'], (_tx, e) => Promise.resolve(partyLinkUserChannels(e)));
    registerNotifiable('party.link_requested', async (tx, e) => {
      if (!e.tenantId) return null;
      const party = await tx.party.findUnique({
        where: { id: e.payload.partyId as string },
        select: { displayName: true },
      });
      return {
        recipients: await operators(tx, e.tenantId, ['owner'], 'owner'),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          party: { name: party?.displayName ?? '' },
        },
      };
    });
  }
}
