import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { MetersService } from '@modules/ops-units/meters-items.service';
import { METER_DRIVERS } from '@modules/smart-devices/driver-catalogue';
import { StaffFieldService } from '@modules/smart-devices/staff-field.service';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type UnitStatusName, type UnitTypeName, type UtilityName } from '../owner/assets.dto';
import { METER_EXAMPLE, meterDto } from '../owner/assets.mappers';
import { BusTypeName } from '../shared/smart.dto';
import { ApiSurface, SURFACES } from '../surfaces';
import { MeterDriversDto, StaffBuildingsDto, StaffMeterPointsDto, StaffUnitsDto } from './staff.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

/**
 * Field views of the staff PWA (web contract requests, D-203): the building switcher, the meter points of a building
 * for the binding wizard and swaps, and the edge driver catalogue (D-013). Staff limited to buildings see only
 * theirs (D-090); another tenant's building is a 404.
 */
@ApiTags('staff.field')
@ApiSurface(SURFACES.staff)
@Controller('staff')
export class StaffFieldController {
  constructor(
    private readonly field: StaffFieldService,
    private readonly meters: MetersService,
  ) {}

  @Get('buildings')
  @TenantScoped()
  @Can('property.read')
  @ApiEndpoint({
    id: 'staff.field.buildings',
    summary: 'Buildings of my scope',
    description:
      'The buildings this tenant owns or operates that I may work in — all of them, or only my buildings when my membership is limited (D-090) — with code, name, floors and unit count. Feeds the staff PWA’s building switcher.',
    implements: ['D-090', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Buildings',
    type: StaffBuildingsDto,
    example: { data: [{ id: FAKE.buildingId, code: 'A', name: 'อาคาร A', floorsCount: 6, unitCount: 60 }] },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async buildings(@CurrentTenant() ctx: TenantContext): Promise<StaffBuildingsDto> {
    return { data: await this.field.buildings(ctx) };
  }

  @Get('buildings/:buildingId/units')
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'staff.field.units',
    summary: 'Units of a building',
    description:
      'Every unit of a building of my scope (D-090) with its floor and status, by floor level then unit number — for the parcel intake and other unit pickers of the staff PWA (web F4 4.4, D-218). Another tenant’s building or one outside my limit is a 404.',
    implements: ['D-090', 'D-218'],
  })
  @ApiSuccess(200, {
    description: 'Units',
    type: StaffUnitsDto,
    example: {
      data: [
        {
          id: FAKE.uuid,
          unitNo: FAKE.unitCode,
          floorId: FAKE.uuid,
          floorName: 'ชั้น 2',
          floorLevel: 2,
          status: 'occupied',
          type: 'room',
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async units(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<StaffUnitsDto> {
    return {
      data: (await this.field.units(ctx, buildingId)).map((u) => ({
        ...u,
        status: u.status as UnitStatusName,
        type: u.type as UnitTypeName,
      })),
    };
  }

  @Get('buildings/:buildingId/meters')
  @TenantScoped()
  @Can('asset_item.read')
  @ApiEndpoint({
    id: 'staff.field.meterPoints',
    summary: 'Meter points of a building',
    description:
      'Active meter assignments of the building (unit, common-area and main meters, D-012) with the floor, the last accepted register (estimates excluded, D-030) and the open gateway channel when the meter is read by IoT (bus, address / pin, driver, meter device) — for the binding wizard, swaps and the per-unit device list (D-033).',
    implements: ['D-012', 'D-033', 'D-090', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Meter points',
    type: StaffMeterPointsDto,
    example: {
      data: [
        {
          ...METER_EXAMPLE,
          floorName: 'ชั้น 2',
          lastRegister: '12345.678',
          channel: {
            channelId: FAKE.uuid,
            gatewayDeviceId: FAKE.gatewayId,
            meterDeviceId: FAKE.uuid,
            meterDeviceSerial: 'SDM120-0042',
            busId: 'rs485-1',
            busType: 'modbus_rtu',
            address: 11,
            pin: null,
            driver: 'eastron_sdm120',
          },
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async meterPoints(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<StaffMeterPointsDto> {
    const points = await this.field.meterPoints(ctx, buildingId);
    const status = await this.meters.status(
      ctx,
      points.map((p) => p.meter.assetItemId),
    );
    return {
      data: points.map((p) => ({
        ...meterDto(p.meter, status.get(p.meter.assetItemId)),
        floorName: p.floorName,
        lastRegister: p.lastRegister,
        channel: p.channel ? { ...p.channel, busType: p.channel.busType as BusTypeName } : null,
      })),
    };
  }

  @Get('meter-drivers')
  @TenantScoped()
  @Can('device.read')
  @ApiEndpoint({
    id: 'staff.field.meterDrivers',
    summary: 'Meter drivers of the gateway agent',
    description:
      'The getproperty-edge driver catalogue (D-013): driver key, bus type, vendor, the meter models it reads and the utility. A new meter model is a new driver of the agent, never an API change; a device from the inventory keeps its own driver.',
    implements: ['D-013', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Drivers',
    type: MeterDriversDto,
    example: {
      data: [
        {
          key: 'eastron_sdm120',
          busType: 'modbus_rtu',
          vendor: 'Eastron',
          models: ['SDM120-Modbus'],
          utility: 'electric',
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  drivers(): MeterDriversDto {
    return {
      data: METER_DRIVERS.map((d) => ({
        key: d.key,
        busType: d.busType as BusTypeName,
        vendor: d.vendor,
        models: [...d.models],
        utility: d.utility as UtilityName,
      })),
    };
  }
}
