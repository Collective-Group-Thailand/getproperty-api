import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { ListingLeadsService } from '@modules/ops-listings/listing-leads.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PROSPECT_ENQUIRY_EXAMPLE, prospectEnquiryDto } from '../owner/leads.controller';
import {
  EnquiryCreateDto,
  LeadMessageCreateDto,
  ProspectEnquiryDto,
  ViewingCancelDto,
  ViewingRequestDto,
  ViewingRescheduleDto,
} from '../owner/leads.dto';
import { ApiSurface, SURFACES } from '../surfaces';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TERMS = { moveInDate: '2026-12-01', termMonths: 12, occupants: 2, consent: true };

/**
 * A prospect's enquiries and viewings (B7.3, D-252): ask about a published listing (first contact records consent
 * `prospect.enquiry` and creates my party in the owner's tenant), book a free viewing slot, change or cancel it,
 * write to the owner, and see my enquiries with the owner's replies. Only my own enquiries are ever visible.
 */
@ApiTags('prospect.enquiries')
@ApiSurface(SURFACES.prospect)
@Controller('prospect')
export class ProspectEnquiriesController {
  constructor(private readonly leads: ListingLeadsService) {}

  @Post('listings/:slug/enquiries')
  @HttpCode(201)
  @ApiEndpoint({
    id: 'prospect.enquiries.create',
    summary: 'Ask about a listing',
    description:
      'Sends a message to the owner of a published listing. The first contact with a listing needs `consent: true` (PDPA purpose `prospect.enquiry`, `listing.consent_required` otherwise) and counts against `listing.lead.daily_limit`; later messages go into the same open enquiry. Nationality is optional (D-252).',
    implements: ['D-252', 'D-025'],
  })
  @ApiJsonBody(EnquiryCreateDto, { ...TERMS, message: 'ห้องยังว่างไหมคะ อยากเข้าดูเสาร์นี้' })
  @ApiSuccess(201, { description: 'Sent', type: ProspectEnquiryDto, example: PROSPECT_ENQUIRY_EXAMPLE })
  @ApiStandardErrors(
    'listing.bank_account_in_message',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'http.conflict',
    'listing.consent_required',
    'listing.enquiry_limit',
  )
  async enquire(@Param('slug') slug: string, @Body() body: EnquiryCreateDto): Promise<ProspectEnquiryDto> {
    return prospectEnquiryDto((await this.leads.enquire(this.slug(slug), body)).lead);
  }

  @Post('listings/:slug/viewings')
  @HttpCode(201)
  @ApiEndpoint({
    id: 'prospect.viewings.request',
    summary: 'Book a viewing',
    description:
      'Requests a free slot of the listing’s availability (`GET /v1/public/listings/{slug}/viewing-slots`; notice and horizon are settings) — the owner confirms or declines. Opens the enquiry when there is none (same consent rule as asking). One live viewing per enquiry (`listing.viewing_exists`: change its time instead); a slot taken a moment ago answers `listing.viewing_slot_taken` (D-252). `mode: self` (G7, D-295) books a self-viewing slot: the listing must offer it (`viewing.self_unavailable` with the reason, `viewing.unit_occupied`), I must have a verified identity and phone and accept the visitor terms in force (`viewing.requirements_missing` with what is missing, `viewing.terms_outdated`), and no other self viewing of mine may overlap its code window (`viewing.access_overlap`).',
    implements: ['D-252', 'D-025', 'D-295'],
  })
  @ApiJsonBody(ViewingRequestDto, {
    ...TERMS,
    startsAt: '2026-11-07T10:00:00+07:00',
    note: 'จะมากับแฟนค่ะ',
    mode: 'accompanied',
  })
  @ApiSuccess(201, { description: 'Requested', type: ProspectEnquiryDto, example: PROSPECT_ENQUIRY_EXAMPLE })
  @ApiStandardErrors(
    'listing.bank_account_in_message',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'http.conflict',
    'listing.consent_required',
    'listing.enquiry_limit',
    'listing.viewing_slot_unavailable',
    'listing.viewing_slot_taken',
    'listing.viewing_exists',
    'viewing.self_unavailable',
    'viewing.unit_occupied',
    'viewing.requirements_missing',
    'viewing.terms_outdated',
    'viewing.access_overlap',
  )
  async requestViewing(
    @Param('slug') slug: string,
    @Body() body: ViewingRequestDto,
  ): Promise<ProspectEnquiryDto> {
    return prospectEnquiryDto(
      await this.leads.requestViewing(this.slug(slug), { ...body, startsAt: new Date(body.startsAt) }),
    );
  }

