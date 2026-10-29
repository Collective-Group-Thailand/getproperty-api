import { FakeListingWriter } from '@integrations/listing-writer/fake-listing-writer';
import { responseSchema, taskOf } from '@integrations/listing-writer/http-listing-writer.adapter';
import { type ListingFacts } from '@integrations/listing-writer/listing-writer.port';
import { parseGetenergyEvent } from '@modules/bridge-integrations/getenergy-contract';

import { checkDrafts } from './listing-assistant-rules';

const FACTS: ListingFacts = {
  unitKind: 'condo_unit',
  sizeSqm: '28.50',
  bedrooms: 1,
  bathrooms: 1,
  floorLabel: '12',
  furnishing: 'fully_furnished',
  rent: '12000.00',
  depositMonths: 2,
  advanceMonths: 1,
  minTermMonths: 12,
  petsAllowed: false,
  smokingAllowed: false,
  facilities: ['pool', 'gym'],
  province: 'กรุงเทพมหานคร',
  district: 'พญาไท',
  transit: { name: 'BTS อารีย์', line: 'Sukhumvit', distanceM: 350 },
  currentTitleTh: 'คอนโดใกล้ BTS',
  currentDescriptionTh: '',
};

describe('listing assistant (G9, D-301)', () => {
  it('the fake drafts every requested language from the facts and records the request', async () => {
    const fake = new FakeListingWriter();
    const r = await fake.draft({ facts: FACTS, languages: ['th', 'en', 'zh'], photos: [], tenantId: 't' });
    expect(Object.keys(r.drafts)).toEqual(['th', 'en', 'zh']);
    expect(r.drafts.th!.description).toContain('12,000 บาท/เดือน');
    expect(r.drafts.en!.title).toContain('28.5 sqm');
    expect(r.drafts.zh!.description).toContain('泰铢');
    expect(fake.requests).toHaveLength(1);
    expect(checkDrafts(r.drafts, ['th', 'en', 'zh'])).not.toBeNull();
  });

  it('refuses drafts that miss a language, run too long or carry contact data', () => {
    const ok = { title: 'Condo', description: 'Nice condo near BTS.' };
    expect(checkDrafts({ th: ok }, ['th', 'en'])).toBeNull();
    expect(checkDrafts({ th: { ...ok, title: 'x'.repeat(121) } }, ['th'])).toBeNull();
    expect(checkDrafts({ th: { ...ok, description: 'call 081-234-5678' } }, ['th'])).toBeNull();
    expect(checkDrafts({ th: { title: ' Condo ', description: ' Nice ' } }, ['th'])).toEqual({
      th: { title: 'Condo', description: 'Nice' },
    });
  });

  it('the gateway request carries only the listing facts and asks for text per language', () => {
    const task = taskOf({ facts: FACTS, languages: ['th', 'zh'], photos: [], tenantId: 't' });
    expect(task).toContain('th (Thai), zh (Simplified Chinese)');
    expect(task).toContain('Do not include phone numbers');
    expect(responseSchema(['th', 'zh'])).toMatchObject({ required: ['th', 'zh'] });
  });
});

describe('getenergy provisional contract (G9, O-028)', () => {
  const envelope = (payload: Record<string, unknown>, type = 'energy.insight.shared') => ({
    eventId: '0199f2a0-0000-7000-8000-0000000000e1',
    type,
    version: 1,
    occurredAt: '2026-10-29T03:00:00.000Z',
    idempotencyKey: 'getproperty:energy_insight:x:shared',
    sourcePlatform: 'getproperty',
    tenantId: '0199f2a0-0000-7000-8000-000000000001',
    payload,
  });
  const shared = {
    leadId: '0199f2a0-0000-7000-8000-0000000000e2',
    building: {
      ref: '0199f2a0-0000-7000-8000-000000000004',
      province: 'กรุงเทพมหานคร',
      district: 'พญาไท',
      tenantType: 'apartment',
      unitCountBand: '11-30',
    },
    window: { from: '2026-09-29', to: '2026-10-28', dataDays: 30 },
    score: 82,
    scoreModel: 'v1',
    metrics: {
      basis: 'sum',
      totalKwh: '18250.500',
      commonAreaKwh: '4380.120',
      commonAreaShare: '0.2400',
      peakKw: '48.200',
      loadFactor: '0.5259',
      pumpHoursPerDay: null,
    },
    consent: { purposeKey: 'energy.insight', version: 1, grantedAt: '2026-10-29T02:00:00.000Z' },
  };

  it('accepts an aggregate snapshot and a withdrawal', () => {
    expect(parseGetenergyEvent(envelope(shared)).success).toBe(true);
    expect(
      parseGetenergyEvent(
        envelope(
          {
            leadId: shared.leadId,
            building: { ref: shared.building.ref },
            withdrawnAt: '2026-10-30T02:00:00.000Z',
            reason: 'owner_opted_out',
          },
          'energy.insight.withdrawn',
        ),
      ).success,
    ).toBe(true);
  });

  it('refuses personal data, unknown keys, floats and other event types', () => {
    const withContact = { ...shared, contact: { phone: '0812345678' } };
    expect(parseGetenergyEvent(envelope(withContact))).toMatchObject({ success: false });
    const withName = { ...shared, building: { ...shared.building, ownerName: 'Somchai' } };
    expect(parseGetenergyEvent(envelope(withName))).toMatchObject({ success: false });
    const withUnit = { ...shared, metrics: { ...shared.metrics, units: [{ unitNo: 'A-101', kwh: '10' }] } };
    expect(parseGetenergyEvent(envelope(withUnit))).toMatchObject({ success: false });
    const float = { ...shared, metrics: { ...shared.metrics, totalKwh: 18250.5 } };
    expect(parseGetenergyEvent(envelope(float))).toMatchObject({ success: false });
    expect(parseGetenergyEvent(envelope(shared, 'energy.lead.created'))).toMatchObject({ success: false });
  });
});
