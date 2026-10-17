import { FAKE } from '@common/openapi/examples';
import { addCalendarDays } from '@common/time/bangkok';
import { LESSEE_NOTICE_DAYS } from '@core/compliance/evaluators';
import { type LeaseEvent } from '@generated/prisma/client';
import { hasRuleClauses, RULES_ACK_STATES } from '@modules/ops-leases/lease-rules';
import { type LeaseRow, LeasesService, nextActions } from '@modules/ops-leases/leases.service';

import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { type LeaseLineKindName } from './assets.dto';
import {
  type AddendumClauseDto,
  type ComplianceOutcomeName,
  type ComplianceSeverityName,
  type LeaseDto,
  type LeaseEventDto,
  type LeasePartyRoleName,
  type LeasePartyViewDto,
  type LeaseStatusName,
  type LineRecurrenceName,
  type NoticePartyName,
  type RentIncreaseDto,
  type ResidentLeaseDto,
  type SignatureMethodName,
  type SignerRoleName,
  type UtilityBillingModeName,
} from './leases.dto';

const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function parties(l: LeaseRow): LeasePartyViewDto[] {
  return l.parties.map((p) => ({
    partyId: p.partyId,
    // null when the party belongs to another tenant (a grantee's lease seen by the building owner, D-152)
    displayName: (p.party as LeaseRow['parties'][number]['party'] | null)?.displayName ?? null,
    role: p.role as LeasePartyRoleName,
    isSigner: p.isSigner,
    signedAt: isoOrNull(
      l.signatures.find((s) => s.partyId === p.partyId && s.signerRole !== 'lessor')?.signedAt,
    ),
  }));
}

const lines = (l: LeaseRow) =>
  l.lines.map((x) => ({
    id: x.id,
    kind: x.kind as LeaseLineKindName,
    description: x.description,
    amount: x.amount.toFixed(2),
    recurrence: x.recurrence as LineRecurrenceName,
    effectiveFrom: dateOnly(x.effectiveFrom)!,
  }));

const notice = (l: LeaseRow) =>
  l.noticeGivenAt && l.noticeBy
    ? {
        by: l.noticeBy as NoticePartyName,
        givenAt: iso(l.noticeGivenAt),
        reasonCode: l.noticeReasonCode,
        effectiveDate: dateOnly(l.noticeEffectiveDate),
        evidenceDocumentIds: l.noticeEvidenceDocumentIds,
      }
    : null;

export function leaseDto(l: LeaseRow): LeaseDto {
  const snapshot = (l.complianceSnapshot ?? {}) as {
    inScope?: boolean;
    evaluatedAt?: string;
    checks?: { ruleId: string; outcome: string; severity: string; acknowledgementId?: string }[];
  };
  const documentId = l.signedDocumentId ?? l.contractDocumentId;
  return {
    id: l.id,
    number: l.number,
    status: l.status as LeaseStatusName,
    buildingId: l.buildingId,
    // null for a unit grantee: the building row is not visible to them (D-152)
    buildingName: (l.building as LeaseRow['building'] | null)?.name ?? null,
    unitId: l.unitId,
    unitNo: l.unit.unitNo,
    lesseePartyId: l.lesseePartyId,
    lesseeName: (l.lessee as LeaseRow['lessee'] | null)?.displayName ?? null,
    parties: parties(l),
    startDate: dateOnly(l.startDate)!,
    endDate: dateOnly(l.endDate)!,
    months: l.months,
    rent: l.rent.toFixed(2),
    depositAmount: l.depositAmount.toFixed(2),
    advanceRentAmount: l.advanceRentAmount.toFixed(2),
    currency: 'THB',
    billingDay: l.billingDay,
    utilityBillingMode: l.utilityBillingMode as UtilityBillingModeName,
    keysCount: l.keysCount,
    parkingSlots: l.parkingSlots,
    lines: lines(l),
    addendum: (l.addendum ?? []) as unknown as AddendumClauseDto[],
    rentIncreases: (l.rentIncreaseRecorded ?? []) as unknown as RentIncreaseDto[],
    terms: (l.terms ?? {}) as Record<string, unknown>,
    notice: notice(l),
    termination:
      l.terminatedAt && l.terminationReasonCode
        ? {
            terminatedAt: iso(l.terminatedAt),
            reasonCode: l.terminationReasonCode,
            notes: l.terminationNotes,
            evidenceDocumentIds: l.terminationEvidenceDocumentIds,
          }
        : null,
    signatures: l.signatures.map((s) => ({
      id: s.id,
      signerRole: s.signerRole as SignerRoleName,
      partyId: s.partyId,
      method: s.method as SignatureMethodName,
      lineLinked: Boolean(s.lineUserId),
      otpVerified: Boolean(s.otpChallengeId),
      pdfSha256: LeasesService.hex(s.pdfSha256)!,
      signedAt: iso(s.signedAt),
    })),
    contract: documentId
      ? { documentId, sha256: LeasesService.hex(l.contractSha256) ?? '', signed: Boolean(l.signedDocumentId) }
      : null,
    moveInAt: isoOrNull(l.moveInAt),
    moveOutAt: isoOrNull(l.moveOutAt),
    renewedFromLeaseId: l.renewedFromLeaseId,
    compliance: {
      inScope: snapshot.inScope ?? true,
      evaluatedAt: snapshot.evaluatedAt ? iso(new Date(snapshot.evaluatedAt)) : null,
      checks: (snapshot.checks ?? []).map((c) => ({
        ruleId: c.ruleId,
        outcome: c.outcome as ComplianceOutcomeName,
        severity: c.severity as ComplianceSeverityName,
        acknowledgementId: c.acknowledgementId ?? null,
      })),
    },
    nextActions: nextActions(l.status),
    createdAt: iso(l.createdAt),
    version: l.version,
  };
}

