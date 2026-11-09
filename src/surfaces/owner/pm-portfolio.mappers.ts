import { FAKE } from '@common/openapi/examples';
import {
  type ChargeView,
  type ManagementContractView,
} from '@modules/ops-juristic/pm/management-contracts.service';
import { lastServiceDay } from '@modules/ops-juristic/pm/management-rules';
import {
  type AssignmentView,
  type PortfolioBuilding,
  type StaffBoard,
} from '@modules/ops-juristic/pm/pm-portfolio.service';

import { iso, isoOrNull } from '../shared/mappers';
import {
  ContractPartySide,
  type ManagementContractDto,
  ManagementContractStateName,
  type ManagementFeeChargeDto,
  ManagementFeePeriodName,
  type PmAssignmentRoleName,
  type PmPortfolioBuildingDto,
  type PmPortfolioDto,
  type PmStaffAssignmentDto,
  type StaffBoardDto,
} from './pm-portfolio.dto';

/** J3.3 (D-334) response mappers shared by the juristic and PM controllers. */

const day = (d: Date) => d.toISOString().slice(0, 10);
const dayOrNull = (d: Date | null) => (d ? day(d) : null);

function nextActions(v: ManagementContractView, perms: ReadonlySet<string>): string[] {
  const s = v.contract.state;
  if (v.side === 'juristic') {
    if (!perms.has('juristic.management_contract.manage')) return [];
    if (s === 'draft') return ['edit', 'offer', 'cancel'];
    if (s === 'offered') return ['cancel'];
    if (s === 'active') return ['terminate'];
    return [];
  }
  if (!perms.has('pm.contract.manage')) return [];
  if (s === 'offered') return ['accept', 'decline'];
  if (s === 'active') return ['terminate'];
  return [];
}

export function managementContractDto(
  v: ManagementContractView,
  perms: ReadonlySet<string> = new Set(),
): ManagementContractDto {
  const c = v.contract;
  const jur = v.side === 'juristic';
  return {
    id: c.id,
    juristicTenantId: c.tenantId,
    juristicName: v.juristicName,
    pmTenantId: c.pmTenantId,
    pmName: v.pmName,
    buildingId: c.buildingId,
    buildingName: v.buildingName,
    vendorId: jur ? c.vendorId : null,
    title: c.title,
    scope: c.scope,
    fee: c.fee.toFixed(2),
    vatAmount: c.vatAmount.toFixed(2),
    feePeriod: c.feePeriod as ManagementFeePeriodName,
    dueDay: c.dueDay,
    startsOn: day(c.startsOn),
    endsOn: day(c.endsOn),
    expenseAccountId: jur ? c.expenseAccountId : null,
    whtKey: jur ? c.whtKey : null,
    resolutionId: jur ? c.resolutionId : null,
    documentId: jur ? c.documentId : null,
    state: c.state as ManagementContractStateName,
    access: {
      active: v.access.active,
      validFrom: isoOrNull(v.access.validFrom),
      validTo: isoOrNull(v.access.validTo),
      revokedAt: isoOrNull(v.access.revokedAt),
    },
    feesRequested: v.feesRequested,
    offeredAt: isoOrNull(c.offeredAt),
    acceptedAt: isoOrNull(c.acceptedAt),
    declinedAt: isoOrNull(c.declinedAt),
    declineReason: c.declineReason,
    cancelledAt: isoOrNull(c.cancelledAt),
    cancelReason: c.cancelReason,
    terminatedOn: dayOrNull(c.terminatedOn),
    terminatedAt: isoOrNull(c.terminatedAt),
    terminatedBy: c.terminatedByTenantId
      ? c.terminatedByTenantId === c.tenantId
        ? ContractPartySide.Juristic
        : ContractPartySide.Pm
      : null,
    terminationReason: c.terminationReason,
    endedAt: isoOrNull(c.endedAt),
    note: c.note,
    nextActions: nextActions(v, perms),
    createdAt: iso(c.createdAt),
    version: c.version,
  };
}

export function chargeDto(c: ChargeView): ManagementFeeChargeDto {
  return { ...c, requestedAt: iso(c.requestedAt) };
}

