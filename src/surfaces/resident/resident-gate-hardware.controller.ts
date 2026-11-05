import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiAsync,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { GateHardwareService } from '@modules/smart-gate/gate-hardware.service';
import { IncidentsService } from '@modules/smart-gate/incidents.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { GateKindName, PLATE_EXAMPLE } from '../shared/gate.dto';
import {
  GateOpenResultDto,
  INCIDENT_EXAMPLE,
  IncidentKindName,
  IncidentStateName,
  OPEN_RESULT_EXAMPLE,
  RESIDENT_VEHICLE_EXAMPLE,
  ResidentGateOpenDto,
  ResidentIncidentDto,
  ResidentOpenableGateDto,
  ResidentVehicleCreateDto,
  ResidentVehicleDto,
  SosCancelDto,
  SosCreatedDto,
  SosCreateDto,
  SosListQuery,
} from '../shared/gate-hardware.dto';
import { incidentDto, openResultDto, residentVehicleDto } from '../shared/gate-hardware.mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const RESIDENT_INCIDENT_EXAMPLE: ResidentIncidentDto = {
  ...INCIDENT_EXAMPLE,
  cancellableUntil: '2026-11-05T18:00:30+07:00',
};

/** `/v1/resident/gates*` (J4.2, D-316, D-328): open the barrier from LINE for a registered car of my house. */
@ApiTags('resident.gate')
@ApiSurface(SURFACES.resident)
@Controller('resident/gates')
export class ResidentGatesController {
  constructor(private readonly hardware: GateHardwareService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.gates.list',
    summary: 'Gates I can open',
    description:
      'Gates with a barrier of the estates of my units (gate roles co-owner, tenant, co-tenant, family), whether the estate lets residents open them (`gate.resident_open.enabled`), whether the phone location is needed, and the registered cars of my units there (D-316, D-328).',
    implements: ['D-316', 'D-328'],
  })
  @ApiSuccess(200, {
    description: 'Gates',
    type: [ResidentOpenableGateDto],
    example: [
      {
        gateId: FAKE.uuid,
        name: 'ป้อมหน้า',
        kind: GateKindName.Main,
        propertyId: FAKE.propertyId,
        propertyName: 'หมู่บ้านตัวอย่าง',
        enabled: true,
        requireGeofence: false,
        vehicles: [RESIDENT_VEHICLE_EXAMPLE],
      },
    ],
  })
  @ApiStandardErrors('auth.forbidden')
  async list(): Promise<ResidentOpenableGateDto[]> {
    return (await this.hardware.residentGates()).map((g) => ({
      gateId: g.gate.id,
      name: g.gate.name,
      kind: g.gate.kind as GateKindName,
      propertyId: g.gate.propertyId,
      propertyName: g.propertyName,
      enabled: g.enabled,
      requireGeofence: g.requireGeofence,
      vehicles: g.vehicles.map(residentVehicleDto),
    }));
  }

  @Post(':gateId/actions/open')
  @HttpCode(202)
  @ApiAsync({ poll: null })
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.gates.open',
    summary: 'Open the barrier for my car',
    description:
      'Only for a registered car of a unit I hold a gate role on today, at a gate of that estate (anything else 404). Refused while `gate.resident_open.enabled` is off (403); while `gate.resident_open.require_geofence` is on the phone location must be within `gate.resident_open.radius_m` of the estate (403 `gate.outside_geofence`; 409 when the estate has no location) — the location is checked and never stored, only the decision is audited. At most one open per gate every 3 s and `gate.resident_open.max_per_hour` per login (429) (D-316, D-328).',
    implements: ['D-316', 'D-328'],
  })
  @ApiJsonBody(ResidentGateOpenDto, {
    vehicleId: FAKE.uuid,
    location: { lat: 13.6905, lng: 100.6851, accuracyM: 20 },
  })
  @ApiSuccess(202, {
    description: 'Sent to the barrier',
    type: GateOpenResultDto,
    example: OPEN_RESULT_EXAMPLE,
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'gate.no_barrier',
    'gate.open_rate_limited',
    'gate.resident_open_disabled',
    'gate.outside_geofence',
    'gate.geofence_unavailable',
  )
  async open(
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Body() body: ResidentGateOpenDto,
  ): Promise<GateOpenResultDto> {
    return openResultDto(await this.hardware.residentOpen(gateId, body));
  }
}

