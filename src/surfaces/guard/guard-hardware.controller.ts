import { Can } from '@common/auth/can.decorator';
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
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { GateHwStateName, VisitActorKindName } from '../shared/gate.dto';
import {
  DETECTION_EXAMPLE,
  GateHardwareKindName,
  GateOpenResultDto,
  GuardGateOpenDto,
  GuardHardwareDto,
  GuardIncidentCreateDto,
  GuardIncidentDetailDto,
  GuardIncidentQuery,
  GuardOpenReasonName,
  INCIDENT_EXAMPLE,
  IncidentDecisionDto,
  IncidentDto,
  IncidentEventKindName,
  IncidentKindName,
  IncidentSourceName,
  IncidentStateName,
  OPEN_RESULT_EXAMPLE,
  PlateDetectionDto,
  PlateDetectionQuery,
  PlateDetectionStateName,
} from '../shared/gate-hardware.dto';
import {
  detectionDto,
  hardwareDto,
  incidentDto,
  incidentEventDto,
  openResultDto,
} from '../shared/gate-hardware.mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const GUARD_INCIDENT_DETAIL: GuardIncidentDetailDto = {
  ...INCIDENT_EXAMPLE,
  events: [
    {
      id: FAKE.uuid,
      kind: IncidentEventKindName.Raised,
      actorKind: VisitActorKindName.Resident,
      occurredAt: FAKE.dateTime,
    },
  ],
};

/**
 * `/v1/guard/*` J4.2 (D-316, D-317, D-328): the barrier of the gate of the shift, LPR reads waiting for the guard,
 * the barrier / camera state, and the estate's SOS / incidents (the tablet's takeover banner).
 */
@ApiTags('guard.gate')
@ApiSurface(SURFACES.guard)
@Controller('guard')
export class GuardHardwareController {
  constructor(
    private readonly hardware: GateHardwareService,
    private readonly incidents: IncidentsService,
  ) {}

