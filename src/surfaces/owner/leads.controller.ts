import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { type ListingLeadMessage, type ListingViewing } from '@generated/prisma/client';
import { type LeadWithParts, ListingLeadsService } from '@modules/ops-listings/listing-leads.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  LeadLeaseDraftCreateDto,
  LeadLeaseDraftDto,
  LeadMessageCreateDto,
  type LeadMessageDto,
  LeadNotesDto,
  LeadStateDto,
  type LeadViewingDto,
  ListingChannelName,
  type ListingLeadAuthorName,
  type ListingLeadLostReasonName,
  ListingLeadStateName,
  type ListingViewingStateName,
  OwnerLeadDto,
  OwnerLeadSummaryDto,
  OwnerViewingDto,
  type ProspectEnquiryDto,
  ViewingCompleteDto,
  ViewingDeclineDto,
} from './leads.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const LIVE = ['requested', 'confirmed'];
const iso = (d: Date | null) => (d ? toBangkokIso(d) : null);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function leadMessageDto(m: ListingLeadMessage): LeadMessageDto {
  return {
    id: m.id,
    author: m.author as ListingLeadAuthorName,
    body: m.body,
    createdAt: toBangkokIso(m.createdAt),
  };
}

export function leadViewingDto(v: ListingViewing): LeadViewingDto {
  return {
    id: v.id,
    startsAt: toBangkokIso(v.startsAt),
    endsAt: toBangkokIso(v.endsAt),
    state: v.state as ListingViewingStateName,
    note: v.note,
    reason: v.declineReason,
    cancelledBy: v.cancelledBy as ListingLeadAuthorName | null,
    rescheduledTo: v.rescheduledTo,
  };
}

function nextViewing(lead: LeadWithParts): LeadViewingDto | null {
  const next = [...lead.viewings]
    .filter((v) => LIVE.includes(v.state))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  return next ? leadViewingDto(next) : null;
}

export function ownerLeadSummaryDto(lead: LeadWithParts): OwnerLeadSummaryDto {
  const last = lead.messages.at(-1) ?? null;
  const open = !['won', 'lost'].includes(lead.state);
  return {
    id: lead.id,
    listing: {
      id: lead.listing.id,
      slug: lead.listing.slug,
      title: lead.listing.titleTh,
      unitId: lead.listing.unitId,
    },
    prospect: {
      partyId: lead.party.id,
      name: lead.party.displayName,
      phone: lead.party.phoneE164,
      lineLinked: Boolean(lead.party.lineUserId),
    },
    state: lead.state as ListingLeadStateName,
    lastMessage: last?.body.slice(0, 200) ?? null,
    channel: (lead.channel as ListingChannelName | null) ?? null,
    lastMessageBy: (last?.author as ListingLeadAuthorName | undefined) ?? null,
    awaitingReply: open && last?.author === 'prospect',
    nextViewing: nextViewing(lead),
    lastProspectAt: toBangkokIso(lead.lastProspectAt),
    lastOwnerAt: iso(lead.lastOwnerAt),
    createdAt: toBangkokIso(lead.createdAt),
  };
}

export function ownerLeadDto(lead: LeadWithParts): OwnerLeadDto {
  return {
    ...ownerLeadSummaryDto(lead),
    moveInDate: day(lead.moveInDate),
    termMonths: lead.termMonths,
    occupants: lead.occupants,
    nationality: lead.nationality,
    notes: lead.notes,
    lostReason: lead.lostReason as ListingLeadLostReasonName | null,
    lostNote: lead.lostNote,
    messages: lead.messages.map(leadMessageDto),
    viewings: lead.viewings.map(leadViewingDto),
    leaseId: lead.leaseId,
    version: lead.version,
  };
}

export function prospectEnquiryDto(lead: LeadWithParts): ProspectEnquiryDto {
  return {
    id: lead.id,
    listing: {
      slug: lead.listing.slug,
      titleTh: lead.listing.titleTh,
      titleEn: lead.listing.titleEn,
      rent: lead.listing.rent.toFixed(2),
      district: lead.listing.district,
      province: lead.listing.province,
      ownerName: lead.listing.tenant.displayName,
      available: lead.listing.state === 'published',
    },
    open: !['won', 'lost'].includes(lead.state),
    moveInDate: day(lead.moveInDate),
    termMonths: lead.termMonths,
    occupants: lead.occupants,
    nationality: lead.nationality,
    messages: lead.messages.map(leadMessageDto),
    viewings: lead.viewings.map(leadViewingDto),
    createdAt: toBangkokIso(lead.createdAt),
    updatedAt: toBangkokIso(lead.updatedAt),
  };
}

