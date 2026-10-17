import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { toBangkokIso } from '@common/time/bangkok';
import { BoardService } from '@modules/ops-units/board.service';
import { AmenitiesService, MetersService } from '@modules/ops-units/meters-items.service';
import { UnitProfilesService, UtilityAccountsService } from '@modules/ops-units/profiles-accounts.service';
import { StructureService } from '@modules/ops-units/structure.service';
import { UnitImportService, XLSX_MIME } from '@modules/ops-units/unit-import.service';
import { UnitsService } from '@modules/ops-units/units.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  AmenityCreateDto,
  AmenityDto,
  AmenityRetireDto,
  AmenityUpdateDto,
  BoardDto,
  BuildingCreateDto,
  BuildingDto,
  BuildingUpdateDto,
  CommonMeterCreateDto,
  FloorCreateDto,
  FloorDto,
  FloorUpdateDto,
  isUnitSort,
  MeterCreateDto,
  MeterDto,
  MissingMetersCreateDto,
  PropertyCreateDto,
  PropertyDto,
  PropertyUpdateDto,
  UnitBulkCreateDto,
  UnitCountDto,
  UnitCreateDto,
  UnitDto,
  UnitImportCommitDto,
  UnitImportPreviewDto,
  UnitImportPreviewRequestDto,
  UnitListQuery,
  UnitProfileCreateDto,
  UnitProfileDto,
  UnitProfileUpdateDto,
  UnitStatusChangeDto,
  UnitUpdateDto,
  UtilityAccountCreateDto,
  UtilityAccountDto,
  UtilityAccountUpdateDto,
} from './assets.dto';
import {
  AMENITY_EXAMPLE,
  amenityDto,
  BOARD_EXAMPLE,
  boardDto,
  BUILDING_EXAMPLE,
  buildingDto,
  FLOOR_EXAMPLE,
  floorDto,
  ifMatchVersion,
  IMPORT_PREVIEW_EXAMPLE,
  importPreviewDto,
  METER_EXAMPLE,
  meterDto,
  PROPERTY_EXAMPLE,
  propertyDto,
  UNIT_EXAMPLE,
  UNIT_PROFILE_EXAMPLE,
  unitDto,
  unitProfileDto,
  UTILITY_ACCOUNT_EXAMPLE,
  utilityAccountDto,
} from './assets.mappers';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', 'asset.read_only', ...T] as const;
const XLSX_EXAMPLE = 'UEsDBBQABgAIAAAAIQ… (xlsx bytes)';

