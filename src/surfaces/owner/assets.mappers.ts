import { assertIfMatch, etagOf } from '@common/etag/etag';
import { FAKE } from '@common/openapi/examples';
import { type Board } from '@modules/ops-units/board.service';
import { type MeterRow } from '@modules/ops-units/meters-items.service';
import { type DefaultLeaseLine } from '@modules/ops-units/profiles-accounts.service';
import { type ImportPreview } from '@modules/ops-units/unit-import.service';
import { type UnitRow } from '@modules/ops-units/units.service';

import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { unitActions } from '../shared/next-actions';
import { LeaseStatusName } from '../shared/status.enums';
import {
  type ActiveStatusName,
  type AmenityCategoryName,
  type AmenityDto,
  type AssetStatusName,
  type BoardDto,
  BuildingAccessName,
  type BuildingDto,
  type BuildingTypeName,
  type FloorDto,
  type ImportActionName,
  type LeaseLineKindName,
  type MeterDto,
  type MeterPurposeName,
  type PropertyDto,
  type UnitDto,
  type UnitImportPreviewDto,
  type UnitProfileDto,
  type UnitStatusName,
  type UnitTypeName,
  type UtilityAccountDto,
  type UtilityName,
  type UtilityProviderName,
} from './assets.dto';
import {
  type AssetItem,
  type Building,
  type Floor,
  type Property,
  type TenantContext,
  type UnitProfile,
  type UtilityAccount,
} from './assets.types';
import { type AddressDto } from './tenancy.dto';

const address = (a: unknown): AddressDto | null => {
  const v = a as AddressDto | null;
  return v && Object.keys(v).length ? v : null;
};

/** If-Match against an aggregate's current version; returns the version to update. */
export function ifMatchVersion(ifMatch: string | undefined, row: { id: string; version: number }): number {
  assertIfMatch(ifMatch, etagOf(row.id, row.version));
  return row.version;
}

export const propertyDto = (p: Property): PropertyDto => ({
  id: p.id,
  code: p.code,
  name: p.name,
  address: address(p.address),
  provinceCode: p.provinceCode,
  status: p.status as ActiveStatusName,
  version: p.version,
  createdAt: iso(p.createdAt),
});

export const buildingDto = (ctx: TenantContext, b: Building, unitCount: number): BuildingDto => ({
  id: b.id,
  propertyId: b.propertyId,
  code: b.code,
  name: b.name,
  type: b.type as BuildingTypeName,
  floorsCount: b.floorsCount,
  ownerTenantId: b.ownerTenantId,
  operatorTenantId: b.operatorTenantId,
  access:
    b.operatorTenantId === ctx.tenantId
      ? BuildingAccessName.Operator
      : b.ownerTenantId === ctx.tenantId
        ? BuildingAccessName.Owner
        : BuildingAccessName.Grant,
  status: b.status as ActiveStatusName,
  unitCount,
  version: b.version,
});

export const floorDto = (f: Floor, unitCount: number): FloorDto => ({
  id: f.id,
  buildingId: f.buildingId,
  level: f.level,
  name: f.name,
  sortOrder: f.sortOrder,
  unitCount,
});

export const unitDto = (u: UnitRow): UnitDto => ({
  nextActions: unitActions(u.status),
  id: u.id,
  buildingId: u.buildingId,
  propertyId: u.propertyId,
  floorId: u.floorId,
  floorLevel: u.floor?.level ?? null,
  unitNo: u.unitNo,
  type: u.type as UnitTypeName,
  areaSqm: u.areaSqm ? u.areaSqm.toFixed(2) : null,
  baseRent: u.baseRent ? u.baseRent.toFixed(2) : null,
  status: u.status as UnitStatusName,
  statusReason: u.unitDetailUnit?.statusReason ?? null,
  statusChangedAt: iso(u.statusChangedAt ?? u.createdAt),
  unitProfileId: u.unitDetailUnit?.unitProfileId ?? null,
  unitProfileName: u.unitDetailUnit?.profile?.name ?? null,
  ownershipRatio: u.ownershipRatio ? u.ownershipRatio.toString() : null,
  currentLeaseId: u.unitDetailUnit?.currentLeaseId ?? null,
  notes: u.unitDetailUnit?.notes ?? null,
  currency: 'THB',
  version: u.version,
});

