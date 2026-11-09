import { type UnitRole } from '@core/identity/resident-units';
import { type VisitRow } from '@modules/smart-gate/visits.service';

import { ResidentUnitCapability } from '../resident/resident-unit-roles.dto';
import { firstNameOf, guardVisitDto } from './gate.mappers';
import { unitCapabilities } from './me.service';

const role = (r: Partial<UnitRole>): UnitRole => ({
  unitId: 'u1',
  buildingId: 'b1',
  tenantId: 't1',
  partyId: 'p1',
  role: 'co_owner',
  source: 'ownership',
  sourceId: 's1',
  from: '2020-01-01',
  to: null,
  ...r,
});

describe('J-CR (D-335) resident unit capabilities', () => {
  it('adds `gate` only where the estate has an active gate and I hold a gate role', () => {
    expect(unitCapabilities([role({})], { gate: true })).toContain(ResidentUnitCapability.Gate);
    expect(unitCapabilities([role({})], { gate: false })).not.toContain(ResidentUnitCapability.Gate);
    expect(unitCapabilities([role({})])).not.toContain(ResidentUnitCapability.Gate);
    expect(unitCapabilities([role({ role: 'family', source: 'occupancy' })], { gate: true })).toContain(
      ResidentUnitCapability.Gate,
    );
    // a payer (bill-to) only pays: no gate
    expect(unitCapabilities([role({ role: 'payer', source: 'bill_to' })], { gate: true })).toEqual([
      ResidentUnitCapability.Invoices,
    ]);
    expect(unitCapabilities([role({ role: 'payer', source: 'ownership' })], { gate: true })).not.toContain(
      ResidentUnitCapability.Gate,
    );
  });
});

describe('J-CR (D-335) the gate view of a visit', () => {
  const visit = {
    id: 'v1',
    gateId: 'g1',
    gate: { name: 'ป้อมหน้า' },
    unitId: 'u1',
    unit: { unitNo: 'A-101' },
    kind: 'guest',
    state: 'approved',
    entryBasis: null,
    plateCategory: null,
    plateNumber: null,
    plateProvince: null,
    visitorName: null,
    photoDocumentId: null,
    respondBy: null,
    timeoutAction: null,
    decidedAt: new Date('2027-01-10T02:00:00Z'),
    decidedByUserId: 'user-p',
    decisionReason: null,
    callMeAt: new Date('2027-01-10T01:59:00Z'),
    callMeUserId: 'user-q',
    enteredAt: null,
    exitedAt: null,
    exitedBy: null,
    cancelledAt: null,
    createdAt: new Date('2027-01-10T01:58:00Z'),
    clientRef: 'c1',
    idLast4: null,
    note: null,
    recordedAt: null,
    overstayNotifiedAt: new Date('2027-01-11T02:00:00Z'),
  } as unknown as VisitRow;

  it('first names only, from the names map; null without it', () => {
    expect(firstNameOf('สมชาย เจ้าของ')).toBe('สมชาย');
    expect(firstNameOf('  เกริก  ')).toBe('เกริก');
    expect(firstNameOf('')).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    const names = new Map([
      ['user-p', 'สมชาย เจ้าของ'],
      ['user-q', 'สมหญิง ร่วม'],
    ]);
    expect(guardVisitDto(visit, names)).toMatchObject({
      decidedByName: 'สมชาย',
      callBackName: 'สมหญิง',
      overstayedAt: '2027-01-11T09:00:00+07:00',
    });
    expect(guardVisitDto(visit)).toMatchObject({ decidedByName: null, callBackName: null });
  });
});