const VIEWING_EXAMPLE: LeadViewingDto = {
  id: FAKE.uuid,
  startsAt: '2026-11-07T10:00:00+07:00',
  endsAt: '2026-11-07T10:30:00+07:00',
  state: 'requested' as ListingViewingStateName,
  note: null,
  reason: null,
  cancelledBy: null,
  rescheduledTo: null,
};

export const OWNER_LEAD_SUMMARY_EXAMPLE: OwnerLeadSummaryDto = {
  id: FAKE.uuid,
  listing: {
    id: FAKE.uuid,
    slug: 'condo-1br-0193f2a4b1',
    title: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
    unitId: FAKE.uuid,
  },
  prospect: { partyId: FAKE.uuid, name: 'สมศรี ใจดี', phone: null, lineLinked: true },
  state: ListingLeadStateName.ViewingBooked,
  lastMessage: 'ห้องยังว่างไหมคะ อยากเข้าดูเสาร์นี้',
  channel: ListingChannelName.FacebookGroup,
  lastMessageBy: 'prospect' as ListingLeadAuthorName,
  awaitingReply: true,
  nextViewing: VIEWING_EXAMPLE,
  lastProspectAt: '2026-11-01T09:15:00+07:00',
  lastOwnerAt: null,
  createdAt: '2026-11-01T09:15:00+07:00',
};

export const OWNER_LEAD_EXAMPLE: OwnerLeadDto = {
  ...OWNER_LEAD_SUMMARY_EXAMPLE,
  moveInDate: '2026-12-01',
  termMonths: 12,
  occupants: 2,
  nationality: null,
  notes: null,
  lostReason: null,
  lostNote: null,
  messages: [
    {
      id: FAKE.uuid,
      author: 'prospect' as ListingLeadAuthorName,
      body: 'ห้องยังว่างไหมคะ อยากเข้าดูเสาร์นี้',
      createdAt: '2026-11-01T09:15:00+07:00',
    },
  ],
  viewings: [VIEWING_EXAMPLE],
  leaseId: null,
  version: 2,
};

export const PROSPECT_ENQUIRY_EXAMPLE: ProspectEnquiryDto = {
  id: FAKE.uuid,
  listing: {
    slug: 'condo-1br-0193f2a4b1',
    titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
    titleEn: 'One-bedroom condo near BTS Ari',
    rent: '15000.00',
    district: 'พญาไท',
    province: 'กรุงเทพมหานคร',
    ownerName: 'มาลี ใจงาม',
    available: true,
  },
  open: true,
  moveInDate: '2026-12-01',
  termMonths: 12,
  occupants: 2,
  nationality: null,
  messages: OWNER_LEAD_EXAMPLE.messages,
  viewings: [VIEWING_EXAMPLE],
  createdAt: '2026-11-01T09:15:00+07:00',
  updatedAt: '2026-11-01T09:15:00+07:00',
};

/**
 * The owner's enquiries inbox (B7.3, D-252): every lead of the tenant's listings — what the prospect asked, the
 * conversation, viewings — reply (reaches the prospect in LINE), keep private notes, move the lead on or close it
 * won / lost with a reason; confirm, decline and record viewings; the viewing calendar.
 */