export function assignmentDto(v: AssignmentView): PmStaffAssignmentDto {
  const a = v.assignment;
  return {
    id: a.id,
    contractId: a.contractId,
    buildingId: a.buildingId,
    buildingName: v.buildingName,
    userId: a.userId,
    displayName: v.displayName,
    role: a.role as PmAssignmentRoleName,
    shift: a.shift,
    startsOn: day(a.startsOn),
    endsOn: dayOrNull(a.endsOn),
    note: a.note,
    createdAt: iso(a.createdAt),
    version: a.version,
  };
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function portfolioBuildingDto(b: PortfolioBuilding, today: string): PmPortfolioBuildingDto {
  const c = b.contract;
  const last = lastServiceDay({ endsOn: day(c.endsOn), terminatedOn: dayOrNull(c.terminatedOn) });
  return {
    buildingId: c.buildingId,
    buildingName: b.buildingName,
    juristicTenantId: c.tenantId,
    juristicName: b.juristicName,
    legalForm: b.legalForm,
    contract: {
      id: c.id,
      fee: c.fee.toFixed(2),
      feePeriod: c.feePeriod as ManagementFeePeriodName,
      startsOn: day(c.startsOn),
      endsOn: day(c.endsOn),
      terminatedOn: dayOrNull(c.terminatedOn),
      daysLeft: daysBetween(today, last),
    },
    staffToday: b.staffToday.map((s) => ({ ...s, role: s.role as PmAssignmentRoleName })),
    kpis: b.kpis,
  };
}

export function portfolioDto(p: { asOf: string; buildings: PortfolioBuilding[] }): PmPortfolioDto {
  const rows = p.buildings.map((b) => portfolioBuildingDto(b, p.asOf));
  let billed = 0n;
  let collected = 0n;
  let overdue = 0n;
  const satang = (s: string) => BigInt(s.replace('.', ''));
  const fmt = (n: bigint) => {
    const neg = n < 0n;
    const a = (neg ? -n : n).toString().padStart(3, '0');
    return `${neg ? '-' : ''}${a.slice(0, -2)}.${a.slice(-2)}`;
  };
  for (const r of rows) {
    billed += satang(r.kpis.collection.billed);
    collected += satang(r.kpis.collection.collected);
    overdue += satang(r.kpis.arrears.overdueAmount);
  }
  const rate =
    billed > 0n ? (Math.round(Number((collected * 1_000_000n) / billed) / 100) / 100).toFixed(2) : null;
  return {
    asOf: p.asOf,
    buildings: rows,
    totals: {
      buildings: rows.length,
      units: rows.reduce((s, r) => s + r.kpis.units, 0),
      billed: fmt(billed),
      collected: fmt(collected),
      collectionRatePct: rate,
      overdueAmount: fmt(overdue),
      openRequests: rows.reduce((s, r) => s + r.kpis.work.openRequests, 0),
      slaBreachedRequests: rows.reduce((s, r) => s + r.kpis.work.slaBreachedRequests, 0),
      expiringContracts: rows.reduce((s, r) => s + r.kpis.expiring.vendorContracts, 0),
    },
  };
}

export function staffBoardDto(b: StaffBoard): StaffBoardDto {
  return {
    asOf: b.asOf,
    members: b.members.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      tenantRole: m.tenantRole,
      assignments: m.assignments.map(({ assignment: a, buildingName }) => ({
        assignmentId: a.id,
        buildingId: a.buildingId,
        buildingName,
        role: a.role as PmAssignmentRoleName,
        shift: a.shift,
        startsOn: day(a.startsOn),
        endsOn: dayOrNull(a.endsOn),
      })),
    })),
    buildings: b.buildings.map((x) => ({
      ...x,
      staff: x.staff.map((s) => ({ ...s, role: s.role as PmAssignmentRoleName })),
    })),
    unassigned: b.unassigned,
  };
}

// ------------------------------------------------------------------------------------------- examples

export const CONTRACT_EXAMPLE: ManagementContractDto = {
  id: FAKE.uuid,
  juristicTenantId: FAKE.tenantId,
  juristicName: 'นิติบุคคลอาคารชุด ตัวอย่าง',
  pmTenantId: FAKE.tenantId,
  pmName: 'บริษัท บริหารทรัพย์สิน ตัวอย่าง จำกัด',
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  vendorId: FAKE.uuid,
  title: 'สัญญาจ้างบริหารจัดการอาคาร 2570',
  scope: 'บริหารงานนิติบุคคล บัญชี จัดเก็บ ดูแลอาคาร',
  fee: '85600.00',
  vatAmount: '5600.00',
  feePeriod: ManagementFeePeriodName.Monthly,
  dueDay: 5,
  startsOn: '2027-01-01',
  endsOn: '2027-12-31',
  expenseAccountId: FAKE.uuid,
  whtKey: 'services',
  resolutionId: FAKE.uuid,
  documentId: null,
  state: ManagementContractStateName.Active,
  access: { active: true, validFrom: FAKE.dateTime, validTo: FAKE.dateTime, revokedAt: null },
  feesRequested: 1,
  offeredAt: FAKE.dateTime,
  acceptedAt: FAKE.dateTime,
  declinedAt: null,
  declineReason: null,
  cancelledAt: null,
  cancelReason: null,
  terminatedOn: null,
  terminatedAt: null,
  terminatedBy: null,
  terminationReason: null,
  endedAt: null,
  note: null,
  nextActions: ['terminate'],
  createdAt: FAKE.dateTime,
  version: 3,
};

