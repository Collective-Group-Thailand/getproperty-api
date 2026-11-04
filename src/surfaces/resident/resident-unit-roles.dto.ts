import { FAKE } from '@common/openapi/examples';
import { ApiProperty } from '@nestjs/swagger';

// Leaf module (no other DTO imports): `shared/me.dto.ts` uses it, and the DTO modules import each other in cycles.

/** JR (D-309, D-322): how I relate to a unit. `co_owner` and `payer` are derived, not occupancy roles. */
export enum ResidentUnitRoleName {
  CoOwner = 'co_owner',
  Tenant = 'tenant',
  CoTenant = 'co_tenant',
  Family = 'family',
  Payer = 'payer',
}

/** Where a unit role comes from: the ownership register, an occupancy, or a lease in force (context only). */
export enum ResidentUnitRoleSourceName {
  Ownership = 'ownership',
  Occupancy = 'occupancy',
  Lease = 'lease',
}

/** What the resident app may show for a unit (navigation rules of the unit switcher, JRL). */
export enum ResidentUnitCapability {
  Notices = 'notices',
  Parcels = 'parcels',
  Facilities = 'facilities',
  Rules = 'rules',
  Contacts = 'contacts',
  ServiceRequests = 'service_requests',
  Invoices = 'invoices',
  Usage = 'usage',
  Access = 'access',
  Lease = 'lease',
}

/** One entry of `GET /v1/resident/me` `unitRoles` (the pack's `unitRoles[]`). */
export class ResidentUnitRoleRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  propertyId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({
    enum: ResidentUnitRoleName,
    enumName: 'ResidentUnitRole',
    example: ResidentUnitRoleName.Tenant,
  })
  role!: ResidentUnitRoleName;

  @ApiProperty({
    enum: ResidentUnitRoleSourceName,
    enumName: 'ResidentUnitRoleSource',
    example: ResidentUnitRoleSourceName.Occupancy,
  })
  source!: ResidentUnitRoleSourceName;

  @ApiProperty({ format: 'date', example: '2026-10-01' })
  from!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  to!: string | null;
}
