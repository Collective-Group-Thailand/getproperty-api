import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { DebtClearancesService } from '@modules/ops-juristic/debt-clearances.service';
import { PaymentPlansService } from '@modules/ops-juristic/payment-plans.service';
import { RecurringPaymentsService } from '@modules/ops-payments/recurring-payments.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DocumentDownloadDto } from '../owner/deposits.dto';
import {
  CLEARANCE_EXAMPLE,
  DCL_DOWNLOAD,
  debtClearanceDto,
  MANDATE_EXAMPLE,
  mandateDto,
  paymentPlanDto,
  PLAN_EXAMPLE,
} from '../owner/juristic-collections.controller';
import {
  DebtClearanceDto,
  DebtClearanceRequestDto,
  PaymentMandateCreatedDto,
  PaymentMandateCreateDto,
  PaymentMandateDto,
  type PaymentMandateStateName,
  PaymentPlanDto,
  PaymentPlanOptionsDto,
  PaymentPlanRequestDto,
  type PaymentPlanStateName,
} from '../owner/juristic-collections.dto';
import { ApiSurface, SURFACES } from '../surfaces';

/**
 * `/v1/resident/units/{unitId}/…` of J1.2a (D-306, D-308, D-325): payment plans, debt clearance and automatic payment
 * of a unit I hold a role on **today** (D-309, D-322). Another resident's unit, another tenant's unit, or a unit I no
 * longer own is a 404.
 */
@ApiTags('resident.collections')
@ApiSurface(SURFACES.resident)
@Controller('resident/units/:unitId')
export class ResidentUnitCollectionsController {
  constructor(
    private readonly plans: PaymentPlansService,
    private readonly clearances: DebtClearancesService,
    private readonly recurring: RecurringPaymentsService,
  ) {}

  // ------------------------------------------------------------------------------------------- plans

