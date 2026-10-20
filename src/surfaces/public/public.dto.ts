import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { UtilityName, UtilityProviderName } from '../owner/assets.dto';
import { TenantTypeName } from '../shared/me.dto';

export enum PricePlanKind {
  Plan = 'plan',
  Addon = 'addon',
}

export enum PriceUnit {
  UnitMonth = 'unit_month',
  BuildingMonth = 'building_month',
  BuildingYear = 'building_year',
  Month = 'month',
  Report = 'report',
  MeterPointMonth = 'meter_point_month',
}

/**
 * Modules a plan includes (D-150 module map, D-156 plans): group A operations (A1 lease & occupant, A2 billing &
 * accounting, A3 smart meter & utility billing, A4 service & maintenance), B condo juristic (B1 AGM & e-voting, B2
 * AI juristic assistant, B3 assets & funds), C smart building (C1 access, C2 energy, C3 PM portfolio), D bridges
 * (D1 post-sale portal, D2 landlord), plus the resident LINE Mini App and PromptPay collection. A named enum so a
 * new module fails the consumers' build instead of being hidden (web contract request, D-203).
 */
export enum PlanModuleKey {
  A1 = 'A1',
  A2 = 'A2',
  A3 = 'A3',
  A4 = 'A4',
  B1 = 'B1',
  B2 = 'B2',
  B3 = 'B3',
  C1 = 'C1',
  C2 = 'C2',
  C3 = 'C3',
  D1 = 'D1',
  D2 = 'D2',
  ResidentLiff = 'resident_liff',
  Promptpay = 'promptpay',
}

export enum PricePlanStatus {
  Proposed = 'proposed',
  Confirmed = 'confirmed',
}

export class PublicPlanDto {
  @ApiProperty({ example: 'apartment_starter', description: 'Stable plan key (D-156).' })
  key!: string;

  @ApiProperty({ enum: PricePlanKind, enumName: 'PricePlanKind', example: PricePlanKind.Plan })
  kind!: PricePlanKind;

  @ApiProperty({
    enum: TenantTypeName,
    enumName: 'TenantType',
    nullable: true,
    example: TenantTypeName.Apartment,
    description: 'The tenant type the plan is for; null for add-ons that fit every type.',
  })
  tenantType!: TenantTypeName | null;

  @ApiProperty({ example: 'Apartment Starter' })
  name!: string;

  @ApiProperty({ example: 'ออกบิล เก็บเงิน และแจ้งผู้เช่าผ่าน LINE สำหรับหอพักที่จดมิเตอร์เอง' })
  summary!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '25.00',
    description: 'Single price per `priceUnit` (THB, VAT excluded); null when the plan is quoted as a range.',
  })
  pricePerUnit!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Lower bound of a quoted range.' })
  priceFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Upper bound of a quoted range.' })
  priceTo!: string | null;

  @ApiProperty({ enum: PriceUnit, enumName: 'PriceUnit', example: PriceUnit.UnitMonth })
  priceUnit!: PriceUnit;

  @ApiProperty({ type: 'integer', nullable: true, example: 20 })
  minimumUnits!: number | null;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ example: false, description: 'Prices exclude VAT (D-156).' })
  vatIncluded!: boolean;

  @ApiProperty({
    enum: PricePlanStatus,
    enumName: 'PricePlanStatus',
    example: PricePlanStatus.Proposed,
    description: '`proposed` until the pilot confirms the prices (D-156): show them as indicative.',
  })
  status!: PricePlanStatus;

  @ApiProperty({
    enum: PlanModuleKey,
    enumName: 'PlanModuleKey',
    isArray: true,
    example: ['A1', 'A2', 'A4', 'resident_liff', 'promptpay'],
    description: 'Modules included in the plan (D-150, D-156).',
  })
  features!: PlanModuleKey[];

  @ApiProperty({
    example: true,
    description:
      'A published price version is in force and the plan is sold now; false = a proposal (draft version) shown for information (D-204, D-208).',
  })
  sold!: boolean;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-01-01',
    description: 'Effective date of the price version in force; null for a proposal.',
  })
  effectiveFrom!: string | null;
}

export class PublicPlansDto {
  @ApiProperty({ type: () => [PublicPlanDto] })
  data!: PublicPlanDto[];
}

export class PublicTariffQuery {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  @IsEnum(UtilityProviderName)
  provider!: UtilityProviderName;

  @ApiPropertyOptional({
    example: '1.1',
    description: 'Customer class; the residential class (1.1) by default.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tariffCode?: string;
}

export class PublicTariffDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  provider!: UtilityProviderName;

  @ApiProperty({ example: 'ประเภท 1.1 บ้านอยู่อาศัย' })
  nameTh!: string;

  @ApiProperty({ example: '1.1' })
  tariffCode!: string;

  @ApiProperty({
    example: '4.6189',
    description:
      'The lawful ceiling per unit published by the utility (highest marginal rate + Ft, excl. VAT).',
  })
  ceilingPerUnit!: string;

  @ApiProperty({ format: 'date', example: FAKE.date })
  effectiveFrom!: string;

  @ApiProperty({ example: 'https://www.mea.or.th/' })
  sourceUrl!: string;
}
