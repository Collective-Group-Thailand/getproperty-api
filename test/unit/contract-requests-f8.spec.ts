import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESIDENT_REALTIME_EVENTS } from '@core/subscribers/subscribers';
import { partyLinkUserChannels } from '@modules/ops-parties/party-notifications';
import { heldSummary } from '@modules/ops-payments/resident-payments.service';

interface Schema {
  properties?: Record<
    string,
    { type?: string; nullable?: boolean; $ref?: string; allOf?: { $ref: string }[] }
  >;
  required?: string[];
}

const contract = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'contract', 'openapi.json'), 'utf8'),
) as { components: { schemas: Record<string, Schema> } };
const schema = (name: string): Schema => contract.components.schemas[name] ?? {};

/** LIFF #29–#31 (D-228, triage F8). */
describe('contract requests F8 (LIFF #29–#31)', () => {
  it('#29: TechnicianMeDto.linkRequestsPending is a required integer like the resident field', () => {
    const tech = schema('TechnicianMeDto');
    expect(tech.properties?.linkRequestsPending?.type).toBe('integer');
    expect(tech.required).toContain('linkRequestsPending');
    expect(schema('ResidentMeDto').properties?.linkRequestsPending?.type).toBe('integer');
  });

  it('#30: ResidentPaymentDto.checking is a nullable count + since, nothing of the duplicate', () => {
    const pay = schema('ResidentPaymentDto');
    expect(pay.required).toContain('checking');
    const checking = schema('ResidentPaymentCheckingDto');
    expect(Object.keys(checking.properties ?? {}).sort()).toEqual(['count', 'since']);
    expect(checking.properties?.count?.type).toBe('integer');
  });

  it('#30: the summary is null for no held payment and carries the oldest time otherwise', () => {
    expect(heldSummary(0, null)).toBeNull();
    expect(heldSummary(0, new Date('2026-10-21T03:00:00Z'))).toBeNull();
    const since = new Date('2026-10-21T03:00:00Z');
    expect(heldSummary(2, since)).toEqual({ count: 2, since });
  });

  it('#30: held / dismissed payments reach the resident’s own realtime channels', () => {
    expect(RESIDENT_REALTIME_EVENTS).toEqual(expect.arrayContaining(['payment.held', 'payment.dismissed']));
  });

  it('#31: a link change goes to the login’s user: channel only, ids only', () => {
    const userId = '3b241101-e2bb-4255-8caf-4136c566a962';
    expect(partyLinkUserChannels({ payload: { userId, change: 'rejected' } })).toEqual([`user:${userId}`]);
    expect(partyLinkUserChannels({ payload: { userId: 'not-a-uuid' } })).toEqual([]);
    expect(partyLinkUserChannels({ payload: {} })).toEqual([]);
  });
});