export const unitProfileDto = (p: UnitProfile): UnitProfileDto => ({
  id: p.id,
  buildingId: p.buildingId,
  name: p.name,
  areaSqm: p.areaSqm ? p.areaSqm.toFixed(2) : null,
  defaultRent: p.defaultRent.toFixed(2),
  defaultDepositMonths: p.defaultDepositMonths.toFixed(1),
  defaultAdvanceRentMonths: p.defaultAdvanceRentMonths.toFixed(1),
  defaultLeaseLines: ((p.defaultLeaseLines ?? []) as unknown as DefaultLeaseLine[]).map((l) => ({
    kind: l.kind as LeaseLineKindName,
    description: l.description,
    amount: Number(l.amount).toFixed(2),
  })),
  inspectionTemplateId: p.inspectionTemplateId,
  version: p.version,
});

export const utilityAccountDto = (a: UtilityAccount): UtilityAccountDto => ({
  id: a.id,
  buildingId: a.buildingId,
  utility: a.utility as UtilityName,
  provider: a.provider as UtilityProviderName,
  customerNo: a.customerNo,
  meterNo: a.meterNo,
  label: a.label,
});

export const meterDto = (m: MeterRow): MeterDto => ({
  id: m.id,
  assetItemId: m.assetItemId,
  unitId: m.unitId,
  unitNo: m.unit?.unitNo ?? null,
  purpose: m.purpose as MeterPurposeName,
  utility: m.utility as UtilityName,
  code: m.code,
  commonAreaLabel: m.commonAreaLabel,
  name: m.assetItem.name,
  serial: m.assetItem.serial,
  initialReading: m.initialReading.toFixed(3),
  multiplier: m.multiplier.toFixed(6),
  validFrom: iso(m.validFrom),
  validTo: isoOrNull(m.validTo),
});

export const amenityDto = (a: AssetItem): AmenityDto => ({
  id: a.id,
  unitId: a.unitId!,
  category: a.category as AmenityCategoryName,
  name: a.name,
  manufacturer: a.manufacturer,
  model: a.model,
  serial: a.serial,
  location: a.location,
  installDate: dateOnly(a.installDate),
  warrantyUntil: dateOnly(a.warrantyUntil),
  status: a.status as AssetStatusName,
});

export const boardDto = (b: Board): BoardDto => ({
  building: b.building,
  generatedAt: iso(b.generatedAt),
  summary: b.summary,
  floors: b.floors.map((f) => ({
    ...f,
    units: f.units.map((u) => ({
      ...u,
      type: u.type as UnitTypeName,
      status: u.status as UnitStatusName,
      leaseStatus: u.leaseStatus as LeaseStatusName | null,
      meters: u.meters.map((m) => ({ ...m, utility: m.utility as UtilityName })),
    })),
  })),
});

export const importPreviewDto = (p: ImportPreview): UnitImportPreviewDto => ({
  ...p,
  rows: p.rows.map((r) => ({ ...r, type: r.type as UnitTypeName, action: r.action as ImportActionName })),
});

// ------------------------------------------------------------------------------------------- examples

export const PROPERTY_EXAMPLE: PropertyDto = {
  id: FAKE.propertyId,
  code: 'MAIN',
  name: FAKE.propertyName,
  address: { line1: FAKE.addressLine, province: 'กรุงเทพมหานคร', postcode: FAKE.postcode, country: 'TH' },
  provinceCode: '10',
  status: 'active' as ActiveStatusName,
  version: 1,
  createdAt: FAKE.dateTime,
};

export const BUILDING_EXAMPLE: BuildingDto = {
  id: FAKE.buildingId,
  propertyId: FAKE.propertyId,
  code: 'A',
  name: 'อาคาร A',
  type: 'apartment' as BuildingTypeName,
  floorsCount: 2,
  ownerTenantId: FAKE.tenantId,
  operatorTenantId: FAKE.tenantId,
  access: BuildingAccessName.Operator,
  status: 'active' as ActiveStatusName,
  unitCount: 12,
  version: 1,
};

export const FLOOR_EXAMPLE: FloorDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  level: 2,
  name: 'ชั้น 2',
  sortOrder: 2,
  unitCount: 6,
};