/** `/v1/resident/units/{unitId}/vehicles*` (J4.2, D-328): the cars of my house (no expiry). */
@ApiTags('resident.gate')
@ApiSurface(SURFACES.resident)
@Controller('resident/units/:unitId/vehicles')
export class ResidentUnitVehiclesController {
  constructor(private readonly hardware: GateHardwareService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.unitVehicles.list',
    summary: 'Cars of my house',
    description:
      'The registered cars of the unit (every gate role reads; another unit = 404). They enter by LPR and may open the barrier from LINE (D-328).',
    implements: ['D-316', 'D-328'],
  })
  @ApiSuccess(200, { description: 'Cars', type: [ResidentVehicleDto], example: [RESIDENT_VEHICLE_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async list(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<ResidentVehicleDto[]> {
    return (await this.hardware.residentVehicles(unitId)).map(residentVehicleDto);
  }

  @Post()
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.unitVehicles.create',
    summary: 'Register a car of my house',
    description:
      'The household (co-owner, tenant, co-tenant — not family) registers a car by its full plate (409 when already registered). It is removed automatically when the person who registered it no longer holds a role on the unit (D-328).',
    implements: ['D-316', 'D-328'],
  })
  @ApiJsonBody(ResidentVehicleCreateDto, { plate: PLATE_EXAMPLE, label: 'รถคุณแม่' })
  @ApiSuccess(201, { description: 'Registered', type: ResidentVehicleDto, example: RESIDENT_VEHICLE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'http.conflict')
  async create(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: ResidentVehicleCreateDto,
  ): Promise<ResidentVehicleDto> {
    return residentVehicleDto(await this.hardware.addResidentVehicle(unitId, body));
  }

  @Delete(':vehicleId')
  @HttpCode(204)
  @ApiEndpoint({
    id: 'resident.unitVehicles.delete',
    summary: 'Remove a car of my house',
    description: 'The household removes a registered car (idempotent) (D-328).',
    implements: ['D-328'],
  })
  @ApiSuccess(204, { description: 'Removed' })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async remove(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
  ): Promise<void> {
    await this.hardware.removeResidentVehicle(unitId, vehicleId);
  }
}

/** `/v1/resident/sos*` (J4.2, D-317, D-328): the SOS button of the LIFF. */
@ApiTags('resident.gate')
@ApiSurface(SURFACES.resident)
@Controller('resident/sos')
export class ResidentSosController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post()
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.sos.create',
    summary: 'Send an SOS',
    description:
      'An emergency at my house (gate roles of the unit; another unit = 404): every gate of the estate, the office (owner, manager, staff) and the committee are alerted at once (urgent). An open SOS of the same unit by me is returned instead of a second one (`existing: true`); more than `gate.sos.max_per_hour` in an hour → 429. I may cancel within `gate.sos.cancel_seconds` (30). The incident links the visits inside the estate at that time (D-317, D-328).',
    implements: ['D-317', 'D-328'],
  })
  @ApiJsonBody(SosCreateDto, { unitId: FAKE.uuid, kind: IncidentKindName.Medical, note: 'คุณพ่อหมดสติ' })
  @ApiSuccess(201, {
    description: 'Raised (or the open one)',
    type: SosCreatedDto,
    example: { ...RESIDENT_INCIDENT_EXAMPLE, existing: false },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'incident.rate_limited')
  async create(@Body() body: SosCreateDto): Promise<SosCreatedDto> {
    const r = await this.incidents.residentRaise(body);
    return { ...incidentDto(r.incident), cancellableUntil: r.cancellableUntil, existing: r.existing };
  }

  @Get()
  @ApiEndpoint({
    id: 'resident.sos.list',
    summary: 'SOS of my houses',
    description: 'Incidents of the units I hold a gate role on (or one `unitId`), newest first (D-317).',
    implements: ['D-317', 'D-328'],
  })
  @ApiSuccess(200, {
    description: 'Incidents',
    type: [ResidentIncidentDto],
    example: [RESIDENT_INCIDENT_EXAMPLE],
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async list(@Query() q: SosListQuery): Promise<ResidentIncidentDto[]> {
    return (await this.incidents.residentList(q.unitId)).map((i) => ({
      ...incidentDto(i),
      cancellableUntil: null,
    }));
  }

  @Get(':incidentId')
  @ApiEndpoint({
    id: 'resident.sos.get',
    summary: 'My SOS',
    description:
      'Its status: `open` (alerted), `acknowledged` (a guard or the office has it, with the time), `resolved`, `cancelled`; `cancellableUntil` while I may still cancel (D-317, D-328).',
    implements: ['D-317', 'D-328'],
  })
  @ApiSuccess(200, { description: 'Incident', type: ResidentIncidentDto, example: RESIDENT_INCIDENT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('incidentId', ParseUUIDPipe) id: string): Promise<ResidentIncidentDto> {
    const r = await this.incidents.residentGet(id);
    return { ...incidentDto(r.incident), cancellableUntil: r.cancellableUntil };
  }

  @Post(':incidentId/actions/cancel')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.sos.cancel',
    summary: 'Cancel my SOS',
    description:
      'Only the resident who sent it, within `gate.sos.cancel_seconds` (30) — afterwards 409 `incident.cancel_window_passed` (call the gate). Idempotent (D-328).',
    implements: ['D-317', 'D-328'],
  })
  @ApiJsonBody(SosCancelDto, { reason: 'กดผิด' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: ResidentIncidentDto,
    example: {
      ...RESIDENT_INCIDENT_EXAMPLE,
      state: IncidentStateName.Cancelled,
      cancelledAt: FAKE.dateTime,
      cancellableUntil: null,
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'incident.invalid_state',
    'incident.cancel_window_passed',
  )
  async cancel(
    @Param('incidentId', ParseUUIDPipe) id: string,
    @Body() body: SosCancelDto,
  ): Promise<ResidentIncidentDto> {
    return { ...incidentDto(await this.incidents.residentCancel(id, body.reason)), cancellableUntil: null };
  }
}
