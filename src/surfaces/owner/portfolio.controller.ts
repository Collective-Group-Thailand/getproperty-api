import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { PortfolioService } from '@modules/ops-units/portfolio.service';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { DecimalInput, MoneyInput, MoneyOutput } from '../shared/fields';
import { ApiSurface, SURFACES } from '../surfaces';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

export enum PortfolioUnitKindName {
  CondoUnit = 'condo_unit',
  House = 'house',
  Townhouse = 'townhouse',
  Room = 'room',
}
export enum FurnishingName {
  Unfurnished = 'unfurnished',
  PartlyFurnished = 'partly_furnished',
  FullyFurnished = 'fully_furnished',
}
export enum PortfolioUnitStateName {
  Vacant = 'vacant',
  Leased = 'leased',
  NoticeGiven = 'notice_given',
}

export class PortfolioAddressDto {
  @ApiProperty({ example: '99/12 ซอยอารีย์ 4 ถนนพหลโยธิน' })
  @IsString()
  @Length(1, 300)
  line1!: string;

  @ApiPropertyOptional({ example: 'สามเสนใน' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  subdistrict?: string;

  @ApiPropertyOptional({ example: 'พญาไท' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  district?: string;

  @ApiProperty({ example: 'กรุงเทพมหานคร' })
  @IsString()
  @Length(1, 100)
  province!: string;

  @ApiProperty({ example: '10400' })
  @Matches(/^\d{5}$/)
  postcode!: string;
}

export class PortfolioUnitCreateDto {
  @ApiProperty({
    enum: PortfolioUnitKindName,
    enumName: 'PortfolioUnitKind',
    example: PortfolioUnitKindName.CondoUnit,
  })
  @IsEnum(PortfolioUnitKindName)
  kind!: PortfolioUnitKindName;

  @ApiPropertyOptional({
    example: 'ไอดีโอ โมบิ อารีย์',
    description:
      'Condo project (required for a condo unit: units of one project share one building) or a house name.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  projectName?: string;

  @ApiPropertyOptional({ example: '12/345', description: 'Unit number (required for a condo unit).' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  unitNo?: string;

  @ApiProperty({ type: PortfolioAddressDto })
  @ValidateNested()
  @Type(() => PortfolioAddressDto)
  address!: PortfolioAddressDto;

  @ApiPropertyOptional({ example: 13.7799 })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 100.5446 })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @DecimalInput({ example: '28.50', description: 'Area in m².', optional: true })
  areaSqm?: string;

  @ApiPropertyOptional({ type: 'integer', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  bedrooms?: number;

  @ApiPropertyOptional({ type: 'integer', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  bathrooms?: number;

  @ApiPropertyOptional({ example: '12', description: 'Floor as written by the owner (e.g. 12, G, M).' })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  floorLabel?: string;

  @ApiPropertyOptional({
    enum: FurnishingName,
    enumName: 'Furnishing',
    example: FurnishingName.FullyFurnished,
  })
  @IsOptional()
  @IsEnum(FurnishingName)
  furnishing?: FurnishingName;

  @MoneyInput({
    example: '15000.00',
    description: 'Default monthly rent for new leases and listings.',
    optional: true,
  })
  defaultRent?: string;
}

export class PortfolioUnitCreatedDto {
  @ApiProperty({ format: 'uuid' })
  unitId!: string;

  @ApiProperty({ format: 'uuid' })
  buildingId!: string;

  @ApiProperty({ format: 'uuid' })
  propertyId!: string;

  @ApiProperty({
    example: true,
    description: 'The unit sits in the stub building of a condo not on getproperty yet.',
  })
  stub!: boolean;
}

export class PortfolioBuildingRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'ไอดีโอ โมบิ อารีย์' })
  name!: string;

  @ApiProperty({
    example: true,
    description: 'A stub of a condo whose juristic person is not on getproperty yet.',
  })
  external!: boolean;
}

export class PortfolioInvoiceRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'issued' })
  status!: string;

  @MoneyOutput({ example: '15000.00', description: 'Invoice total.' })
  total!: string;

  @MoneyOutput({ example: '15000.00', description: 'Still to pay.' })
  balance!: string;
}

export class PortfolioUnitDto {
  @ApiProperty({ format: 'uuid' })
  unitId!: string;

  @ApiProperty({ example: '12/345' })
  unitNo!: string;

  @ApiProperty({ enum: PortfolioUnitKindName, enumName: 'PortfolioUnitKind', nullable: true })
  kind!: PortfolioUnitKindName | null;

  @ApiProperty({ type: PortfolioBuildingRefDto })
  building!: PortfolioBuildingRefDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { province: 'กรุงเทพมหานคร' },
  })
  address!: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true, example: '28.50' })
  areaSqm!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  bedrooms!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  bathrooms!: number | null;

  @ApiProperty({ type: String, nullable: true, example: '12' })
  floorLabel!: string | null;

