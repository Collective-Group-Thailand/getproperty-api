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

  @ApiProperty({ type: [String], example: ['A1', 'A2', 'A4', 'resident_liff', 'promptpay'] })
  features!: string[];
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