export const CHARGE_EXAMPLE: ManagementFeeChargeDto = {
  id: FAKE.uuid,
  periodKey: '2027-01',
  periodStart: '2027-01-01',
  periodEnd: '2027-01-31',
  serviceDays: 31,
  periodDays: 31,
  amount: '85600.00',
  vatAmount: '5600.00',
  dueOn: '2027-02-05',
  requestedAt: FAKE.dateTime,
  expenseRequest: { id: FAKE.uuid, number: 'EXP-2027-000012', state: 'submitted' },
};

export const ASSIGNMENT_EXAMPLE: PmStaffAssignmentDto = {
  id: FAKE.uuid,
  contractId: FAKE.uuid,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  userId: FAKE.uuid,
  displayName: 'สมชาย ใจดี',
  role: 'building_manager' as PmAssignmentRoleName,
  shift: 'จ.–ศ. 08:00–17:00',
  startsOn: '2027-01-01',
  endsOn: null,
  note: null,
  createdAt: FAKE.dateTime,
  version: 1,
};

export const PORTFOLIO_BUILDING_EXAMPLE: PmPortfolioBuildingDto = {
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  juristicTenantId: FAKE.tenantId,
  juristicName: 'นิติบุคคลอาคารชุด ตัวอย่าง',
  legalForm: 'condo_act',
  contract: {
    id: FAKE.uuid,
    fee: '85600.00',
    feePeriod: ManagementFeePeriodName.Monthly,
    startsOn: '2027-01-01',
    endsOn: '2027-12-31',
    terminatedOn: null,
    daysLeft: 363,
  },
  staffToday: [
    {
      userId: FAKE.uuid,
      displayName: 'สมชาย ใจดี',
      role: 'building_manager' as PmAssignmentRoleName,
      shift: null,
    },
  ],
  kpis: {
    units: 312,
    collection: {
      from: '2026-01-02',
      to: '2027-01-02',
      billed: '3744000.00',
      collected: '3519360.00',
      collectionRatePct: '94.00',
      withinDaysRatePct: '88.50',
      kpiDays: 30,
      lastCycle: { periodKey: '2026-12', billed: '312000.00', collectionRatePct: '91.20' },
    },
    arrears: {
      overdueAmount: '224640.00',
      overdueInvoices: 41,
      overdueAccounts: 18,
      over90Amount: '96000.00',
    },
    budget: {
      budgetId: FAKE.uuid,
      fiscalYear: 2027,
      budgetedExpense: '3200000.00',
      actualExpense: '1180000.00',
      usedPct: '36.88',
    },
    work: { openRequests: 7, slaBreachedRequests: 2, openWorkOrders: 5 },
    expiring: {
      withinDays: 90,
      vendorContracts: 1,
      items: [
        {
          vendorContractId: FAKE.uuid,
          title: 'สัญญาบำรุงรักษาลิฟต์',
          vendorName: 'บริษัท ลิฟต์ไทย จำกัด',
          endsOn: '2027-03-31',
          daysLeft: 88,
        },
      ],
    },
  },
};

export const PORTFOLIO_EXAMPLE: PmPortfolioDto = {
  asOf: '2027-01-02',
  buildings: [PORTFOLIO_BUILDING_EXAMPLE],
  totals: {
    buildings: 1,
    units: 312,
    billed: '3744000.00',
    collected: '3519360.00',
    collectionRatePct: '94.00',
    overdueAmount: '224640.00',
    openRequests: 7,
    slaBreachedRequests: 2,
    expiringContracts: 1,
  },
};

export const STAFF_BOARD_EXAMPLE: StaffBoardDto = {
  asOf: '2027-01-02',
  members: [
    {
      userId: FAKE.uuid,
      displayName: 'สมชาย ใจดี',
      tenantRole: 'staff',
      assignments: [
        {
          assignmentId: FAKE.uuid,
          buildingId: FAKE.buildingId,
          buildingName: 'อาคาร A',
          role: 'building_manager' as PmAssignmentRoleName,
          shift: 'จ.–ศ. 08:00–17:00',
          startsOn: '2027-01-01',
          endsOn: null,
        },
      ],
    },
  ],
  buildings: [
    {
      buildingId: FAKE.buildingId,
      buildingName: 'อาคาร A',
      juristicName: 'นิติบุคคลอาคารชุด ตัวอย่าง',
      contractId: FAKE.uuid,
      staff: [
        {
          userId: FAKE.uuid,
          displayName: 'สมชาย ใจดี',
          role: 'building_manager' as PmAssignmentRoleName,
          shift: 'จ.–ศ. 08:00–17:00',
        },
      ],
    },
  ],
  unassigned: [{ userId: FAKE.uuid, displayName: 'สมหญิง ขยัน', tenantRole: 'accountant' }],
};
