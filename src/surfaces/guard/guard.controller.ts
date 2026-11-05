import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { RealtimeHub } from '@core/realtime/realtime.hub';
import { GuardAuthService } from '@modules/smart-gate/guard-auth.service';
import { guardContext, VisitsService } from '@modules/smart-gate/visits.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiHeader, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { map, Observable } from 'rxjs';

import {
  GUARD_VISIT_EXAMPLE,
  GuardEventsQuery,
  GuardMeDto,
  GuardUnitDto,
  GuardUnitsQuery,
  GuardVisitDetailDto,
  GuardVisitDto,
  GuardVisitListQuery,
  GuardVisitViewName,
  InviteScanDto,
  NOTICE_EXAMPLE,
  PLATE_EXAMPLE,
  POLICY_EXAMPLE,
  PrivacyNoticeDto,
  VisitChangeDto,
  VisitChangesQuery,
  VisitCreatedDto,
  VisitCreateDto,
  type VisitEventKindName,
  VisitKindName,
  VisitPhotoDto,
  VisitPhotoMimeName,
  VisitReasonDto,
} from '../shared/gate.dto';
import { guardVisitDto, policyDto, visitEventDto } from '../shared/gate.mappers';
import { iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const STATE_ERRORS = ['visit.invalid_state', 'visit.denied', 'visit.awaiting_answer'] as const;

const SSE_EXAMPLE =
  'id: 3b241101-e2bb-4255-8caf-4136c566a962\nevent: gate.visit.answered\ndata: {"type":"gate.visit.answered","ids":{"visitId":"3b241101-e2bb-4255-8caf-4136c566a962","visitEventId":"3b241101-e2bb-4255-8caf-4136c566a962"}}\n\n';

/**
 * `/v1/guard/*` (J4.1, D-315, D-320, D-327): the gate tablet of one shift — the tenant, property, gate and shift
 * come from the token, never from the request. Every visit change answers the visit as the gate sees it (plate,
 * name, ID last 4 digits).
 */
@ApiTags('guard.gate')
@ApiSurface(SURFACES.guard)
@Controller('guard')
export class GuardGateController {
  constructor(
    private readonly visits: VisitsService,
    private readonly auth: GuardAuthService,
    private readonly hub: RealtimeHub,
  ) {}

  @Get('me')
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.me.get',
    summary: 'My shift at the gate',
    description:
      'The signed-in guard, the gate and property of the shift, the tablet, and the privacy notice to show next to the visitor fields (`gate.privacy_notice`, PDPA, D-315).',
    implements: ['D-315', 'D-320', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Shift',
    type: GuardMeDto,
    example: {
      shiftId: FAKE.uuid,
      startedAt: FAKE.dateTime,
      guardId: FAKE.uuid,
      guardName: 'สมศักดิ์',
      gateId: FAKE.uuid,
      gateName: 'ป้อมหน้า',
      propertyId: FAKE.propertyId,
      propertyName: 'หมู่บ้านตัวอย่าง',
      gateDeviceId: FAKE.uuid,
      gateDeviceName: 'แท็บเล็ตป้อมหน้า',
      privacyNotice: NOTICE_EXAMPLE,
    } satisfies GuardMeDto,
  })
  @ApiStandardErrors('http.not_found', 'auth.forbidden')
  async me(): Promise<GuardMeDto> {
    const s = await this.visits.guardMe();
    return {
      shiftId: s.id,
      startedAt: iso(s.startedAt),
      guardId: s.guardId,
      guardName: s.guard.displayName,
      gateId: s.gateId,
      gateName: s.gate.name,
      propertyId: s.gate.propertyId,
      propertyName: s.gate.property.name,
      gateDeviceId: s.gateDeviceId,
      gateDeviceName: s.gateDevice.name,
      privacyNotice: await this.visits.privacyNotice(s.tenantId),
    };
  }

  @Post('shift/actions/end')
  @HttpCode(204)
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.shift.end',
    summary: 'End my shift',
    description:
      'Signs the guard out: the shift ends and its session (refresh family) is revoked at once; the tablet stays enrolled for the next guard (D-320).',
    implements: ['D-320', 'D-327'],
  })
  @ApiSuccess(204, { description: 'Signed out' })
  @ApiStandardErrors('auth.forbidden')
  async endShift(): Promise<void> {
    await this.auth.endOwnShift(guardContext().shiftId);
  }

  @Get('privacy-notice')
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.privacyNotice.get',
    summary: 'Privacy notice for the gate screen',
    description:
      'The purpose notice the gate shows wherever a visitor’s data is captured (`gate.privacy_notice`, th / en with version; ⚖ draft wording, PDPA D-025, D-315).',
    implements: ['D-025', 'D-315'],
  })
  @ApiSuccess(200, { description: 'Notice', type: PrivacyNoticeDto, example: NOTICE_EXAMPLE })
  @ApiStandardErrors('auth.forbidden')
  privacyNotice(): Promise<PrivacyNoticeDto> {
    return this.visits.privacyNotice(guardContext().tenantId);
  }

  @Get('units')
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.units.list',
    summary: 'Find a destination unit',
    description:
      'Units of the gate’s property by number (`q`), with whether anyone of the house can be asked in LINE (no names) and the house policy. `hasArrears` appears only while `gate.show_arrears` is on (⚖ O-038, off by default) — otherwise no arrears data at all (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Units',
    type: [GuardUnitDto],
    example: [
      {
        unitId: FAKE.uuid,
        unitNo: '88/12',
        buildingId: FAKE.buildingId,
        buildingName: 'โซน A',
        lineLinked: true,
        policy: POLICY_EXAMPLE,
      },
    ],
  })
  @ApiStandardErrors('validation.failed', 'auth.forbidden')
  async units(@Query() q: GuardUnitsQuery): Promise<GuardUnitDto[]> {
    const rows = await this.visits.guardUnits(q.q, q.limit ?? 20);
    return rows.map((r) => ({ ...r, policy: policyDto(r.policy) }));
  }

  @Post('visits')
  @Idempotent()
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.create',
    summary: 'Record a visit',
    description:
      'Records a visitor at the gate: kind, destination unit, plate (Thai category + number + province), optional name, optional **last 4 ID digits** (exactly 4, never more). The outcome is decided at once: a blacklisted plate is `denied`; a remembered car of the unit or a delivery to an estate with a drop point is `entered` (residents notified only); a unit nobody can be asked about gets its house policy at once (`timed_out`); otherwise `requested` — every resident of the unit (co-owner, tenant, co-tenant, family; not payer-only) is asked in LINE and the house policy applies after its timeout. Offline queue: `clientRef` is generated by the tablet and a replay with the same `clientRef` returns the visit already recorded (`replayed: true`), never a duplicate; `recordedAt` / `enteredOffline` keep what happened offline (D-315, D-327).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(VisitCreateDto, {
    clientRef: FAKE.uuid,
    kind: VisitKindName.Guest,
    unitId: FAKE.uuid,
    plate: PLATE_EXAMPLE,
    visitorName: 'สมชาย',
    idLast4: '1234',
  })
  @ApiSuccess(201, {
    description: 'Recorded',
    type: VisitCreatedDto,
    example: { ...GUARD_VISIT_EXAMPLE, replayed: false },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'gate.inactive',
    'visit.offline_too_old',
    'auth.forbidden',
    'tenant.read_only',
  )
  async create(@Body() body: VisitCreateDto): Promise<VisitCreatedDto> {
    const r = await this.visits.create(body);
    return { ...guardVisitDto(r.visit), replayed: r.replayed };
  }

  @Get('visits')
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.list',
    summary: 'The gate lists',
    description:
      '`waiting` (requested, approved, timed out — last 24 h), `inside` (entered, no exit stamp yet) or `today` (everything since midnight Bangkok) at this gate, newest first (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Visits', type: [GuardVisitDto], example: [GUARD_VISIT_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden')
  async list(@Query() q: GuardVisitListQuery): Promise<GuardVisitDto[]> {
    return (await this.visits.guardList(q.view ?? GuardVisitViewName.Waiting, q.limit ?? 50)).map(
      guardVisitDto,
    );
  }

  @Get('visits/changes')
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.changes',
    summary: 'Visit changes since an event',
    description:
      'The JSON twin of `GET /v1/guard/events` for tablets that cannot stream or are catching up after being offline: visit events of this gate after `after` (last 24 h, at most 500, oldest first); refetch the visits named (D-327).',
    implements: ['D-327'],
  })
  @ApiSuccess(200, {
    description: 'Changes',
    type: [VisitChangeDto],
    example: [
      {
        id: FAKE.uuid,
        visitId: FAKE.uuid,
        kind: 'answered' as VisitEventKindName,
        occurredAt: FAKE.dateTime,
      },
    ],
  })
  @ApiStandardErrors('validation.failed', 'auth.forbidden')
  async changes(@Query() q: VisitChangesQuery): Promise<VisitChangeDto[]> {
    return (await this.visits.changes(q.after ?? null)).map((c) => ({
      id: c.id,
      visitId: c.visitId,
      kind: c.kind as VisitEventKindName,
      occurredAt: iso(c.occurredAt),
    }));
  }

  @Get('visits/:visitId')
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.get',
    summary: 'A visit at this gate',
    description:
      'The visit with its timeline, who asked to be called and a 5-minute photo link. A visit of another estate is a 404 (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Visit',
    type: GuardVisitDetailDto,
    example: { ...GUARD_VISIT_EXAMPLE, events: [], callBackName: null, photoUrl: null },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden')
  async get(@Param('visitId', ParseUUIDPipe) id: string): Promise<GuardVisitDetailDto> {
    const v = await this.visits.guardGet(id);
    return {
      ...guardVisitDto(v),
      events: v.events.map(visitEventDto),
      callBackName: v.callBack?.name ?? null,
      photoUrl: await this.visits.photoLink(guardContext().ctx, v.photoDocumentId),
    };
  }

  @Post('visits/:visitId/actions/enter')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.enter',
    summary: 'Stamp the entry',
    description:
      'The visitor goes in: allowed after an approval or a timeout with `allow_and_log` / `guard_calls`; refused after a denial or a `deny` timeout (`visit.denied`). While the house has not answered the guard may still let the visitor in with a `reason` (guard override, audited — D-315: never force every visit to wait). Repeating it is harmless.',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(VisitReasonDto, {})
  @ApiSuccess(200, {
    description: 'Entered',
    type: GuardVisitDto,
    example: { ...GUARD_VISIT_EXAMPLE, state: 'entered' },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'auth.forbidden',
    'tenant.read_only',
    ...STATE_ERRORS,
  )
  async enter(
    @Param('visitId', ParseUUIDPipe) id: string,
    @Body() body: VisitReasonDto,
  ): Promise<GuardVisitDto> {
    return guardVisitDto(await this.visits.enter(id, body.reason ?? null));
  }

  @Post('visits/:visitId/actions/exit')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.exit',
    summary: 'Stamp the exit',
    description: 'The visitor left (from `entered`); repeating it is harmless (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Exited',
    type: GuardVisitDto,
    example: { ...GUARD_VISIT_EXAMPLE, state: 'exited' },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'auth.forbidden',
    'tenant.read_only',
    'visit.invalid_state',
  )
  async exit(@Param('visitId', ParseUUIDPipe) id: string): Promise<GuardVisitDto> {
    return guardVisitDto(await this.visits.guardExit(id));
  }

  @Post('visits/:visitId/actions/cancel')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.cancel',
    summary: 'Cancel a visit',
    description: 'The visitor left before entering (requested, approved, timed out or denied) (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(VisitReasonDto, { reason: 'ผู้มาติดต่อกลับไปแล้ว' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: GuardVisitDto,
    example: { ...GUARD_VISIT_EXAMPLE, state: 'cancelled' },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'auth.forbidden',
    'tenant.read_only',
    'visit.invalid_state',
  )
  async cancel(
    @Param('visitId', ParseUUIDPipe) id: string,
    @Body() body: VisitReasonDto,
  ): Promise<GuardVisitDto> {
    return guardVisitDto(await this.visits.cancel(id, body.reason ?? null));
  }

  @Post('visits/:visitId/photo')
  @HttpCode(200)
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.visits.photo',
    summary: 'Attach the visit photo',
    description:
      'One photo per visit (JPEG / PNG / WebP, ≤ 2 MB decoded, inline base64), stored with retention class `visitor` and deleted with the visit after `gate.retention_days`; a new photo replaces the old one (deleted). Never an ID card image (D-315).',
    implements: ['D-025', 'D-315', 'D-327'],
  })
  @ApiJsonBody(VisitPhotoDto, { contentBase64: '/9j/4AAQSkZJRgABAQ', mimeType: VisitPhotoMimeName.Jpeg })
  @ApiSuccess(200, {
    description: 'Attached',
    type: GuardVisitDto,
    example: { ...GUARD_VISIT_EXAMPLE, hasPhoto: true },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'http.bad_request',
    'http.payload_too_large',
    'auth.forbidden',
    'visit.invalid_state',
  )
  async photo(
    @Param('visitId', ParseUUIDPipe) id: string,
    @Body() body: VisitPhotoDto,
  ): Promise<GuardVisitDto> {
    return guardVisitDto(await this.visits.addPhoto(id, body.contentBase64, body.mimeType));
  }

  @Post('invites/actions/scan')
  @Idempotent()
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.invites.scan',
    summary: 'Scan a visitor invite',
    description:
      'The QR of a resident’s invite: when it is active, inside its window and not used up, the visit is recorded `entered` at once (residents notified) and the use is counted. When the invite names a plate the car must match (`visit_invite.plate_mismatch`). Another estate’s or an unknown invite is a 404. `clientRef` replays like `POST /v1/guard/visits` (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(InviteScanDto, {
    token: 'gpv1.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5',
    clientRef: FAKE.uuid,
  })
  @ApiSuccess(201, {
    description: 'Entered',
    type: VisitCreatedDto,
    example: { ...GUARD_VISIT_EXAMPLE, state: 'entered', entryBasis: 'invite', replayed: false },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'auth.forbidden',
    'tenant.read_only',
    'visit.denied',
    'visit_invite.not_active',
    'visit_invite.outside_window',
    'visit_invite.used_up',
    'visit_invite.plate_mismatch',
  )
  async scan(@Body() body: InviteScanDto): Promise<VisitCreatedDto> {
    const r = await this.visits.scanInvite(body);
    return { ...guardVisitDto(r.visit), replayed: r.replayed };
  }

  @Get('events')
  @Sse()
  @Can('gate.visit.record')
  @ApiEndpoint({
    id: 'guard.events.stream',
    summary: 'Gate event stream (server-sent events)',
    description:
      'Server-sent events of this gate with the Bearer guard token (use a fetch-based EventSource that sends headers). On connect the visit events after `Last-Event-ID` (header) or `lastEventId` (query) are replayed (last 24 h, ≤ 500), then live events follow; every event carries `id:` = the visit event id, so a reconnect resumes without gaps. Events: `ready`, `heartbeat` every 25 s, `gate.visit.*` with `{ type, ids }` — refetch the visit (contract §6, D-327).',
    implements: ['D-315', 'D-327'],
  })
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'The last event id the client received.',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'Event stream',
    content: { 'text/event-stream': { schema: { type: 'string' }, example: SSE_EXAMPLE } },
  })
  @ApiStandardErrors('validation.failed', 'auth.forbidden')
  events(
    @Query() q: GuardEventsQuery,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    const g = guardContext();
    const after = q.lastEventId ?? (lastEventId && /^[0-9a-f-]{36}$/i.test(lastEventId) ? lastEventId : null);
    // the replay query starts now, inside the request context; live messages are buffered until it is out
    const replay = this.visits.changesOf(g, after);
    const live = this.hub.stream([`gate:${g.gateId}`]).pipe(
      map((m): MessageEvent => {
        let id: string | undefined;
        try {
          id = (JSON.parse(m.data) as { ids?: { eventId?: string } }).ids?.eventId;
        } catch {
          id = undefined;
        }
        return { ...(id ? { id } : {}), type: m.type ?? 'message', data: m.data };
      }),
    );
    return new Observable<MessageEvent>((subscriber) => {
      const seen = new Set<string>();
      const buffered: MessageEvent[] = [];
      let replaying = true;
      const emit = (m: MessageEvent) => {
        if (m.id) {
          if (seen.has(String(m.id))) return;
          seen.add(String(m.id));
        }
        subscriber.next(m);
      };
      const sub = live.subscribe({
        next: (m) => (replaying ? buffered.push(m) : emit(m)),
        error: (e: unknown) => subscriber.error(e),
      });
      replay
        .then((rows) => {
          for (const r of rows)
            emit({
              id: r.id,
              type: `gate.visit.${r.kind}`,
              data: JSON.stringify({
                type: `gate.visit.${r.kind}`,
                ids: { visitId: r.visitId, visitEventId: r.id },
              }),
            });
          replaying = false;
          for (const m of buffered.splice(0)) emit(m);
        })
        .catch((e: unknown) => subscriber.error(e));
      return () => sub.unsubscribe();
    });
  }
}