  @Post('gates/:gateId/actions/open')
  @HttpCode(202)
  @ApiAsync({ poll: 'guard.hardware.list' })
  @Idempotent({ optional: true })
  @Can('gate.open')
  @ApiEndpoint({
    id: 'guard.gates.open',
    summary: 'Open the barrier',
    description:
      'Sends `gate.open` (device protocol 1.3) to every live barrier of **the gate of this shift** (another gate = 404) with the reason (`other` needs a note) and optionally the visit it opens for (visit timeline `gate_opened`). The command is sent once and refused by the edge after 30 s; at most one open per gate every `gate.open.min_interval_seconds` (3) — 429 with Retry-After. Audited (D-316, D-328).',
    implements: ['D-316', 'D-328'],
  })
  @ApiJsonBody(GuardGateOpenDto, { reason: GuardOpenReasonName.Visit, visitId: FAKE.uuid })
  @ApiSuccess(202, {
    description: 'Sent to the barrier',
    type: GateOpenResultDto,
    example: OPEN_RESULT_EXAMPLE,
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'auth.forbidden',
    'gate.inactive',
    'gate.no_barrier',
    'gate.open_rate_limited',
  )
  async open(
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Body() body: GuardGateOpenDto,
  ): Promise<GateOpenResultDto> {
    return openResultDto(await this.hardware.guardOpen(gateId, body));
  }

  @Get('hardware')
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.hardware.list',
    summary: 'Barrier and camera of my gate',
    description:
      'Live barriers and LPR cameras of the gate of this shift with the last reported barrier position (`gate.state`) — the tablet header (D-328).',
    implements: ['D-328'],
  })
  @ApiSuccess(200, {
    description: 'Hardware',
    type: [GuardHardwareDto],
    example: [
      {
        id: FAKE.uuid,
        kind: GateHardwareKindName.Barrier,
        name: 'ไม้กั้นขาเข้า',
        hwState: GateHwStateName.Closed,
        hwStateAt: FAKE.dateTime,
        lastSeenAt: FAKE.dateTime,
      },
    ],
  })
  @ApiStandardErrors('auth.forbidden')
  async hardwareList(): Promise<GuardHardwareDto[]> {
    return (await this.hardware.guardHardware()).map(hardwareDto);
  }

  @Get('plate-detections')
  @Can('gate.open')
  @ApiEndpoint({
    id: 'guard.plateDetections.list',
    summary: 'Plate reads at my gate',
    description:
      '`pending` (default): unknown, blacklisted, ambiguous or low-confidence reads of the LPR camera waiting to pre-fill the visit form (`gate.lpr.pending_minutes`, 10); `recent`: every read of the last hour, incl. known plates that entered by themselves. Fetch on `gate.plate_detected` stream events (D-328).',
    implements: ['D-316', 'D-328'],
  })
  @ApiSuccess(200, { description: 'Reads', type: [PlateDetectionDto], example: [DETECTION_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden')
  async detections(@Query() q: PlateDetectionQuery): Promise<PlateDetectionDto[]> {
    return (await this.hardware.guardDetections(q.view ?? 'pending')).map(detectionDto);
  }

  @Post('plate-detections/:detectionId/actions/claim')
  @HttpCode(200)
  @Can('gate.open')
  @ApiEndpoint({
    id: 'guard.plateDetections.claim',
    summary: 'Use a plate read for a visit',
    description:
      'The first guard takes a pending read to pre-fill the visit form (plate, the matched unit if any); another tablet then gets 409 `plate_detection.invalid_state`, as does an expired read (D-328).',
    implements: ['D-328'],
  })
  @ApiSuccess(200, {
    description: 'Claimed',
    type: PlateDetectionDto,
    example: { ...DETECTION_EXAMPLE, state: PlateDetectionStateName.Claimed },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', 'plate_detection.invalid_state')
  async claim(@Param('detectionId', ParseUUIDPipe) id: string): Promise<PlateDetectionDto> {
    return detectionDto(await this.hardware.guardDecideDetection(id, 'claim'));
  }

  @Post('plate-detections/:detectionId/actions/dismiss')
  @HttpCode(200)
  @Can('gate.open')
  @ApiEndpoint({
    id: 'guard.plateDetections.dismiss',
    summary: 'Dismiss a plate read',
    description: 'A pending read that needs no visit (a passing car, a misread) leaves the list (D-328).',
    implements: ['D-328'],
  })
  @ApiSuccess(200, {
    description: 'Dismissed',
    type: PlateDetectionDto,
    example: { ...DETECTION_EXAMPLE, state: PlateDetectionStateName.Dismissed },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', 'plate_detection.invalid_state')
  async dismiss(@Param('detectionId', ParseUUIDPipe) id: string): Promise<PlateDetectionDto> {
    return detectionDto(await this.hardware.guardDecideDetection(id, 'dismiss'));
  }

  @Get('incidents')
  @Can('gate.incident.respond')
  @ApiEndpoint({
    id: 'guard.incidents.list',
    summary: 'SOS and incidents of my estate',
    description:
      '`active` (default): open and acknowledged incidents of the estate — the tablet shows the takeover banner while any is open (fetch on connect and on `gate.incident.*` stream events); `recent`: the last 24 h (D-317, D-328).',
    implements: ['D-317', 'D-328'],
  })
  @ApiSuccess(200, { description: 'Incidents', type: [IncidentDto], example: [INCIDENT_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden')
  async incidentList(@Query() q: GuardIncidentQuery): Promise<IncidentDto[]> {
    return (await this.incidents.guardList(q.view ?? 'active')).map(incidentDto);
  }

  @Post('incidents')
  @Idempotent()
  @Can('gate.incident.respond')
  @ApiEndpoint({
    id: 'guard.incidents.create',
    summary: 'Raise an SOS from the gate',
    description:
      'The tablet’s SOS button: an incident of the estate (source `guard`, optionally the house) — every gate, the office and the committee are alerted at once (D-317, D-328).',
    implements: ['D-317', 'D-328'],
  })
  @ApiJsonBody(GuardIncidentCreateDto, {
    kind: IncidentKindName.Intrusion,
    note: 'มีคนปีนรั้วด้านหลังโครงการ',
  })
  @ApiSuccess(201, {
    description: 'Raised',
    type: IncidentDto,
    example: {
      ...INCIDENT_EXAMPLE,
      source: IncidentSourceName.Guard,
      unit: null,
      gate: { id: FAKE.uuid, name: 'ป้อมหน้า' },
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden')
  async raise(@Body() body: GuardIncidentCreateDto): Promise<IncidentDto> {
    return incidentDto(await this.incidents.guardRaise(body));
  }

  @Get('incidents/:incidentId')
  @Can('gate.incident.respond')
  @ApiEndpoint({
    id: 'guard.incidents.get',
    summary: 'An incident of my estate',
    description:
      'The incident (house, kind, note) and its timeline; another estate’s incident is a 404 (D-317).',
    implements: ['D-317', 'D-328'],
  })
  @ApiSuccess(200, { description: 'Incident', type: GuardIncidentDetailDto, example: GUARD_INCIDENT_DETAIL })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden')
  async incidentGet(@Param('incidentId', ParseUUIDPipe) id: string): Promise<GuardIncidentDetailDto> {
    const r = await this.incidents.guardGet(id);
    return { ...incidentDto(r.incident), events: r.events.map(incidentEventDto) };
  }

  @Post('incidents/:incidentId/actions/acknowledge')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @Can('gate.incident.respond')
  @ApiEndpoint({
    id: 'guard.incidents.acknowledge',
    summary: 'Acknowledge an incident',
    description:
      'The guard has it: `open` → `acknowledged` (idempotent); the resident who sent the SOS is told at once (LINE, urgent) (D-317).',
    implements: ['D-317', 'D-328'],
  })
  @ApiJsonBody(IncidentDecisionDto, { note: 'กำลังไป' })
  @ApiSuccess(200, {
    description: 'Acknowledged',
    type: IncidentDto,
    example: { ...INCIDENT_EXAMPLE, state: IncidentStateName.Acknowledged, acknowledgedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', 'incident.invalid_state')
  async acknowledge(
    @Param('incidentId', ParseUUIDPipe) id: string,
    @Body() body: IncidentDecisionDto,
  ): Promise<IncidentDto> {
    return incidentDto(await this.incidents.guardDecide(id, 'acknowledge', body.note));
  }

  @Post('incidents/:incidentId/actions/resolve')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @Can('gate.incident.respond')
  @ApiEndpoint({
    id: 'guard.incidents.resolve',
    summary: 'Resolve an incident',
    description:
      '`open` | `acknowledged` → `resolved` with an optional note (idempotent once resolved) (D-317).',
    implements: ['D-317', 'D-328'],
  })
  @ApiJsonBody(IncidentDecisionDto, { note: 'รถพยาบาลรับผู้ป่วยแล้ว' })
  @ApiSuccess(200, {
    description: 'Resolved',
    type: IncidentDto,
    example: {
      ...INCIDENT_EXAMPLE,
      state: IncidentStateName.Resolved,
      acknowledgedAt: FAKE.dateTime,
      resolvedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', 'incident.invalid_state')
  async resolve(
    @Param('incidentId', ParseUUIDPipe) id: string,
    @Body() body: IncidentDecisionDto,
  ): Promise<IncidentDto> {
    return incidentDto(await this.incidents.guardDecide(id, 'resolve', body.note));
  }
}