/**
 * `today` is the Bangkok date of the request: `noticeEarliestDate` = today + the lessee notice period of ข้อ 4 (11)
 * (`compliance.notice_period`) whenever `give-notice` is offered (LIFF #7).
 */
export function residentLeaseDto(
  l: LeaseRow & { tenant: { id: string; displayName: string } },
  myPartyIds: string[],
  today: string,
): ResidentLeaseDto {
  const signed = new Set(l.signatures.map((s) => s.partyId));
  const signatureRequired =
    l.status === 'pending_signature' &&
    l.parties.some((p) => p.isSigner && myPartyIds.includes(p.partyId) && !signed.has(p.partyId));
  const isLessee = l.parties.some((p) => p.role === 'lessee' && myPartyIds.includes(p.partyId));
  const contractAvailable = Boolean(l.signedDocumentId ?? l.contractDocumentId);
  const canGiveNotice = l.status === 'active' && isLessee;
  const mine = l.parties.filter((p) => myPartyIds.includes(p.partyId));
  const acknowledged = mine
    .map((p) => p.rulesAcknowledgedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const canAcknowledge =
    !acknowledged &&
    mine.length > 0 &&
    hasRuleClauses(l) &&
    (RULES_ACK_STATES as readonly string[]).includes(l.status);
  const actions = [
    ...(contractAvailable ? ['view-contract'] : []),
    ...(signatureRequired ? ['sign'] : []),
    ...(canGiveNotice ? ['give-notice'] : []),
    ...(canAcknowledge ? ['acknowledge-rules'] : []),
  ];
  return {
    id: l.id,
    number: l.number,
    status: l.status as LeaseStatusName,
    tenantId: l.tenant.id,
    tenantName: l.tenant.displayName,
    buildingName: l.building.name,
    unitNo: l.unit.unitNo,
    startDate: dateOnly(l.startDate)!,
    endDate: dateOnly(l.endDate)!,
    months: l.months,
    rent: l.rent.toFixed(2),
    depositAmount: l.depositAmount.toFixed(2),
    advanceRentAmount: l.advanceRentAmount.toFixed(2),
    currency: 'THB',
    utilityBillingMode: l.utilityBillingMode as UtilityBillingModeName,
    lines: lines(l),
    addendum: (l.addendum ?? []) as unknown as AddendumClauseDto[],
    parties: parties(l),
    notice: notice(l),
    signatureRequired,
    contractAvailable,
    noticeEarliestDate: canGiveNotice ? addCalendarDays(today, LESSEE_NOTICE_DAYS) : null,
    rulesAcknowledgedAt: isoOrNull(acknowledged),
    nextActions: actions,
  };
}

export const leaseEventDto = (e: LeaseEvent): LeaseEventDto => ({
  id: e.id,
  type: e.type,
  occurredAt: iso(e.occurredAt),
  actorType: ((e.actor ?? {}) as { type?: string }).type ?? 'system',
  data: (e.data ?? {}) as Record<string, unknown>,
});

const LESSEE_PARTY: LeasePartyViewDto = {
  partyId: FAKE.uuid,
  displayName: FAKE.nameTh,
  role: 'lessee' as LeasePartyRoleName,
  isSigner: true,
  signedAt: FAKE.dateTime,
};

const LINE_EXAMPLE = {
  id: FAKE.uuid,
  kind: 'internet' as LeaseLineKindName,
  description: 'อินเทอร์เน็ตไฟเบอร์',
  amount: '300.00',
  recurrence: 'monthly' as LineRecurrenceName,
  effectiveFrom: FAKE.date,
};

export const LEASE_EXAMPLE: LeaseDto = {
  id: FAKE.uuid,
  number: 'CTR-2026-00001',
  status: 'active' as LeaseStatusName,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  lesseePartyId: FAKE.uuid,
  lesseeName: FAKE.nameTh,
  parties: [LESSEE_PARTY],
  startDate: FAKE.date,
  endDate: '2027-10-31',
  months: 12,
  rent: '4500.00',
  depositAmount: '4500.00',
  advanceRentAmount: '4500.00',
  currency: 'THB',
  billingDay: 5,
  utilityBillingMode: 'metered' as UtilityBillingModeName,
  keysCount: 2,
  parkingSlots: 0,
  lines: [LINE_EXAMPLE],
  addendum: [{ type: 'pets', title: 'สัตว์เลี้ยง', text: 'อนุญาตแมวได้ 1 ตัว ผู้เช่ารับผิดชอบความสะอาด' }],
  rentIncreases: [],
  terms: {},
  notice: null,
  termination: null,
  signatures: [
    {
      id: FAKE.uuid,
      signerRole: 'lessee' as SignerRoleName,
      partyId: FAKE.uuid,
      method: 'draw_liff' as SignatureMethodName,
      lineLinked: true,
      otpVerified: true,
      pdfSha256: SHA,
      signedAt: FAKE.dateTime,
    },
  ],
  contract: { documentId: FAKE.uuid, sha256: SHA, signed: true },
  moveInAt: FAKE.dateTime,
  moveOutAt: null,
  renewedFromLeaseId: null,
  compliance: {
    inScope: true,
    evaluatedAt: FAKE.dateTime,
    checks: [
      {
        ruleId: 'compliance.deposit_cap',
        outcome: 'pass' as ComplianceOutcomeName,
        severity: 'block' as ComplianceSeverityName,
        acknowledgementId: null,
      },
    ],
  },
  nextActions: ['record-notice', 'begin-move-out', 'terminate', 'renew'],
  createdAt: FAKE.dateTime,
  version: 3,
};

export const RESIDENT_LEASE_EXAMPLE: ResidentLeaseDto = {
  id: FAKE.uuid,
  number: 'CTR-2026-00001',
  status: 'pending_signature' as LeaseStatusName,
  tenantId: FAKE.tenantId,
  tenantName: FAKE.propertyName,
  buildingName: 'อาคาร A',
  unitNo: FAKE.unitCode,
  startDate: FAKE.date,
  endDate: '2027-10-31',
  months: 12,
  rent: '4500.00',
  depositAmount: '4500.00',
  advanceRentAmount: '4500.00',
  currency: 'THB',
  utilityBillingMode: 'metered' as UtilityBillingModeName,
  lines: [LINE_EXAMPLE],
  addendum: [],
  parties: [{ ...LESSEE_PARTY, signedAt: null }],
  notice: null,
  signatureRequired: true,
  contractAvailable: true,
  noticeEarliestDate: null,
  rulesAcknowledgedAt: null,
  nextActions: ['view-contract', 'sign', 'acknowledge-rules'],
};

export const CONTRACT_SHA_EXAMPLE = SHA;
