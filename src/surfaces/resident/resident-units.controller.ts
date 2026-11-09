import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { AcceptLanguage, resolveLanguage } from '@common/i18n/language';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { UnitResidentInvitationsService } from '@modules/ops-parties/unit-resident-invitations.service';
import { type Bucket, SeriesService } from '@modules/smart-ingest/series.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ResidentSignatureOtpDto } from '../owner/leases.dto';
import { type UtilityName } from '../owner/money-settings.dto';
import { OtpVerifyDto } from '../shared/auth.dto';
import { iso } from '../shared/mappers';
import { MeService } from '../shared/me.service';
import { type MeterUnitName, SeriesBucketName, UsageQuery } from '../shared/smart.dto';
import { BuildingLegalFormName, PropertyKindName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  ResidentMeUnitsDto,
  ResidentUnitCapability,
  ResidentUnitRoleName,
  ResidentUnitRoleSourceName,
  ResidentUnitUsageDto,
  UnitInvitationAcceptedDto,
  UnitInvitationPreviewDto,
} from './resident-units.dto';

function actorUser(): { userId: string; scopes: readonly string[] } {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return { userId: actor.publicId, scopes: actor.scopes };
}

@ApiTags('resident.units')
@ApiSurface(SURFACES.resident)
@Controller('resident/me/units')
export class ResidentMeUnitsController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.units.list',
    summary: 'My units and what I am there',
    description:
      'Every unit of my `unit:` scopes across tenants (with the register’s measures and whether auto-pay can be set up, J-CR) — units I live in (occupancy) **or** own (co-owner in the register, D-309) — with my roles today (`co_owner`, `tenant`, `co_tenant`, `family`, `payer`; source `ownership`, `occupancy` or `lease`) and the navigation `capabilities` of each unit (D-322). A lease alone never adds a unit; a former owner’s unit disappears on the ownership’s end date. `unitsHash` changes with any role; `refreshRequired` = my token’s unit scopes differ from today’s units (refresh before switching unit).',
    implements: ['D-025', 'D-309', 'D-322'],
  })
  @ApiSuccess(200, {
    description: 'My units',
    type: ResidentMeUnitsDto,
    example: {
      units: [
        {
          unitId: FAKE.uuid,
          unitNo: FAKE.unitCode,
          buildingId: FAKE.buildingId,
          buildingName: 'อาคาร A',
          propertyId: FAKE.uuid,
          propertyKind: PropertyKindName.Condo,
          legalForm: BuildingLegalFormName.CondoAct,
          tenantId: FAKE.tenantId,
          tenantName: 'นิติบุคคลอาคารชุด ตัวอย่าง',
          roles: [
            {
              role: ResidentUnitRoleName.CoOwner,
              source: ResidentUnitRoleSourceName.Ownership,
              partyId: FAKE.uuid,
              leaseId: null,
              from: '2026-10-01',
              to: null,
            },
          ],
          capabilities: [
            ResidentUnitCapability.Notices,
            ResidentUnitCapability.Parcels,
            ResidentUnitCapability.Facilities,
            ResidentUnitCapability.Rules,
            ResidentUnitCapability.Contacts,
            ResidentUnitCapability.ServiceRequests,
            ResidentUnitCapability.Invoices,
          ],
          areaSqm: '34.77',
          ownershipRatio: '0.012345',
          landAreaSqwa: null,
          plotNo: null,
          recurringAvailable: false,
          leaseIds: [],
        },
      ],
      unitsHash: '9f2c1a0e5b7d4c3a8e6f1b2d0c9a7e5f3b1d8c6a4e2f0b9d7c5a3e1f8b6d4c2a',
      refreshRequired: false,
    } satisfies ResidentMeUnitsDto,
  })
  @ApiStandardErrors('auth.unauthenticated')
  list(): Promise<ResidentMeUnitsDto> {
    return this.me.residentUnits();
  }
}

@ApiTags('resident.usage')
@ApiSurface(SURFACES.resident)
@Controller('resident/units/:unitId/usage')
export class ResidentUnitUsageController {
  constructor(private readonly series: SeriesService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.units.usage',
    summary: 'Usage of a unit I live in',
    description:
      'Daily (or hourly) electricity and water use of a unit I **live in** (a current occupancy of mine, any role — no lease needed, D-322), from the start of my occupancy, summed over the meters that served it (swaps included) from the telemetry rollups; empty for manual meters (D-063, D-162). `summary` as in the lease usage (D-203). A unit outside my scopes, or one I own without living there, is a 404 (the occupant’s consumption is their personal data, D-025).',
    implements: ['D-025', 'D-063', 'D-162', 'D-203', 'D-322'],
  })
  @ApiSuccess(200, {
    description: 'Usage',
    type: ResidentUnitUsageDto,
    example: {
      unitId: FAKE.uuid,
      from: '2026-10-01T00:00:00+07:00',
      to: '2026-10-31T00:00:00+07:00',
      bucket: SeriesBucketName.D1,
      series: [
        {
          utility: 'electric' as never,
          unit: 'kwh' as never,
          points: [{ bucket: '2026-10-01T00:00:00+07:00', usage: '6.250' }],
        },
      ],
      summary: [
        {
          utility: 'electric' as never,
          unit: 'kwh' as never,
          total: '187.500',
          previousTotal: null,
          cycleToDate: { from: '2026-10-01T00:00:00+07:00', usage: '84.250', estimated: true },
        },
      ],
    } satisfies ResidentUnitUsageDto,
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Query() q: UsageQuery,
  ): Promise<ResidentUnitUsageDto> {
    const bucket = (q.bucket ?? SeriesBucketName.D1) as Bucket;
    const u = await this.series.residentUnitUsage(
      actorUser(),
      unitId,
      bucket,
      q.from ? new Date(q.from) : undefined,
      q.to ? new Date(q.to) : undefined,
    );
    return {
      unitId: u.unitId,
      from: iso(u.from),
      to: iso(u.to),
      bucket: bucket as SeriesBucketName,
      series: u.series.map((s) => ({
        utility: s.utility as UtilityName,
        unit: s.unit as MeterUnitName,
        points: s.points.map((p) => ({ bucket: iso(p.bucket), usage: p.usage.toFixed(3) })),
      })),
      summary: u.summary.map((s) => ({
        utility: s.utility as UtilityName,
        unit: s.unit as MeterUnitName,
        total: s.total.toFixed(3),
        previousTotal: s.previousTotal?.toFixed(3) ?? null,
        cycleToDate: s.cycleToDate
          ? {
              from: iso(s.cycleToDate.from),
              usage: s.cycleToDate.usage.toFixed(3),
              estimated: s.cycleToDate.estimated,
            }
          : null,
      })),
    };
  }
}

