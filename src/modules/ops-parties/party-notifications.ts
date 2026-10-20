import { operators, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { Injectable, type OnModuleInit } from '@nestjs/common';

/** D-226 (review #6): the Owner is told when an SMS-OTP login matched one of their parties and waits to be linked. */
@Injectable()
export class PartyNotifications implements OnModuleInit {
  onModuleInit(): void {
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