function xlsx(res: Response, fileName: string, body: Buffer): void {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

const ApiXlsx = (description: string) =>
  ApiResponse({
    status: 200,
    description,
    content: { [XLSX_MIME]: { schema: { type: 'string', format: 'binary' }, example: XLSX_EXAMPLE } },
  });

// ------------------------------------------------------------------------------------------- properties

@ApiTags('owner.properties')
@ApiSurface(SURFACES.owner)
@Controller('owner/properties')
export class OwnerPropertiesController {
  constructor(private readonly structure: StructureService) {}

  @Get()
  @TenantScoped()
  @Can('property.read')
  @ApiEndpoint({
    id: 'owner.properties.list',
    summary: 'Properties of my tenant',
    description:
      'Properties (groups of buildings) visible to the tenant: its own and those of buildings it operates or holds a grant for (D-151, D-152).',
    implements: ['D-151', 'D-152'],
  })
  @ApiSuccess(200, { description: 'Properties', type: [PropertyDto], example: [PROPERTY_EXAMPLE] })
  @ApiStandardErrors(...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<PropertyDto[]> {
    return (await this.structure.listProperties(ctx)).map(propertyDto);
  }

  @Post()
  @TenantScoped()
  @Can('property.manage')
  @ApiEndpoint({
    id: 'owner.properties.create',
    summary: 'Create a property',
    description: 'A property groups buildings managed together; its code is unique per tenant (D-151).',
    implements: ['D-151'],
  })
  @ApiJsonBody(PropertyCreateDto, { code: 'MAIN', name: FAKE.propertyName, provinceCode: '10' })
  @ApiSuccess(201, { description: 'Created', type: PropertyDto, example: PROPERTY_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: PropertyCreateDto): Promise<PropertyDto> {
    return propertyDto(await this.structure.createProperty(ctx, { ...body, address: body.address as never }));
  }

  @Get(':propertyId')
  @TenantScoped()
  @Can('property.read')
  @UseEtag((p: PropertyDto) => etagOf(p.id, p.version))
  @ApiEndpoint({
    id: 'owner.properties.get',
    summary: 'One property',
    description: 'A property of the tenant (404 for another tenant’s property, contract §8).',
    implements: ['D-151', 'D-152'],
  })
  @ApiSuccess(200, { description: 'The property', type: PropertyDto, example: PROPERTY_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('propertyId', ParseUUIDPipe) id: string,
  ): Promise<PropertyDto> {
    return propertyDto(await this.structure.getProperty(ctx, id));
  }

  @Patch(':propertyId')
  @TenantScoped()
  @Can('property.manage')
  @UseEtag((p: PropertyDto) => etagOf(p.id, p.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.properties.update',
    summary: 'Update a property',
    description: 'Name, address, province or status; requires `If-Match` (contract §3).',
    implements: ['D-151'],
  })
  @ApiJsonBody(PropertyUpdateDto, { name: FAKE.propertyName })
  @ApiSuccess(200, { description: 'Updated', type: PropertyDto, example: PROPERTY_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('propertyId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: PropertyUpdateDto,
  ): Promise<PropertyDto> {
    const version = ifMatchVersion(ifMatch, await this.structure.getProperty(ctx, id));
    return propertyDto(
      await this.structure.updateProperty(ctx, id, version, { ...body, address: body.address as never }),
    );
  }
}

// ------------------------------------------------------------------------------------------- buildings & floors

@ApiTags('owner.buildings')
@ApiSurface(SURFACES.owner)
@Controller('owner/buildings')
export class OwnerBuildingsController {
  constructor(private readonly structure: StructureService) {}

  @Get()
  @TenantScoped()
  @Can('property.read')
  @ApiQuery({ name: 'propertyId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiEndpoint({
    id: 'owner.buildings.list',
    summary: 'Buildings I own, operate or hold a grant for',
    description:
      'Every visible building with its unit count and how the tenant sees it (operator, owner, grant — D-152); Staff limited to buildings see only theirs (D-090).',
    implements: ['D-090', 'D-151', 'D-152'],
  })
  @ApiSuccess(200, { description: 'Buildings', type: [BuildingDto], example: [BUILDING_EXAMPLE] })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query('propertyId', new ParseUUIDPipe({ optional: true })) propertyId?: string,
  ): Promise<BuildingDto[]> {
    return (await this.structure.listBuildings(ctx, propertyId)).map((r) =>
      buildingDto(ctx, r.building, r.unitCount),
    );
  }

  @Post()
  @TenantScoped()
  @Can('property.manage')
  @ApiEndpoint({
    id: 'owner.buildings.create',
    summary: 'Create a building',
    description:
      'Apartments: the tenant is both owner and operator of the building (`owner_tenant_id = operator_tenant_id`, schema-design §4.6); the initial operator period opens.',
    implements: ['D-150', 'D-151', 'D-152'],
  })
  @ApiJsonBody(BuildingCreateDto, {
    propertyId: FAKE.propertyId,
    code: 'A',
    name: 'อาคาร A',
    type: 'apartment',
    floorsCount: 2,
  })
  @ApiSuccess(201, { description: 'Created', type: BuildingDto, example: BUILDING_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: BuildingCreateDto): Promise<BuildingDto> {
    const b = await this.structure.createBuilding(ctx, { ...body, address: body.address as never });
    return buildingDto(ctx, b, 0);
  }

  @Get(':buildingId')
  @TenantScoped()
  @Can('property.read')
  @UseEtag((b: BuildingDto) => etagOf(b.id, b.version))
  @ApiEndpoint({
    id: 'owner.buildings.get',
    summary: 'One building',
    description: 'A visible building (404 when it belongs to another tenant without a grant, contract §8).',
    implements: ['D-151', 'D-152'],
  })
  @ApiSuccess(200, { description: 'The building', type: BuildingDto, example: BUILDING_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) id: string,
  ): Promise<BuildingDto> {
    const { building, unitCount } = await this.structure.getBuildingWithCount(ctx, id);
    return buildingDto(ctx, building, unitCount);
  }

  @Patch(':buildingId')
  @TenantScoped()
  @Can('property.manage')
  @UseEtag((b: BuildingDto) => etagOf(b.id, b.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.buildings.update',
    summary: 'Update a building',
    description:
      'Name, type, number of floors or status; only the owner or operator tenant may change it (403 `asset.read_only` for grantees). Requires `If-Match`.',
    implements: ['D-151', 'D-152'],
  })
  @ApiJsonBody(BuildingUpdateDto, { name: 'อาคาร A', floorsCount: 3 })
  @ApiSuccess(200, { description: 'Updated', type: BuildingDto, example: BUILDING_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: BuildingUpdateDto,
  ): Promise<BuildingDto> {
    const version = ifMatchVersion(ifMatch, await this.structure.getBuilding(ctx, id));
    await this.structure.updateBuilding(ctx, id, version, body);
    const { building, unitCount } = await this.structure.getBuildingWithCount(ctx, id);
    return buildingDto(ctx, building, unitCount);
  }
}

@ApiTags('owner.floors')
@ApiSurface(SURFACES.owner)
@Controller('owner/buildings/:buildingId/floors')
export class OwnerFloorsController {
  constructor(private readonly structure: StructureService) {}

  @Get()
  @TenantScoped()
  @Can('property.read')
  @ApiEndpoint({
    id: 'owner.floors.list',
    summary: 'Floors of a building',
    description: 'Floors in display order with their unit counts (B2.1).',
    implements: ['D-151'],
  })
  @ApiSuccess(200, { description: 'Floors', type: [FloorDto], example: [FLOOR_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<FloorDto[]> {
    return (await this.structure.listFloors(ctx, buildingId)).map((r) => floorDto(r.floor, r.unitCount));
  }

  @Post()
  @TenantScoped()
  @Can('property.manage')
  @ApiEndpoint({
    id: 'owner.floors.create',
    summary: 'Add a floor',
    description: 'A floor level is unique per building (409 `asset.duplicate`).',
    implements: ['D-151'],
  })
  @ApiJsonBody(FloorCreateDto, { level: 2, name: 'ชั้น 2' })
  @ApiSuccess(201, { description: 'Created', type: FloorDto, example: { ...FLOOR_EXAMPLE, unitCount: 0 } })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: FloorCreateDto,
  ): Promise<FloorDto> {
    return floorDto(await this.structure.createFloor(ctx, buildingId, body), 0);
  }

  @Patch(':floorId')
  @TenantScoped()
  @Can('property.manage')
  @ApiEndpoint({
    id: 'owner.floors.update',
    summary: 'Rename or reorder a floor',
    description: 'Changes level, name or display order of a floor of a building the tenant operates.',
    implements: ['D-151'],
  })
  @ApiJsonBody(FloorUpdateDto, { name: 'ชั้น 2 (ปีกตะวันออก)' })
  @ApiSuccess(200, { description: 'Updated', type: FloorDto, example: FLOOR_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Param('floorId', ParseUUIDPipe) floorId: string,
    @Body() body: FloorUpdateDto,
  ): Promise<FloorDto> {
    const f = await this.structure.updateFloor(ctx, buildingId, floorId, body);
    const count =
      (await this.structure.listFloors(ctx, buildingId)).find((r) => r.floor.id === f.id)?.unitCount ?? 0;
    return floorDto(f, count);
  }
}

@ApiTags('owner.unitBoard')
@ApiSurface(SURFACES.owner)
@Controller('owner/buildings/:buildingId/board')
export class OwnerUnitBoardController {
  constructor(private readonly board: BoardService) {}

  @Get()
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.unitBoard.get',
    summary: 'Unit board of a building',
    description:
      'Floors (top first) with unit cards: status, lessee, lease end, balance (B4.5) and meter health (B3.4) — later fields stay null until their deliverable. The owner console’s main screen (D-100).',
    implements: ['D-100', 'D-151'],
  })
  @ApiSuccess(200, { description: 'The board', type: BoardDto, example: BOARD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<BoardDto> {
    return boardDto(await this.board.board(ctx, buildingId));
  }
}

// ------------------------------------------------------------------------------------------- units

@ApiTags('owner.units')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerUnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get('units/count')
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.units.count',
    summary: 'Unit count for the subscription',
    description:
      'Units of the tenant by status; `billable` = units whose status is not inactive, the per-unit subscription basis (D-082, D-156). B6.1 snapshots it on the 1st of each month.',
    implements: ['D-082', 'D-156'],
  })
  @ApiSuccess(200, {
    description: 'Counts',
    type: UnitCountDto,
    example: {
      billable: 12,
      inactive: 0,
      byStatus: { vacant: 3, reserved: 0, occupied: 8, maintenance: 1, inactive: 0 },
      countedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors(...T)
  async count(@CurrentTenant() ctx: TenantContext): Promise<UnitCountDto> {
    const c = await this.units.count(ctx);
    return {
      billable: c.billable,
      inactive: c.inactive,
      byStatus: {
        vacant: c.byStatus.vacant ?? 0,
        reserved: c.byStatus.reserved ?? 0,
        occupied: c.byStatus.occupied ?? 0,
        maintenance: c.byStatus.maintenance ?? 0,
        inactive: c.byStatus.inactive ?? 0,
      },
      countedAt: toBangkokIso(c.countedAt),
    };
  }

  @Get('units')
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.units.list',
    summary: 'Units',
    description:
      'Units visible to the tenant — its own, those of buildings it owns or operates, and units granted to it (a landlord sees only its granted units, D-152) — filtered by building, floor, status or `q` on the unit number; sort `unitNo` (default), `createdAt` or `status`.',
    implements: ['D-151', 'D-152'],
  })
  @ApiPaginated(UnitDto, { example: UNIT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: UnitListQuery): Promise<Page<UnitDto>> {
    const { rows, total } = await this.units.list(ctx, {
      buildingId: query.buildingId,
      floorId: query.floorId,
      status: query.status,
      q: query.q,
      ...toSkipTake(query),
      sort: isUnitSort(query.sort) ? query.sort : 'unitNo',
      order: query.sort ? query.order : 'asc',
    });
    return paginated(rows.map(unitDto), total, query);
  }

  @Post('units')
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.units.create',
    summary: 'Create a unit',
    description:
      'A unit (`type` default room, D-151) with its operational detail; rent and area default from the unit profile. In a building the tenant owns, its legal party becomes the unit owner (apartments). Unit numbers are unique per building.',
    implements: ['D-150', 'D-151'],
  })
  @ApiJsonBody(UnitCreateDto, {
    buildingId: FAKE.buildingId,
    floorId: FAKE.uuid,
    unitNo: FAKE.unitCode,
    baseRent: '4500.00',
  })
  @ApiSuccess(201, { description: 'Created', type: UnitDto, example: UNIT_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: UnitCreateDto): Promise<UnitDto> {
    const { buildingId, ...input } = body;
    return unitDto(await this.units.create(ctx, buildingId, input));
  }

  @Post('buildings/:buildingId/units/bulk')
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.units.bulkCreate',
    summary: 'Create units floor by floor',
    description:
      'Creates `countPerFloor` units on each floor numbered by a pattern (`{building}-{floor}{nn}` → A-201 … A-206). All or nothing: any existing number refuses the whole batch (409 `asset.duplicate`). Audited (`unit.bulk_created`).',
    implements: ['D-151'],
  })
  @ApiJsonBody(UnitBulkCreateDto, {
    floorIds: [FAKE.uuid],
    countPerFloor: 6,
    pattern: '{building}-{floor}{nn}',
    unitProfileId: FAKE.uuid,
  })
  @ApiSuccess(201, { description: 'Created units', type: [UnitDto], example: [UNIT_EXAMPLE] })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async bulk(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UnitBulkCreateDto,
  ): Promise<UnitDto[]> {
    return (
      await this.units.bulkCreate(ctx, buildingId, {
        ...body,
        pattern: body.pattern ?? '{building}-{floor}{nn}',
      })
    ).map(unitDto);
  }

  @Get('units/:unitId')
  @TenantScoped()
  @Can('unit.read')
  @UseEtag((u: UnitDto) => etagOf(u.id, u.version))
  @ApiEndpoint({
    id: 'owner.units.get',
    summary: 'One unit',
    description:
      'A visible unit with its detail and profile (404 across tenants without a grant, contract §8).',
    implements: ['D-151', 'D-152'],
  })
  @ApiSuccess(200, { description: 'The unit', type: UnitDto, example: UNIT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) id: string,
  ): Promise<UnitDto> {
    return unitDto(await this.units.get(ctx, id));
  }

  @Patch('units/:unitId')
  @TenantScoped()
  @Can('unit.manage')
  @UseEtag((u: UnitDto) => etagOf(u.id, u.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.units.update',
    summary: 'Update a unit',
    description:
      'Number, floor, type, area, base rent, profile, notes. Status is not edited here (leases and service work drive it; manual override through `actions/set-status`). Requires `If-Match`.',
    implements: ['D-151'],
  })
  @ApiJsonBody(UnitUpdateDto, { baseRent: '4800.00', notes: 'ห้องมุม' })
  @ApiSuccess(200, { description: 'Updated', type: UnitDto, example: UNIT_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: UnitUpdateDto,
  ): Promise<UnitDto> {
    const version = ifMatchVersion(ifMatch, await this.units.get(ctx, id));
    return unitDto(await this.units.update(ctx, id, version, body));
  }

  @Post('units/:unitId/actions/set-status')
  @HttpCode(200)
  @TenantScoped()
  @Can('unit.manage')
  @UseEtag((u: UnitDto) => etagOf(u.id, u.version))
  @ApiEndpoint({
    id: 'owner.units.setStatus',
    summary: 'Take a unit out of service or back',
    description:
      'Manual override only between vacant and inactive or maintenance, with a reason (audited `unit.status_changed`); reserved/occupied follow leases (409 `unit.invalid_status_transition`). Inactive units are not counted for the subscription (D-082).',
    implements: ['D-082', 'D-151'],
  })
  @ApiJsonBody(UnitStatusChangeDto, { status: 'maintenance', reason: 'ปรับปรุงห้องน้ำ' })
  @ApiSuccess(200, {
    description: 'Status changed',
    type: UnitDto,
    example: { ...UNIT_EXAMPLE, status: 'maintenance' },
  })
  @ApiStandardErrors('unit.invalid_status_transition', ...WRITE)
  async setStatus(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) id: string,
    @Body() body: UnitStatusChangeDto,
  ): Promise<UnitDto> {
    return unitDto(await this.units.setStatus(ctx, id, body));
  }
}

// ------------------------------------------------------------------------------------------- profiles & accounts

@ApiTags('owner.unitProfiles')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerUnitProfilesController {
  constructor(private readonly profiles: UnitProfilesService) {}

  @Get('buildings/:buildingId/unit-profiles')
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.unitProfiles.list',
    summary: 'Room types of a building',
    description:
      'Unit profiles: size, default rent, deposit/advance months and lease lines proposed on new leases (D-041).',
    implements: ['D-041', 'D-151'],
  })
  @ApiSuccess(200, { description: 'Profiles', type: [UnitProfileDto], example: [UNIT_PROFILE_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<UnitProfileDto[]> {
    return (await this.profiles.list(ctx, buildingId)).map(unitProfileDto);
  }

  @Post('buildings/:buildingId/unit-profiles')
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.unitProfiles.create',
    summary: 'Add a room type',
    description:
      'Names are unique per building. Deposit + advance months are checked against the cap when a lease is drafted (D-023).',
    implements: ['D-023', 'D-041'],
  })
  @ApiJsonBody(UnitProfileCreateDto, {
    name: 'ห้องสตูดิโอ',
    areaSqm: '28.00',
    defaultRent: '4500.00',
    defaultDepositMonths: '1',
    defaultAdvanceRentMonths: '1',
    defaultLeaseLines: [{ kind: 'internet', description: 'อินเทอร์เน็ตไฟเบอร์', amount: '300.00' }],
  })
  @ApiSuccess(201, { description: 'Created', type: UnitProfileDto, example: UNIT_PROFILE_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UnitProfileCreateDto,
  ): Promise<UnitProfileDto> {
    return unitProfileDto(await this.profiles.create(ctx, buildingId, body));
  }

  @Patch('unit-profiles/:unitProfileId')
  @TenantScoped()
  @Can('unit.manage')
  @UseEtag((p: UnitProfileDto) => etagOf(p.id, p.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.unitProfiles.update',
    summary: 'Update a room type',
    description:
      'Changes apply to new leases only; signed leases keep their terms (D-020 no mid-term increase). Requires `If-Match`.',
    implements: ['D-020', 'D-041'],
  })
  @ApiJsonBody(UnitProfileUpdateDto, { defaultRent: '4800.00' })
  @ApiSuccess(200, { description: 'Updated', type: UnitProfileDto, example: UNIT_PROFILE_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitProfileId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: UnitProfileUpdateDto,
  ): Promise<UnitProfileDto> {
    const version = ifMatchVersion(ifMatch, await this.profiles.get(ctx, id));
    return unitProfileDto(await this.profiles.update(ctx, id, version, body));
  }

  @Delete('unit-profiles/:unitProfileId')
  @HttpCode(204)
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.unitProfiles.remove',
    summary: 'Remove a room type',
    description: 'Soft delete; units keep the reference for history.',
    implements: ['D-151'],
  })
  @ApiSuccess(204, { description: 'Removed' })
  @ApiStandardErrors('http.not_found', 'asset.read_only', 'validation.failed', ...T)
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitProfileId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.profiles.remove(ctx, id);
  }
}

@ApiTags('owner.utilityAccounts')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerUtilityAccountsController {
  constructor(private readonly accounts: UtilityAccountsService) {}

  @Get('buildings/:buildingId/utility-accounts')
  @TenantScoped()
  @Can('property.read')
  @ApiEndpoint({
    id: 'owner.utilityAccounts.list',
    summary: 'Utility accounts of a building',
    description:
      'The building’s MEA/PEA/MWA/PWA customer accounts; utility invoices attach to them for the loss report (D-032).',
    implements: ['D-032'],
  })
  @ApiSuccess(200, { description: 'Accounts', type: [UtilityAccountDto], example: [UTILITY_ACCOUNT_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<UtilityAccountDto[]> {
    return (await this.accounts.list(ctx, buildingId)).map(utilityAccountDto);
  }

  @Post('buildings/:buildingId/utility-accounts')
  @TenantScoped()
  @Can('property.manage')
  @ApiEndpoint({
    id: 'owner.utilityAccounts.create',
    summary: 'Add a utility account',
    description:
      'Electric accounts are MEA or PEA, water accounts MWA or PWA; one customer number once per building and utility (D-032).',
    implements: ['D-032'],
  })
  @ApiJsonBody(UtilityAccountCreateDto, {
    utility: 'electric',
    provider: 'mea',
    customerNo: '000012345678',
    label: 'มิเตอร์หลักอาคาร A',
  })
  @ApiSuccess(201, { description: 'Created', type: UtilityAccountDto, example: UTILITY_ACCOUNT_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UtilityAccountCreateDto,
  ): Promise<UtilityAccountDto> {
    return utilityAccountDto(await this.accounts.create(ctx, buildingId, body));
  }

  @Patch('utility-accounts/:utilityAccountId')
  @TenantScoped()
  @Can('property.manage')
  @ApiEndpoint({
    id: 'owner.utilityAccounts.update',
    summary: 'Update a utility account',
    description: 'Provider, customer number, meter number or label (D-032).',
    implements: ['D-032'],
  })
  @ApiJsonBody(UtilityAccountUpdateDto, { label: 'มิเตอร์หลักอาคาร A (ใหม่)' })
  @ApiSuccess(200, { description: 'Updated', type: UtilityAccountDto, example: UTILITY_ACCOUNT_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('utilityAccountId', ParseUUIDPipe) id: string,
    @Body() body: UtilityAccountUpdateDto,
  ): Promise<UtilityAccountDto> {
    return utilityAccountDto(await this.accounts.update(ctx, id, body));
  }

  @Delete('utility-accounts/:utilityAccountId')
  @HttpCode(204)
  @TenantScoped()
  @Can('property.manage')
  @ApiEndpoint({
    id: 'owner.utilityAccounts.remove',
    summary: 'Remove a utility account',
    description: 'Only while no utility invoice refers to it (B3.4 adds the reference).',
    implements: ['D-032'],
  })
  @ApiSuccess(204, { description: 'Removed' })
  @ApiStandardErrors('http.not_found', 'asset.read_only', 'validation.failed', ...T)
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('utilityAccountId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.accounts.remove(ctx, id);
  }
}

// ------------------------------------------------------------------------------------------- meters & amenities

@ApiTags('owner.meters')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerMetersController {
  constructor(private readonly meters: MetersService) {}

  @Get('buildings/:buildingId/meters')
  @TenantScoped()
  @Can('asset_item.read')
  @ApiEndpoint({
    id: 'owner.meters.listForBuilding',
    summary: 'Meter positions of a building',
    description:
      'Active meter assignments: one per unit and utility, plus common-area and main meters (D-012, D-032).',
    implements: ['D-012', 'D-032'],
  })
  @ApiSuccess(200, { description: 'Meters', type: [MeterDto], example: [METER_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async listForBuilding(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<MeterDto[]> {
    return (await this.meters.listForBuilding(ctx, buildingId)).map(meterDto);
  }

  @Post('buildings/:buildingId/meters')
  @TenantScoped()
  @Can('asset_item.manage')
  @ApiEndpoint({
    id: 'owner.meters.createCommon',
    summary: 'Add a common-area or main meter',
    description:
      'A meter asset item bound to the building (not a unit) for the utility-loss balance (D-032).',
    implements: ['D-032'],
  })
  @ApiJsonBody(CommonMeterCreateDto, {
    purpose: 'main',
    utility: 'electric',
    code: 'MAIN-E',
    initialReading: '20345.1',
  })
  @ApiSuccess(201, {
    description: 'Created',
    type: MeterDto,
    example: { ...METER_EXAMPLE, unitId: null, unitNo: null, purpose: 'main', code: 'MAIN-E' },
  })
  @ApiStandardErrors('meter.already_assigned', ...WRITE)
  async createCommon(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: CommonMeterCreateDto,
  ): Promise<MeterDto> {
    return meterDto(await this.meters.createCommon(ctx, buildingId, body));
  }

  @Post('buildings/:buildingId/meters/actions/create-missing')
  @TenantScoped()
  @Can('asset_item.manage')
  @ApiEndpoint({
    id: 'owner.meters.createMissing',
    summary: 'Add manual meters to every unit without one',
    description:
      'For each unit lacking an active meter of a listed utility, creates the meter asset item and its assignment (manual meters of a Lite building, D-012). Returns the meters created.',
    implements: ['D-012'],
  })
  @ApiJsonBody(MissingMetersCreateDto, { utilities: ['electric', 'water'], initialReading: '0' })
  @ApiSuccess(201, { description: 'Meters created', type: [MeterDto], example: [METER_EXAMPLE] })
  @ApiStandardErrors('meter.already_assigned', ...WRITE)
  async createMissing(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: MissingMetersCreateDto,
  ): Promise<MeterDto[]> {
    return (await this.meters.createMissing(ctx, buildingId, body)).map(meterDto);
  }

  @Get('units/:unitId/meters')
  @TenantScoped()
  @Can('asset_item.read')
  @ApiEndpoint({
    id: 'owner.meters.listForUnit',
    summary: 'Meters of a unit (with history)',
    description: 'Current and closed meter assignments of the unit, newest first per utility (D-012, D-033).',
    implements: ['D-012', 'D-033'],
  })
  @ApiSuccess(200, { description: 'Meters', type: [MeterDto], example: [METER_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async listForUnit(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<MeterDto[]> {
    return (await this.meters.listForUnit(ctx, unitId)).map(meterDto);
  }

  @Post('units/:unitId/meters')
  @TenantScoped()
  @Can('asset_item.manage')
  @ApiEndpoint({
    id: 'owner.meters.createForUnit',
    summary: 'Add a meter to a unit',
    description:
      'One meter per unit and utility: the asset item plus its assignment with the initial reading and multiplier (D-012). A second active meter for the same utility is refused (409 `meter.already_assigned`).',
    implements: ['D-012'],
  })
  @ApiJsonBody(MeterCreateDto, { utility: 'electric', initialReading: '1234.5' })
  @ApiSuccess(201, { description: 'Created', type: MeterDto, example: METER_EXAMPLE })
  @ApiStandardErrors('meter.already_assigned', ...WRITE)
  async createForUnit(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: MeterCreateDto,
  ): Promise<MeterDto> {
    return meterDto(await this.meters.createForUnit(ctx, unitId, body));
  }
}

@ApiTags('owner.assetItems')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerAssetItemsController {
  constructor(private readonly amenities: AmenitiesService) {}

  @Get('units/:unitId/asset-items')
  @TenantScoped()
  @Can('asset_item.read')
  @ApiEndpoint({
    id: 'owner.assetItems.list',
    summary: 'Appliances and furniture of a unit',
    description:
      'Asset items listed on the contract annex and checked at move-in/out (legal-reference ข้อ 4 (1); D-151).',
    implements: ['D-020', 'D-151'],
  })
  @ApiSuccess(200, { description: 'Items', type: [AmenityDto], example: [AMENITY_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<AmenityDto[]> {
    return (await this.amenities.list(ctx, unitId)).map(amenityDto);
  }

  @Post('units/:unitId/asset-items')
  @TenantScoped()
  @Can('asset_item.manage')
  @ApiEndpoint({
    id: 'owner.assetItems.create',
    summary: 'Add an appliance or furniture',
    description: 'A `core.asset_item` of the unit (appliance, furniture, air conditioner, other).',
    implements: ['D-151'],
  })
  @ApiJsonBody(AmenityCreateDto, { category: 'appliance', name: 'ตู้เย็น', location: 'ห้องนอน' })
  @ApiSuccess(201, { description: 'Created', type: AmenityDto, example: AMENITY_EXAMPLE })
  @ApiStandardErrors('asset.duplicate', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: AmenityCreateDto,
  ): Promise<AmenityDto> {
    return amenityDto(await this.amenities.create(ctx, unitId, body));
  }

  @Patch('asset-items/:assetItemId')
  @TenantScoped()
  @Can('asset_item.manage')
  @ApiEndpoint({
    id: 'owner.assetItems.update',
    summary: 'Update an appliance or furniture',
    description: 'Category, name, location or warranty of a unit asset item.',
    implements: ['D-151'],
  })
  @ApiJsonBody(AmenityUpdateDto, { location: 'ห้องครัว' })
  @ApiSuccess(200, { description: 'Updated', type: AmenityDto, example: AMENITY_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('assetItemId', ParseUUIDPipe) id: string,
    @Body() body: AmenityUpdateDto,
  ): Promise<AmenityDto> {
    return amenityDto(await this.amenities.update(ctx, id, body));
  }

  @Post('asset-items/:assetItemId/actions/retire')
  @HttpCode(204)
  @TenantScoped()
  @Can('asset_item.manage')
  @ApiEndpoint({
    id: 'owner.assetItems.retire',
    summary: 'Retire an appliance or furniture',
    description: 'The item leaves the unit; it stays in inspection history.',
    implements: ['D-151'],
  })
  @ApiJsonBody(AmenityRetireDto, { retiredReason: 'ชำรุด เปลี่ยนเครื่องใหม่' })
  @ApiSuccess(204, { description: 'Retired' })
  @ApiStandardErrors(...WRITE)
  async retire(
    @CurrentTenant() ctx: TenantContext,
    @Param('assetItemId', ParseUUIDPipe) id: string,
    @Body() body: AmenityRetireDto,
  ): Promise<void> {
    await this.amenities.retire(ctx, id, body.retiredReason);
  }
}

// ------------------------------------------------------------------------------------------- Excel

@ApiTags('owner.unitImports')
@ApiSurface(SURFACES.owner)
@Controller('owner/buildings/:buildingId')
export class OwnerUnitImportsController {
  constructor(private readonly imports: UnitImportService) {}

  @Get('unit-imports/template')
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.unitImports.template',
    summary: 'Download the unit import template',
    description:
      'An xlsx with the `units` sheet (columns unit_no, floor_level, type, area_sqm, base_rent, unit_profile, notes) and Thai instructions (Phase 1 "import from Excel", D-014).',
    implements: ['D-014'],
  })
  @ApiXlsx('The template workbook')
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async template(
    @CurrentTenant() _ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) _buildingId: string,
    @Res() res: Response,
  ): Promise<void> {
    xlsx(res, 'getproperty-units-template.xlsx', await this.imports.template());
  }

  @Post('unit-imports/actions/preview')
  @HttpCode(200)
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.unitImports.preview',
    summary: 'Validate an Excel file and preview the import',
    description:
      'Reads an uploaded xlsx (`files/presign` kind `other`), validates every row and column, and returns what each row would do (create, update, unchanged, error), the floors that would be created and a `previewToken` for the commit (D-014).',
    implements: ['D-014'],
  })
  @ApiJsonBody(UnitImportPreviewRequestDto, { fileId: FAKE.uuid, createFloors: true })
  @ApiSuccess(200, { description: 'Preview', type: UnitImportPreviewDto, example: IMPORT_PREVIEW_EXAMPLE })
  @ApiStandardErrors(
    'import.file_invalid',
    'document.not_uploaded',
    'document.scan_pending',
    'document.infected',
    'document.type_not_allowed',
    ...WRITE,
  )
  async preview(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UnitImportPreviewRequestDto,
  ): Promise<UnitImportPreviewDto> {
    return importPreviewDto(await this.imports.preview(ctx, buildingId, body));
  }

  @Post('unit-imports/actions/commit')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.unitImports.commit',
    summary: 'Import the previewed units',
    description:
      'Parses the same file again and writes the plan in one transaction when it still matches the preview (409 `import.preview_stale` otherwise); refuses files with row errors (422 `import.invalid_rows`). Audited (`unit.imported`).',
    implements: ['D-014'],
  })
  @ApiJsonBody(UnitImportCommitDto, {
    fileId: FAKE.uuid,
    createFloors: true,
    previewToken: 'q8u2ZJ6a0y1mXo5t4Vb3wNfLkR7sGh9cD2eP0iUaQx8',
  })
  @ApiSuccess(200, { description: 'Imported', type: UnitImportPreviewDto, example: IMPORT_PREVIEW_EXAMPLE })
  @ApiStandardErrors(
    'import.file_invalid',
    'import.invalid_rows',
    'import.preview_stale',
    'document.not_uploaded',
    'document.scan_pending',
    'document.infected',
    'document.type_not_allowed',
    ...WRITE,
  )
  async commit(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UnitImportCommitDto,
  ): Promise<UnitImportPreviewDto> {
    return importPreviewDto(await this.imports.commit(ctx, buildingId, body));
  }

  @Get('units/export')
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.unitImports.export',
    summary: 'Export the units of a building to Excel',
    description: 'The units in the import columns, so the file can be edited and imported again (D-014).',
    implements: ['D-014'],
  })
  @ApiXlsx('The units workbook')
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async export(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { building, body } = await this.imports.export(ctx, buildingId);
    xlsx(res, `units-${building.code}.xlsx`, body);
  }
}