const INVITE_ERRORS = ['invitation.not_found', 'invitation.not_pending'] as const;

@ApiTags('resident.unitInvitations')
@ApiSurface(SURFACES.resident)
@Controller('resident/unit-invitations/:code')
export class ResidentUnitInvitationsController {
  constructor(private readonly invitations: UnitResidentInvitationsService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.unitInvitations.preview',
    summary: 'What a unit invitation is for',
    description:
      'The tenant, building, unit, a masked name and the masked phone the OTP will go to, before I redeem a co-owner invitation (D-322). 404 for an unknown code, 409 when used, revoked or expired.',
    implements: ['D-025', 'D-322'],
  })
  @ApiSuccess(200, {
    description: 'Preview',
    type: UnitInvitationPreviewDto,
    example: {
      tenantName: 'นิติบุคคลอาคารชุด ตัวอย่าง',
      buildingName: 'อาคาร A',
      unitNo: FAKE.unitCode,
      propertyKind: PropertyKindName.Condo,
      legalForm: BuildingLegalFormName.CondoAct,
      partyDisplayName: 'สม••••••',
      phoneMasked: '+66•••••1234',
      expiresAt: '2026-11-19T10:00:00+07:00',
    },
  })
  @ApiStandardErrors(...INVITE_ERRORS)
  async preview(@Param('code') code: string): Promise<UnitInvitationPreviewDto> {
    const p = await this.invitations.preview(code);
    return {
      ...p,
      propertyKind: p.propertyKind as PropertyKindName | null,
      legalForm: p.legalForm as BuildingLegalFormName | null,
      expiresAt: iso(p.expiresAt),
    };
  }

  @Post('otp')
  @HttpCode(201)
  @ApiEndpoint({
    id: 'resident.unitInvitations.requestOtp',
    summary: 'Send the OTP of a unit invitation',
    description:
      'Sends a 6-digit code by SMS to **the phone of the co-owner in the register** (never a number I type), so only the owner can redeem the invitation (D-322). One resend per `OTP_RESEND_SECONDS`, `OTP_MAX_PER_HOUR` per phone (429 `auth.otp_rate_limited`). 422 `invitation.phone_missing` when the register has no phone any more.',
    implements: ['D-025', 'D-322'],
  })
  @ApiSuccess(201, {
    description: 'Sent',
    type: ResidentSignatureOtpDto,
    example: {
      challengeId: FAKE.uuid,
      expiresAt: '2026-11-05T10:05:00+07:00',
      resendAvailableAt: '2026-11-05T10:01:00+07:00',
      phoneMasked: '+66•••••1234',
    },
  })
  @ApiStandardErrors(
    ...INVITE_ERRORS,
    'invitation.phone_missing',
    'auth.otp_rate_limited',
    'provider.unavailable',
  )
  async requestOtp(
    @Param('code') code: string,
    @AcceptLanguage() acceptLanguage?: string,
  ): Promise<ResidentSignatureOtpDto> {
    const r = await this.invitations.requestOtp(code, resolveLanguage(acceptLanguage));
    return {
      challengeId: r.challengeId,
      expiresAt: iso(r.expiresAt),
      resendAvailableAt: iso(r.resendAvailableAt),
      phoneMasked: r.phoneMasked,
    };
  }

  @Post('accept')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.unitInvitations.accept',
    summary: 'Redeem a unit invitation',
    description:
      'Links my login to the co-owner party of the invitation with the OTP sent to the register’s phone (D-322). The required PDPA consents first (409 `consent.required`, D-025; they then also bind this tenant as controller); single use (409 `invitation.not_pending`); a wrong code is 401 `auth.otp_invalid` with `attemptsRemaining`. Refresh my token to receive the unit (`refreshRequired`); one login can hold units in several tenants.',
    implements: ['D-025', 'D-061', 'D-322'],
  })
  @ApiJsonBody(OtpVerifyDto, { challengeId: FAKE.uuid, code: '123456' })
  @ApiSuccess(200, {
    description: 'Linked',
    type: UnitInvitationAcceptedDto,
    example: {
      tenantId: FAKE.tenantId,
      unitId: FAKE.uuid,
      partyId: FAKE.uuid,
      refreshRequired: true,
      acceptedOn: FAKE.date,
    },
  })
  @ApiStandardErrors(
    ...INVITE_ERRORS,
    'invitation.party_mismatch',
    'consent.required',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'validation.failed',
  )
  accept(
    @Param('code') code: string,
    @Body() body: OtpVerifyDto,
    @AcceptLanguage() acceptLanguage?: string,
  ): Promise<UnitInvitationAcceptedDto> {
    return this.invitations.accept(
      code,
      { challengeId: body.challengeId, code: body.code },
      resolveLanguage(acceptLanguage),
    );
  }
}