  @ApiProperty({ enum: FurnishingName, enumName: 'Furnishing', nullable: true })
  furnishing!: FurnishingName | null;

  @MoneyOutput({ example: '15000.00', nullable: true, description: 'Default monthly rent.' })
  defaultRent!: string | null;

  @ApiProperty({
    enum: PortfolioUnitStateName,
    enumName: 'PortfolioUnitState',
    example: PortfolioUnitStateName.Leased,
  })
  state!: PortfolioUnitStateName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  leaseId!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-05-31' })
  leaseEndDate!: string | null;

  @ApiProperty({
    type: PortfolioInvoiceRefDto,
    nullable: true,
    description: 'This month’s invoice of the unit.',
  })
  invoice!: PortfolioInvoiceRefDto | null;

  @ApiProperty({ type: 'integer', example: 0 })
  openServiceRequests!: number;
}

export class PortfolioTotalsDto {
  @ApiProperty({ example: '2026-10' })
  month!: string;

  @MoneyOutput({ example: '30000.00', description: 'Invoiced this month (issued, not void).' })
  expected!: string;

  @MoneyOutput({ example: '15000.00', description: 'Paid on this month’s invoices.' })
  collected!: string;

  @MoneyOutput({ example: '0.00', description: 'Open balance of overdue invoices, any month.' })
  overdue!: string;
}

export class PortfolioDto {
  @ApiProperty({ type: [PortfolioUnitDto] })
  units!: PortfolioUnitDto[];

  @ApiProperty({ type: PortfolioTotalsDto })
  totals!: PortfolioTotalsDto;
}

/**
 * The landlord's portfolio (B7.1, D-251): add a unit in one step (condo unit, house, townhouse, room) and the
 * portfolio-first home across projects.
 */
@ApiTags('owner.portfolio')
@ApiSurface(SURFACES.owner)
@Controller('owner/portfolio')
export class OwnerPortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.portfolio.get',
    summary: 'My portfolio',
    description:
      'Every unit of the landlord across projects with its state (vacant / leased / notice given), lease end, this month’s invoice and open repairs, and the month’s totals (expected, collected, overdue) as decimal strings (D-251).',
    implements: ['D-251'],
  })
  @ApiSuccess(200, {
    description: 'Portfolio',
    type: PortfolioDto,
    example: {
      units: [
        {
          unitId: FAKE.uuid,
          unitNo: '12/345',
          kind: PortfolioUnitKindName.CondoUnit,
          building: { id: FAKE.buildingId, name: 'ไอดีโอ โมบิ อารีย์', external: true },
          address: { province: 'กรุงเทพมหานคร', postcode: '10400' },
          areaSqm: '28.50',
          bedrooms: 1,
          bathrooms: 1,
          floorLabel: '12',
          furnishing: FurnishingName.FullyFurnished,
          defaultRent: '15000.00',
          state: PortfolioUnitStateName.Leased,
          leaseId: FAKE.uuid,
          leaseEndDate: '2027-05-31',
          invoice: { id: FAKE.uuid, status: 'issued', total: '15000.00', balance: '15000.00' },
          openServiceRequests: 0,
        },
      ],
      totals: { month: '2026-10', expected: '15000.00', collected: '0.00', overdue: '0.00' },
    },
  })
  @ApiStandardErrors(...T)
  get(@CurrentTenant() ctx: TenantContext): Promise<PortfolioDto> {
    return this.portfolio.portfolio(ctx) as Promise<PortfolioDto>;
  }

  @Post('units')
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.portfolio.addUnit',
    summary: 'Add a unit to my portfolio',
    description:
      'A house, townhouse or room becomes a one-unit property + building of the landlord; a condo unit joins the shared stub building of its project (found by project name + postcode, created when new) — two landlords in one condo share the stub and each sees only its own units. The landlord is recorded as the owner (`self_declared`, verified later, D-252). `portfolio.unit_claimed` when another owner already registered that unit number in the project (D-251).',
    implements: ['D-251'],
  })
  @ApiJsonBody(PortfolioUnitCreateDto, {
    kind: 'condo_unit',
    projectName: 'ไอดีโอ โมบิ อารีย์',
    unitNo: '12/345',
    address: { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' },
    areaSqm: '28.50',
    bedrooms: 1,
    bathrooms: 1,
    floorLabel: '12',
    furnishing: 'fully_furnished',
    defaultRent: '15000.00',
  })
  @ApiSuccess(201, {
    description: 'Unit added',
    type: PortfolioUnitCreatedDto,
    example: { unitId: FAKE.uuid, buildingId: FAKE.buildingId, propertyId: FAKE.uuid, stub: true },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.conflict',
    'auth.forbidden',
    'portfolio.unit_claimed',
    ...T,
  )
  addUnit(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: PortfolioUnitCreateDto,
  ): Promise<PortfolioUnitCreatedDto> {
    return this.portfolio.addUnit(ctx, body);
  }
}
