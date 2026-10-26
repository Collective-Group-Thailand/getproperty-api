import { ApiProperty } from '@nestjs/swagger';

/** One price block of a tiered utility rate (D-265). */
export class ListingUtilityTierDto {
  @ApiProperty({ example: '0', description: 'Units from (inclusive), decimal string.' })
  fromUnits!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '150',
    description: 'Units up to; null = no upper end.',
  })
  toUnits!: string | null;

  @ApiProperty({ example: '7.0000', description: 'THB per unit (kWh or m³).' })
  pricePerUnit!: string;
}

/** A power or water rate the unit is billed at (D-265). */
export class ListingUtilityRateDto {
  @ApiProperty({ enum: ['flat', 'tiered'], enumName: 'ListingUtilityRateKind', example: 'flat' })
  kind!: 'flat' | 'tiered';

  @ApiProperty({ type: String, nullable: true, example: '7.0000', description: 'Flat: THB per unit.' })
  pricePerUnit!: string | null;

  @ApiProperty({ type: [ListingUtilityTierDto], description: 'Tiered: the blocks in order.' })
  tiers!: ListingUtilityTierDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '100.00',
    description: 'Minimum charge per bill, THB.',
  })
  minimumCharge!: string | null;
}

export class ListingFixedChargeDto {
  @ApiProperty({
    enum: ['common_fee', 'service', 'fund'],
    enumName: 'ListingFixedChargeKind',
    example: 'service',
  })
  kind!: 'common_fee' | 'service' | 'fund';

  @ApiProperty({ example: 'ค่าส่วนกลาง' })
  name!: string;

  @ApiProperty({ example: '500.00', description: 'THB per month.' })
  amount!: string;
}

/**
 * The unit's real utility cost (D-265): the rates it is billed at and, when the owner shows it and the unit has
 * enough confirmed bills, the average utility amount of the last three (amounts only — no resident, no months).
 */
export class ListingUtilityDto {
  @ApiProperty({ type: ListingUtilityRateDto, nullable: true })
  electricity!: ListingUtilityRateDto | null;

  @ApiProperty({ type: ListingUtilityRateDto, nullable: true })
  water!: ListingUtilityRateDto | null;

  @ApiProperty({ type: [ListingFixedChargeDto], description: 'Fixed monthly charges of the unit.' })
  fixedCharges!: ListingFixedChargeDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1240.50',
    description:
      'Average electricity + water of the last three confirmed bills, THB; null below `listing.utility_history.min_bills` or switched off.',
  })
  averageBill3m!: string | null;

  @ApiProperty({ type: 'integer', example: 3, description: 'Bills behind the average (0 when not shown).' })
  basedOnBills!: number;
}

/** Rent band of comparable listings (D-269): 25th, 50th and 75th percentile, THB per month. */
export class ListingRentBandDto {
  @ApiProperty({ example: '12500.00' })
  p25!: string;

  @ApiProperty({ example: '14000.00' })
  p50!: string;

  @ApiProperty({ example: '16000.00' })
  p75!: string;
}

export class ListingComparablesDto {
  @ApiProperty({ type: ListingRentBandDto, nullable: true, description: 'Null below `minimum` comparables.' })
  band!: ListingRentBandDto | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 21,
    description: 'Median days from publishing to let.',
  })
  medianDaysToLet!: number | null;

  @ApiProperty({ type: 'integer', example: 12, description: 'Comparable listings found.' })
  sampleSize!: number;

  @ApiProperty({ type: 'integer', example: 8, description: '`listing.comparables.min`.' })
  minimum!: number;
}

export class PublicAreaDto {
  @ApiProperty({
    example: 'phaya-thai',
    pattern: '^[a-z0-9-]{1,80}$',
    description: 'ASCII slug of the area page (`/rent/area/{slug}`); stable for a given name.',
  })
  slug!: string;

  @ApiProperty({ example: 'พญาไท', description: 'Thai name.' })
  name!: string;

  @ApiProperty({
    example: 'Phaya Thai',
    description: 'English name (the Thai name when the platform has no English name for it yet).',
  })
  nameEn!: string;

  @ApiProperty({ enum: ['district', 'station'], enumName: 'PublicAreaKind', example: 'district' })
  kind!: 'district' | 'station';

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'กรุงเทพมหานคร',
    description: 'The province (of most of a station’s listings).',
  })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Bangkok' })
  provinceEn!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'A station’s line as owners name it, else its system (BTS, MRT, ARL); null for a district.',
  })
  line!: string | null;

  @ApiProperty({ type: 'integer', example: 14, description: 'Published listings.' })
  count!: number;

  @ApiProperty({ type: ListingRentBandDto, nullable: true })
  band!: ListingRentBandDto | null;

  @ApiProperty({
    example: true,
    description: 'At least `listing.area.index_min` listings (else the page is noindex).',
  })
  indexable!: boolean;
}

export class PublicAreasDto {
  @ApiProperty({ type: [PublicAreaDto] })
  data!: PublicAreaDto[];
}