export const UNIT_EXAMPLE: UnitDto = {
  nextActions: ['set-status'],
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  propertyId: FAKE.propertyId,
  floorId: FAKE.uuid,
  floorLevel: 2,
  unitNo: FAKE.unitCode,
  type: 'room' as UnitTypeName,
  areaSqm: '28.00',
  baseRent: '4500.00',
  status: 'vacant' as UnitStatusName,
  statusReason: null,
  statusChangedAt: FAKE.dateTime,
  unitProfileId: FAKE.uuid,
  unitProfileName: 'ห้องสตูดิโอ',
  ownershipRatio: null,
  currentLeaseId: null,
  notes: null,
  currency: 'THB',
  version: 1,
};

export const UNIT_PROFILE_EXAMPLE: UnitProfileDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  name: 'ห้องสตูดิโอ',
  areaSqm: '28.00',
  defaultRent: '4500.00',
  defaultDepositMonths: '1.0',
  defaultAdvanceRentMonths: '1.0',
  defaultLeaseLines: [
    { kind: 'internet' as LeaseLineKindName, description: 'อินเทอร์เน็ตไฟเบอร์', amount: '300.00' },
  ],
  inspectionTemplateId: null,
  version: 1,
};

export const UTILITY_ACCOUNT_EXAMPLE: UtilityAccountDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  utility: 'electric' as UtilityName,
  provider: 'mea' as UtilityProviderName,
  customerNo: '000012345678',
  meterNo: '00012345',
  label: 'มิเตอร์หลักอาคาร A',
};

export const METER_EXAMPLE: MeterDto = {
  id: FAKE.uuid,
  assetItemId: FAKE.meterId,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  purpose: 'unit' as MeterPurposeName,
  utility: 'electric' as UtilityName,
  code: 'A-201-E',
  commonAreaLabel: null,
  name: 'มิเตอร์ไฟฟ้า A-201',
  serial: null,
  initialReading: '0.000',
  multiplier: '1.000000',
  validFrom: FAKE.dateTime,
  validTo: null,
};

export const AMENITY_EXAMPLE: AmenityDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  category: 'appliance' as AmenityCategoryName,
  name: 'ตู้เย็น',
  manufacturer: 'ตัวอย่างยี่ห้อ',
  model: null,
  serial: null,
  location: 'ห้องนอน',
  installDate: FAKE.date,
  warrantyUntil: null,
  status: 'active' as AssetStatusName,
};

export const BOARD_EXAMPLE: BoardDto = {
  building: { id: FAKE.buildingId, code: 'A', name: 'อาคาร A' },
  generatedAt: FAKE.dateTime,
  summary: {
    total: 12,
    vacant: 3,
    reserved: 0,
    occupied: 8,
    maintenance: 1,
    inactive: 0,
    occupancyPct: '66.7',
  },
  floors: [
    {
      id: FAKE.uuid,
      level: 2,
      name: 'ชั้น 2',
      units: [
        {
          id: FAKE.uuid,
          unitNo: FAKE.unitCode,
          type: 'room' as UnitTypeName,
          status: 'occupied' as UnitStatusName,
          statusReason: null,
          profileName: 'ห้องสตูดิโอ',
          baseRent: '4500.00',
          lessee: { partyId: FAKE.uuid, displayName: FAKE.nameTh },
          leaseId: FAKE.uuid,
          leaseStatus: LeaseStatusName.Active,
          leaseEndDate: '2027-10-31',
          balance: null,
          meters: [{ utility: 'electric' as UtilityName, code: 'A-201-E', health: null }],
          meterHealth: null,
        },
      ],
    },
  ],
};

export const IMPORT_PREVIEW_EXAMPLE: UnitImportPreviewDto = {
  fileId: FAKE.uuid,
  buildingId: FAKE.buildingId,
  rows: [
    {
      row: 2,
      unitNo: FAKE.unitCode,
      floorLevel: 2,
      type: 'room' as UnitTypeName,
      areaSqm: '28.00',
      baseRent: '4500.00',
      unitProfile: 'ห้องสตูดิโอ',
      notes: null,
      action: 'create' as ImportActionName,
      createsFloor: false,
      errors: [],
    },
  ],
  summary: { create: 1, update: 0, unchanged: 0, error: 0, floorsToCreate: [] },
  previewToken: 'q8u2ZJ6a0y1mXo5t4Vb3wNfLkR7sGh9cD2eP0iUaQx8',
};