  @Get('enquiries')
  @ApiEndpoint({
    id: 'prospect.enquiries.list',
    summary: 'My enquiries',
    description:
      'Every enquiry I started, most recently active first, with the conversation and viewings (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'Enquiries',
    type: [ProspectEnquiryDto],
    example: [PROSPECT_ENQUIRY_EXAMPLE],
  })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<ProspectEnquiryDto[]> {
    return (await this.leads.myLeads()).map(prospectEnquiryDto);
  }

  @Get('enquiries/:leadId')
  @ApiEndpoint({
    id: 'prospect.enquiries.get',
    summary: 'One of my enquiries',
    description: 'An enquiry of mine (someone else’s is a 404) (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, { description: 'Enquiry', type: ProspectEnquiryDto, example: PROSPECT_ENQUIRY_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async get(@Param('leadId', ParseUUIDPipe) id: string): Promise<ProspectEnquiryDto> {
    return prospectEnquiryDto(await this.leads.myLead(id));
  }

  @Post('enquiries/:leadId/messages')
  @HttpCode(201)
  @ApiEndpoint({
    id: 'prospect.enquiries.write',
    summary: 'Write to the owner',
    description: 'Adds my message to an open enquiry; the owner is told in the console and in LINE (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(LeadMessageCreateDto, { body: 'ขอบคุณค่ะ เจอกันเสาร์นี้นะคะ' })
  @ApiSuccess(201, { description: 'Sent', type: ProspectEnquiryDto, example: PROSPECT_ENQUIRY_EXAMPLE })
  @ApiStandardErrors(
    'listing.bank_account_in_message',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.lead_invalid_state',
  )
  async write(
    @Param('leadId', ParseUUIDPipe) id: string,
    @Body() body: LeadMessageCreateDto,
  ): Promise<ProspectEnquiryDto> {
    return prospectEnquiryDto(await this.leads.writeToOwner(id, body.body));
  }

  @Post('viewings/:viewingId/actions/cancel')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'prospect.viewings.cancel',
    summary: 'Cancel my viewing',
    description:
      'Cancels a requested or confirmed viewing that has not started; the owner is told (D-252). A self viewing’s door codes are revoked at once (D-295).',
    implements: ['D-252', 'D-295'],
  })
  @ApiJsonBody(ViewingCancelDto, { reason: 'ได้ห้องแล้วค่ะ' })
  @ApiSuccess(200, { description: 'Cancelled', type: ProspectEnquiryDto, example: PROSPECT_ENQUIRY_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.viewing_invalid_state',
  )
  async cancel(
    @Param('viewingId', ParseUUIDPipe) id: string,
    @Body() body: ViewingCancelDto,
  ): Promise<ProspectEnquiryDto> {
    return prospectEnquiryDto(await this.leads.cancelViewing(id, body.reason ?? null));
  }

  @Post('viewings/:viewingId/actions/reschedule')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'prospect.viewings.reschedule',
    summary: 'Change my viewing time',
    description:
      'Moves a requested or confirmed viewing to another free slot in one step: the old one is cancelled and points to the new request, which the owner confirms again (D-252). A self viewing stays a self viewing: the new slot must be a self slot and the checks of booking apply again; the old door-code window closes at once (D-295).',
    implements: ['D-252', 'D-295'],
  })
  @ApiJsonBody(ViewingRescheduleDto, { startsAt: '2026-11-08T14:00:00+07:00' })
  @ApiSuccess(200, { description: 'Moved', type: ProspectEnquiryDto, example: PROSPECT_ENQUIRY_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.viewing_invalid_state',
    'listing.viewing_slot_unavailable',
    'listing.viewing_slot_taken',
    'viewing.self_unavailable',
    'viewing.unit_occupied',
    'viewing.requirements_missing',
    'viewing.terms_outdated',
    'viewing.access_overlap',
  )
  async reschedule(
    @Param('viewingId', ParseUUIDPipe) id: string,
    @Body() body: ViewingRescheduleDto,
  ): Promise<ProspectEnquiryDto> {
    return prospectEnquiryDto(await this.leads.rescheduleViewing(id, new Date(body.startsAt)));
  }

  private slug(slug: string): string {
    if (!SLUG.test(slug) || slug.length > 80) return '-';
    return slug;
  }
}