  @Post('payment-plan-requests')
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.units.requestPaymentPlan',
    summary: 'Ask for a payment plan',
    description:
      'As the billed party of the unit (co-owner, payer or lessee): split what I owe now into 2 … `juristic.plan_max_instalments` monthly instalments from `firstDueOn` (default the 1st of next month). The juristic office approves or rejects it; I am told in LINE / e-mail when it is approved. One open plan per unit (409 `payment_plan.open_exists`); nothing owed → 409 `payment_plan.nothing_due`. Requires `Idempotency-Key` (D-308, D-325).',
    implements: ['D-308', 'D-309', 'D-325'],
  })
  @ApiJsonBody(PaymentPlanRequestDto, { instalments: 3, note: 'ขอผ่อน 3 งวด' })
  @ApiSuccess(201, {
    description: 'Requested',
    type: PaymentPlanDto,
    example: {
      ...PLAN_EXAMPLE,
      state: 'proposed' as PaymentPlanStateName,
      principal: null,
      instalments: [],
      nextActions: ['withdraw'],
    },
  })
  @ApiStandardErrors(
    'payment_plan.open_exists',
    'payment_plan.nothing_due',
    'idempotency.key_required',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
  )
  async requestPlan(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: PaymentPlanRequestDto,
  ): Promise<PaymentPlanDto> {
    return paymentPlanDto(await this.plans.residentRequest(unitId, body), ['withdraw']);
  }

  @Get('payment-plan-requests/options')
  @ApiEndpoint({
    id: 'resident.units.paymentPlanOptions',
    summary: 'What a payment-plan request may ask',
    description:
      'The instalment range (2 … `juristic.plan_max_instalments`), the first due date window (today … +92 days, default the 1st of next month) and what would be split now (`proposedPrincipal`, the open balance of my billed party on the unit); `available` false = nothing to split. Same rules as the request (J-CR, D-335; D-308, D-325).',
    implements: ['D-308', 'D-325', 'D-335'],
  })
  @ApiSuccess(200, {
    description: 'Options',
    type: PaymentPlanOptionsDto,
    example: {
      minInstalments: 2,
      maxInstalments: 12,
      earliestFirstDueOn: '2027-01-15',
      latestFirstDueOn: '2027-04-17',
      defaultFirstDueOn: '2027-02-01',
      proposedPrincipal: '10000.00',
      available: true,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async planOptions(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<PaymentPlanOptionsDto> {
    return this.plans.residentOptions(unitId);
  }

  @Get('payment-plans')
  @ApiEndpoint({
    id: 'resident.units.paymentPlans',
    summary: 'My payment plans',
    description: 'My plans on this unit, newest first, with their instalments (D-325).',
    implements: ['D-325'],
  })
  @ApiSuccess(200, {
    description: 'Plans',
    type: [PaymentPlanDto],
    example: [{ ...PLAN_EXAMPLE, nextActions: [] }],
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async listPlans(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<PaymentPlanDto[]> {
    return (await this.plans.residentList(unitId)).map((p) =>
      paymentPlanDto(p, p.state === 'proposed' ? ['withdraw'] : []),
    );
  }

  @Get('payment-plans/:planId')
  @ApiEndpoint({
    id: 'resident.units.paymentPlan',
    summary: 'One of my payment plans',
    description:
      'A plan of mine on this unit with its instalments (the LINE message links it); another unit’s or another party’s plan is a 404 (J-CR, D-335; D-325).',
    implements: ['D-325', 'D-335'],
  })
  @ApiSuccess(200, {
    description: 'Plan',
    type: PaymentPlanDto,
    example: { ...PLAN_EXAMPLE, nextActions: [] },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async getPlan(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<PaymentPlanDto> {
    const p = await this.plans.residentGet(unitId, planId);
    return paymentPlanDto(p, p.state === 'proposed' ? ['withdraw'] : []);
  }

  @Post('payment-plans/:planId/actions/withdraw')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.units.withdrawPaymentPlan',
    summary: 'Withdraw my plan request',
    description: 'While it waits for the office (D-325).',
    implements: ['D-325'],
  })
  @ApiSuccess(200, {
    description: 'Withdrawn',
    type: PaymentPlanDto,
    example: { ...PLAN_EXAMPLE, state: 'cancelled' as PaymentPlanStateName, nextActions: [] },
  })
  @ApiStandardErrors('payment_plan.invalid_state', 'validation.failed', 'http.not_found')
  async withdrawPlan(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<PaymentPlanDto> {
    return paymentPlanDto(await this.plans.residentWithdraw(unitId, planId));
  }

  // ------------------------------------------------------------------------------------------- debt clearance

  @Post('debt-clearance-requests')
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.units.requestDebtClearance',
    summary: 'Ask for a debt clearance certificate',
    description:
      'As a co-owner of the unit (e.g. before selling it): issued at once when nothing is outstanding on `asOf` (today … +60 days) — open invoices, surcharges, queued charges and started drafts of mine and of my bill-to payer, less my credit — with a numbered PDF (`DCL-…`) and a verification QR; `verifyCode` is returned once. Something outstanding → 409 `debt_clearance.outstanding` with the amount in `outstanding` (nothing stored). With a fee (`juristic.debt_clearance.fee`) the request waits, the fee is billed, and the office issues it once paid. Requires `Idempotency-Key` (D-306, D-325).',
    implements: ['D-306', 'D-309', 'D-325'],
  })
  @ApiJsonBody(DebtClearanceRequestDto, { asOf: '2027-03-15', language: 'th' })
  @ApiSuccess(201, {
    description: 'Issued (or waiting for its fee)',
    type: DebtClearanceDto,
    example: CLEARANCE_EXAMPLE,
  })
  @ApiStandardErrors(
    'debt_clearance.outstanding',
    'idempotency.key_required',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
  )
  async requestClearance(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: DebtClearanceRequestDto,
  ): Promise<DebtClearanceDto> {
    const r = await this.clearances.residentRequest(unitId, body);
    return debtClearanceDto(r.row, r.verifyCode);
  }

  @Get('debt-clearances')
  @ApiEndpoint({
    id: 'resident.units.debtClearances',
    summary: 'My debt clearance certificates',
    description: 'Requests and certificates of mine on this unit, newest first (D-306).',
    implements: ['D-306'],
  })
  @ApiSuccess(200, {
    description: 'Certificates',
    type: [DebtClearanceDto],
    example: [{ ...CLEARANCE_EXAMPLE, verifyCode: null }],
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async listClearances(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<DebtClearanceDto[]> {
    return (await this.clearances.residentList(unitId)).map((r) => debtClearanceDto(r));
  }

  @Get('debt-clearances/:debtClearanceId')
  @ApiEndpoint({
    id: 'resident.units.debtClearance',
    summary: 'One of my debt clearance certificates',
    description:
      'A request or certificate of mine on this unit (the LINE message links it; the verify code is never shown again); another unit’s or another party’s is a 404 (J-CR, D-335; D-306).',
    implements: ['D-306', 'D-335'],
  })
  @ApiSuccess(200, {
    description: 'Certificate',
    type: DebtClearanceDto,
    example: { ...CLEARANCE_EXAMPLE, verifyCode: null },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async getClearance(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('debtClearanceId', ParseUUIDPipe) id: string,
  ): Promise<DebtClearanceDto> {
    return debtClearanceDto(await this.clearances.residentGet(unitId, id));
  }

  @Get('debt-clearances/:debtClearanceId/document')
  @ApiEndpoint({
    id: 'resident.units.debtClearanceDocument',
    summary: 'Open my certificate',
    description: 'A 5-minute signed URL of the certificate PDF (D-306).',
    implements: ['D-306'],
  })
  @ApiSuccess(200, { description: 'Download', type: DocumentDownloadDto, example: DCL_DOWNLOAD })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async clearanceDocument(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('debtClearanceId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.clearances.residentDocument(unitId, id);
    return {
      documentId: r.row.documentId!,
      number: r.row.number!,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }

  // ------------------------------------------------------------------------------------------- mandates

  @Post('payment-mandates')
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.units.createPaymentMandate',
    summary: 'Set up automatic payment',
    description:
      'As the billed party of the unit: start a direct-debit or card authorisation (channel `recurring`). Open `setupUrl` to authorise it at the provider; it becomes `active` on the provider’s webhook. Then every advance invoice (quarterly / semiannual / annual; every invoice with scope `all_invoices`) is charged once when issued. One open mandate per unit (409 `payment_mandate.open_exists`); no provider yet → 409 `recurring.unavailable` (O-020). Requires `Idempotency-Key` (D-308, D-325).',
    implements: ['D-308', 'D-325'],
  })
  @ApiJsonBody(PaymentMandateCreateDto, { method: 'direct_debit', scope: 'advance_invoices' })
  @ApiSuccess(201, {
    description: 'Started',
    type: PaymentMandateCreatedDto,
    example: {
      mandate: {
        ...MANDATE_EXAMPLE,
        state: 'pending' as PaymentMandateStateName,
        masked: null,
        activatedAt: null,
      },
      setupUrl: 'https://provider.example/mandates/abc',
    },
  })
  @ApiStandardErrors(
    'payment_mandate.open_exists',
    'recurring.unavailable',
    'idempotency.key_required',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
  )
  async createMandate(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: PaymentMandateCreateDto,
  ): Promise<PaymentMandateCreatedDto> {
    const r = await this.recurring.residentCreate(unitId, body);
    return { mandate: mandateDto(r.mandate), setupUrl: r.setupUrl };
  }

  @Get('payment-mandates')
  @ApiEndpoint({
    id: 'resident.units.paymentMandates',
    summary: 'My automatic payments',
    description: 'My mandates on this unit, newest first; only a masked account / card (D-325).',
    implements: ['D-325'],
  })
  @ApiSuccess(200, { description: 'Mandates', type: [PaymentMandateDto], example: [MANDATE_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async listMandates(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<PaymentMandateDto[]> {
    return (await this.recurring.residentList(unitId)).map(mandateDto);
  }

  @Post('payment-mandates/:mandateId/actions/cancel')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.units.cancelPaymentMandate',
    summary: 'Stop automatic payment',
    description: 'Revokes my pending or active mandate; nothing more is charged (D-325).',
    implements: ['D-325'],
  })
  @ApiSuccess(200, {
    description: 'Stopped',
    type: PaymentMandateDto,
    example: { ...MANDATE_EXAMPLE, state: 'revoked' as PaymentMandateStateName, endedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('payment_mandate.invalid_state', 'validation.failed', 'http.not_found')
  async cancelMandate(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('mandateId', ParseUUIDPipe) id: string,
  ): Promise<PaymentMandateDto> {
    return mandateDto(await this.recurring.residentCancel(unitId, id));
  }
}