@ApiTags('owner.leads')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerLeadsController {
  constructor(private readonly leads: ListingLeadsService) {}

  @Get('leads')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.leads.list',
    summary: 'Enquiries inbox',
    description:
      'Leads of my listings, the most recent prospect activity first; filter by state, by listing, or `open=true` for those not yet won or lost. `awaitingReply` marks the ones waiting for my answer (D-252).',
    implements: ['D-252'],
  })
  @ApiQuery({ name: 'state', required: false, enum: ListingLeadStateName, enumName: 'ListingLeadState' })
  @ApiQuery({ name: 'listingId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'open', required: false, schema: { type: 'boolean' } })
  @ApiSuccess(200, {
    description: 'Leads',
    type: [OwnerLeadSummaryDto],
    example: [OWNER_LEAD_SUMMARY_EXAMPLE],
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query('state') state?: ListingLeadStateName,
    @Query('listingId') listingId?: string,
    @Query('open') open?: string,
  ): Promise<OwnerLeadSummaryDto[]> {
    if (state && !Object.values(ListingLeadStateName).includes(state))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'state', code: 'enum', message: 'unknown state' }],
      });
    const rows = await this.leads.list(ctx, { state: state as never, listingId, open: open === 'true' });
    return rows.map(ownerLeadSummaryDto);
  }

  @Get('leads/:leadId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.leads.get',
    summary: 'One enquiry',
    description:
      'A lead with what the prospect asked, the whole conversation, the viewings and my notes (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, { description: 'Lead', type: OwnerLeadDto, example: OWNER_LEAD_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('leadId', ParseUUIDPipe) id: string,
  ): Promise<OwnerLeadDto> {
    return ownerLeadDto(await this.leads.get(ctx, id));
  }

  @Post('leads/:leadId/messages')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.leads.reply',
    summary: 'Reply to an enquiry',
    description:
      'Adds my reply to the conversation; a `new` lead becomes `contacted`; the prospect receives it in LINE (consent `prospect.enquiry`, quiet hours) with a link to the enquiry (D-252).',
    implements: ['D-252', 'D-025'],
  })
  @ApiJsonBody(LeadMessageCreateDto, { body: 'ยังว่างค่ะ เสาร์นี้ 10 โมงสะดวกไหมคะ' })
  @ApiSuccess(201, { description: 'Sent', type: OwnerLeadDto, example: OWNER_LEAD_EXAMPLE })
  @ApiStandardErrors(
    'listing.bank_account_in_message',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.lead_invalid_state',
    ...T,
  )
  async reply(
    @CurrentTenant() ctx: TenantContext,
    @Param('leadId', ParseUUIDPipe) id: string,
    @Body() body: LeadMessageCreateDto,
  ): Promise<OwnerLeadDto> {
    return ownerLeadDto(await this.leads.reply(ctx, id, body.body));
  }

  @Patch('leads/:leadId')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.leads.update',
    summary: 'Notes on an enquiry',
    description: 'My private notes on the lead — never shown to the prospect (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(LeadNotesDto, { notes: 'ทำงานแถวอารีย์ สะดวกดูวันเสาร์' })
  @ApiSuccess(200, { description: 'Saved', type: OwnerLeadDto, example: OWNER_LEAD_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('leadId', ParseUUIDPipe) id: string,
    @Body() body: LeadNotesDto,
  ): Promise<OwnerLeadDto> {
    return ownerLeadDto(await this.leads.updateNotes(ctx, id, body.notes ?? null));
  }

  @Post('leads/:leadId/actions/set-state')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.leads.setState',
    summary: 'Move an enquiry on',
    description:
      'contacted, viewed, applied, won — or lost with a reason (`lostReason`). Won and lost close the lead and cancel its live viewings (the prospect is told). A closed lead cannot be reopened; the prospect starts a new one by writing again (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(LeadStateDto, { state: 'lost' as never, lostReason: 'chose_other' as never })
  @ApiSuccess(200, { description: 'Moved', type: OwnerLeadDto, example: OWNER_LEAD_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.lead_invalid_state',
    ...T,
  )
  async setState(
    @CurrentTenant() ctx: TenantContext,
    @Param('leadId', ParseUUIDPipe) id: string,
    @Body() body: LeadStateDto,
  ): Promise<OwnerLeadDto> {
    return ownerLeadDto(
      await this.leads.setState(ctx, id, {
        state: body.state,
        lostReason: body.lostReason ?? null,
        lostNote: body.lostNote ?? null,
      }),
    );
  }

  @Post('leads/:leadId/lease-draft')
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leads.leaseDraft',
    summary: 'Draft a lease from an enquiry',
    description:
      "A B2 lease draft from the listing's terms with the prospect as lessee: rent, deposit and advance months, the term (the prospect's, at least the listing's minimum), the start (given, else the prospect's move-in, else the listing's available date, else today). The enquiry becomes `applied`; when the lease is activated the listing closes (`leased`), this enquiry is won and the others are lost with a polite LINE message (B7.4, D-252, D-253). Compliance warnings of the terms answer as for any draft.",
    implements: ['D-252', 'D-253', 'D-020'],
  })
  @ApiJsonBody(LeadLeaseDraftCreateDto, { startDate: '2026-12-01', months: 12 })
  @ApiSuccess(201, {
    description: 'Drafted',
    type: LeadLeaseDraftDto,
    example: {
      leaseId: FAKE.uuid,
      lead: { ...OWNER_LEAD_EXAMPLE, state: ListingLeadStateName.Applied, leaseId: FAKE.uuid },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.lead_invalid_state',
    'listing.lease_exists',
    'lease.unit_unavailable',
    'asset.read_only',
    'compliance.acknowledgement_required',
    'compliance.deposit_cap',
    'compliance.forbidden_clause',
    'compliance.no_renewal_fee',
    'compliance.bill_disclosure',
    'compliance.no_midterm_increase',
    'compliance.water_minimum',
    'compliance.late_fee_policy',
    ...T,
  )
  async leaseDraft(
    @CurrentTenant() ctx: TenantContext,
    @Param('leadId', ParseUUIDPipe) id: string,
    @Body() body: LeadLeaseDraftCreateDto,
  ): Promise<LeadLeaseDraftDto> {
    const result = await this.leads.leaseDraft(ctx, id, body);
    return { leaseId: result.leaseId, lead: ownerLeadDto(result.lead) };
  }

  @Get('listing-viewings')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.listingViewings.list',
    summary: 'Viewing calendar',
    description:
      'Requested, confirmed and past viewings of my listings from `from` (default: today, Bangkok) to `to`, in time order (D-252).',
    implements: ['D-252'],
  })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date-time' } })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date-time' } })
  @ApiQuery({ name: 'listingId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiSuccess(200, {
    description: 'Viewings',
    type: [OwnerViewingDto],
    example: [
      {
        id: FAKE.uuid,
        startsAt: '2026-11-07T10:00:00+07:00',
        endsAt: '2026-11-07T10:30:00+07:00',
        state: 'confirmed' as ListingViewingStateName,
        leadId: FAKE.uuid,
        prospectName: 'สมศรี ใจดี',
        listing: { id: FAKE.uuid, title: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', slug: 'condo-1br-0193f2a4b1' },
      },
    ],
  })
  @ApiStandardErrors('validation.failed', ...T)
  async viewings(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('listingId') listingId?: string,
  ): Promise<OwnerViewingDto[]> {
    const date = (value: string | undefined, path: string) => {
      if (!value) return undefined;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime()))
        throw new DomainException('validation.failed', {
          errors: [{ path, code: 'format', message: `${path} is a date-time` }],
        });
      return parsed;
    };
    const rows = await this.leads.viewings(ctx, { from: date(from, 'from'), to: date(to, 'to'), listingId });
    return rows.map((v) => ({
      id: v.id,
      startsAt: toBangkokIso(v.startsAt),
      endsAt: toBangkokIso(v.endsAt),
      state: v.state as ListingViewingStateName,
      leadId: v.lead.id,
      prospectName: v.lead.party.displayName,
      listing: { id: v.listing.id, title: v.listing.titleTh, slug: v.listing.slug },
    }));
  }

  @Post('listing-viewings/:viewingId/actions/confirm')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listingViewings.confirm',
    summary: 'Confirm a viewing',
    description:
      'Confirms a requested viewing that has not started; the prospect is told in LINE and both sides are reminded `listing.viewing.reminder_hours_before` (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, { description: 'Confirmed', type: OwnerLeadDto, example: OWNER_LEAD_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'listing.viewing_invalid_state', ...T)
  async confirm(
    @CurrentTenant() ctx: TenantContext,
    @Param('viewingId', ParseUUIDPipe) id: string,
  ): Promise<OwnerLeadDto> {
    return ownerLeadDto(await this.leads.decideViewing(ctx, id, { action: 'confirm' }));
  }

  @Post('listing-viewings/:viewingId/actions/decline')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listingViewings.decline',
    summary: 'Decline a viewing',
    description:
      'Declines a requested or confirmed viewing that has not started, with a reason the prospect reads in LINE; the slot is free again (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ViewingDeclineDto, { reason: 'ไม่สะดวกช่วงเช้า ขอเป็นบ่ายได้ไหมคะ' })
  @ApiSuccess(200, { description: 'Declined', type: OwnerLeadDto, example: OWNER_LEAD_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.viewing_invalid_state',
    ...T,
  )
  async decline(
    @CurrentTenant() ctx: TenantContext,
    @Param('viewingId', ParseUUIDPipe) id: string,
    @Body() body: ViewingDeclineDto,
  ): Promise<OwnerLeadDto> {
    return ownerLeadDto(await this.leads.decideViewing(ctx, id, { action: 'decline', reason: body.reason }));
  }

  @Post('listing-viewings/:viewingId/actions/complete')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listingViewings.complete',
    summary: 'Record how a viewing went',
    description:
      'After a confirmed viewing has started: `completed` (the lead becomes `viewed`) or `no_show` (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ViewingCompleteDto, { outcome: 'completed' as never })
  @ApiSuccess(200, { description: 'Recorded', type: OwnerLeadDto, example: OWNER_LEAD_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.viewing_invalid_state',
    ...T,
  )
  async complete(
    @CurrentTenant() ctx: TenantContext,
    @Param('viewingId', ParseUUIDPipe) id: string,
    @Body() body: ViewingCompleteDto,
  ): Promise<OwnerLeadDto> {
    return ownerLeadDto(await this.leads.completeViewing(ctx, id, body.outcome));
  }
}
