import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceAcknowledgementService } from '@core/compliance/compliance-acknowledgement.service';
import { SettingsService } from '@core/settings/settings.service';
import { BankAccountService } from '@core/tenancy/bank-account.service';
import { type TariffAt, UtilityTariffsService } from '@core/utility-tariffs/utility-tariffs.service';
import { type TenantBankAccount } from '@generated/prisma/client';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import { OtpChallengeDto, OtpVerifyDto } from '../shared/auth.dto';
import { dateOnly, iso, isoOrNull, otpChallengeDto } from '../shared/mappers';
import { bankAccountActions } from '../shared/next-actions';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  AcknowledgementCreateDto,
  AcknowledgementDto,
  BankAccountCreateDto,
  BankAccountDto,
  BankAccountRequestedDto,
  type BankAccountStateName,
  CurrentTariffDto,
  type PaymentProviderName,
  SettingDto,
  type SettingScopeName,
  SettingsQuery,
  SettingUpdateDto,
  type SettingValueTypeName,
  SettingVersionDto,
  TariffCurrentQuery,
  type TariffVersionStateName,
  type UtilityName,
  type UtilityProviderName,
} from './money-settings.dto';

const TENANT_ERRORS = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

export function bankAccountDto(a: TenantBankAccount): BankAccountDto {
  return {
    nextActions: bankAccountActions(a.state),
    id: a.id,
    bankCode: a.bankCode,
    bankNameTh: a.bankNameTh,
    branch: a.branch,
    accountNoMasked: a.accountNoMasked,
    accountName: a.accountName,
    paymentProvider: a.paymentProvider as PaymentProviderName,
    buildingIds: a.buildingIds,
    isDefault: a.isDefault,
    state: a.state as BankAccountStateName,
    confirmedAt: isoOrNull(a.confirmedAt),
    createdAt: iso(a.createdAt),
  };
}

const BANK_EXAMPLE: BankAccountDto = {
  nextActions: ['remove'],
  id: FAKE.uuid,
  bankCode: '004',
  bankNameTh: 'ธนาคารตัวอย่าง',
  branch: null,
  accountNoMasked: 'xxxxxx1234',
  accountName: FAKE.companyName,
  paymentProvider: 'none' as PaymentProviderName,
  buildingIds: [],
  isDefault: true,
  state: 'active' as BankAccountStateName,
  confirmedAt: FAKE.dateTime,
  createdAt: FAKE.dateTime,
};
const OTP_EXAMPLE: OtpChallengeDto = {
  challengeId: FAKE.uuid,
  expiresAt: '2026-11-01T00:20:00+07:00',
  resendAvailableAt: '2026-11-01T00:16:00+07:00',
};

@ApiTags('owner.bankAccounts')
@ApiSurface(SURFACES.owner)
@Controller('owner/bank-accounts')
export class OwnerBankAccountsController {
  constructor(private readonly accounts: BankAccountService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.bank_account.manage')
  @ApiEndpoint({
    id: 'owner.bankAccounts.list',
    summary: 'Receiving bank accounts of my tenant',
    description:
      'Accounts that receive residents’ payments — the platform never holds funds (D-042). Numbers are masked.',
    implements: ['D-042', 'D-091'],
  })
  @ApiSuccess(200, { description: 'Accounts', type: [BankAccountDto], example: [BANK_EXAMPLE] })
  @ApiStandardErrors(...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext): Promise<BankAccountDto[]> {
    return (await this.accounts.list(ctx)).map(bankAccountDto);
  }

  @Post()
  @TenantScoped()
  @Idempotent()
  @Can('tenant.bank_account.manage')
  @ApiEndpoint({
    id: 'owner.bankAccounts.create',
    summary: 'Add or change a receiving bank account (OTP follows)',
    description:
      'Stores the account `pending_otp` (number sealed with the tenant key) and sends an SMS OTP to the acting Owner’s verified phone (maker-checker by OTP, D-091). Nothing changes for payments until `owner.bankAccounts.confirm` succeeds with that code.',
    implements: ['D-042', 'D-091', 'D-148'],
  })
  @ApiJsonBody(BankAccountCreateDto, {
    bankCode: '004',
    bankNameTh: 'ธนาคารตัวอย่าง',
    accountNo: '000-0-00000-1',
    accountName: FAKE.companyName,
    isDefault: true,
  })
  @ApiSuccess(201, {
    description: 'Pending OTP',
    type: BankAccountRequestedDto,
    example: {
      account: { ...BANK_EXAMPLE, state: 'pending_otp', isDefault: false, confirmedAt: null },
      otp: OTP_EXAMPLE,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'bank_account.owner_phone_missing',
    'auth.otp_rate_limited',
    'provider.unavailable',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: BankAccountCreateDto,
  ): Promise<BankAccountRequestedDto> {
    const r = await this.accounts.request(ctx, body);
    return { account: bankAccountDto(r.account), otp: otpChallengeDto(r.otp) };
  }

  @Post(':bankAccountId/actions/confirm')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.bank_account.manage')
  @ApiEndpoint({
    id: 'owner.bankAccounts.confirm',
    summary: 'Confirm a bank account change with the OTP',
    description:
      'The code sent to the acting Owner activates the account; when it was requested as default it replaces the previous default (history kept, audited `tenant.bank_account.changed`, the Owners are notified).',
    implements: ['D-042', 'D-091'],
  })
  @ApiJsonBody(OtpVerifyDto, { challengeId: FAKE.uuid, code: '123456' })
  @ApiSuccess(200, { description: 'Active', type: BankAccountDto, example: BANK_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'bank_account.invalid_state',
    'bank_account.owner_phone_missing',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async confirm(
    @CurrentTenant() ctx: TenantContext,
    @Param('bankAccountId', ParseUUIDPipe) id: string,
    @Body() body: OtpVerifyDto,
  ): Promise<BankAccountDto> {
    return bankAccountDto(await this.accounts.confirm(ctx, id, body));
  }

  @Post(':bankAccountId/actions/resend-otp')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.bank_account.manage')
  @ApiEndpoint({
    id: 'owner.bankAccounts.resendOtp',
    summary: 'Send a new OTP for a pending bank account',
    description: 'For a `pending_otp` account; the resend interval and hourly cap of SMS OTP apply (D-091).',
    implements: ['D-091'],
  })
  @ApiSuccess(200, { description: 'Code sent', type: OtpChallengeDto, example: OTP_EXAMPLE })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'bank_account.invalid_state',
    'bank_account.owner_phone_missing',
    'auth.otp_rate_limited',
    'provider.unavailable',
    ...TENANT_ERRORS,
  )
  async resend(
    @CurrentTenant() ctx: TenantContext,
    @Param('bankAccountId', ParseUUIDPipe) id: string,
  ): Promise<OtpChallengeDto> {
    return otpChallengeDto(await this.accounts.resendOtp(ctx, id));
  }

  @Post(':bankAccountId/actions/remove')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.bank_account.manage')
  @ApiEndpoint({
    id: 'owner.bankAccounts.remove',
    summary: 'Remove a receiving bank account',
    description: 'The account stops receiving payments (history kept, audited).',
    implements: ['D-042', 'D-091'],
  })
  @ApiSuccess(200, {
    description: 'Removed',
    type: BankAccountDto,
    example: { ...BANK_EXAMPLE, state: 'removed', isDefault: false },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'bank_account.invalid_state',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('bankAccountId', ParseUUIDPipe) id: string,
  ): Promise<BankAccountDto> {
    return bankAccountDto(await this.accounts.remove(ctx, id));
  }
}

const SETTING_EXAMPLE: SettingDto = {
  key: 'reminders.schedule',
  valueType: 'json' as SettingValueTypeName,
  value: [1, 3, 7],
  scope: 'platform' as SettingScopeName,
  effectiveFrom: FAKE.dateTime,
  scopeAllowed: ['platform', 'tenant'] as SettingScopeName[],
  editable: true,
  description: 'D-045: LINE reminders after due date + grace, on these days (default day 1, 3, 7).',
};

@ApiTags('owner.settings')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerSettingsController {
  constructor(
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('settings')
  @TenantScoped()
  @Can('tenant.settings.read')
  @ApiEndpoint({
    id: 'owner.settings.list',
    summary: 'Settings in force for my tenant',
    description:
      'Every setting that may have a tenant (or property) value, with the value in force at `at` and where it comes from (property → tenant → platform, ADR-0004), and whether I may change it (Owner: billing settings; Manager: operational settings, D-090).',
    implements: ['D-090', 'D-144', 'ADR-0004'],
  })
  @ApiSuccess(200, { description: 'Settings', type: [SettingDto], example: [SETTING_EXAMPLE] })
  @ApiStandardErrors('validation.failed', ...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: SettingsQuery): Promise<SettingDto[]> {
    const at = query.at ? new Date(query.at) : this.clock.now();
    const granted = RequestContext.permissions();
    const out: SettingDto[] = [];
    for (const def of this.settings
      .catalogue()
      .filter((d) => d.scopeAllowed.includes('tenant') || d.scopeAllowed.includes('property'))) {
      const value = await this.settings.at(def.key, at, {
        tenantId: ctx.tenantId,
        propertyId: query.propertyId ?? null,
      });
      if (!value) continue;
      out.push({
        key: def.key,
        valueType: def.valueType as SettingValueTypeName,
        value: value.value,
        scope: value.scope as SettingScopeName,
        effectiveFrom: iso(value.effectiveFrom),
        scopeAllowed: def.scopeAllowed as SettingScopeName[],
        editable: def.scopeAllowed.includes('tenant') && def.editableBy.some((p) => granted.has(p)),
        description: def.description,
      });
    }
    return out;
  }

  @Put('settings/:key')
  @TenantScoped()
  @Can('tenant.settings.read')
  @ApiParam({ name: 'key', example: 'reminders.schedule', description: 'Setting key (catalogue).' })
  @ApiEndpoint({
    id: 'owner.settings.update',
    summary: 'Set a tenant value of a setting',
    description:
      'Adds an effective-dated tenant version (never edits one; no backdating, ADR-0004). The editing permission comes from the catalogue (`tenant.settings.update` or `tenant.billing_settings.update`); platform-only keys are refused. Audited and cached values are invalidated through the outbox.',
    implements: ['D-090', 'D-144', 'ADR-0004'],
  })
  @ApiJsonBody(SettingUpdateDto, {
    value: [1, 3, 7],
    effectiveFrom: '2026-12-01T00:00:00+07:00',
    reason: 'ส่งแจ้งเตือนวันที่ 1, 3, 7',
  })
  @ApiSuccess(200, {
    description: 'Version created',
    type: SettingVersionDto,
    example: {
      versionId: FAKE.uuid,
      key: 'reminders.schedule',
      scope: 'tenant',
      effectiveFrom: '2026-12-01T00:00:00+07:00',
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'settings.unknown_key',
    'settings.not_editable',
    'settings.invalid_value',
    'settings.backdated',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('key') key: string,
    @Body() body: SettingUpdateDto,
  ): Promise<SettingVersionDto> {
    const row = await this.settings.setTenant(
      ctx,
      key,
      body.value,
      body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      body.reason,
    );
    return {
      versionId: row.id,
      key,
      scope: 'tenant' as SettingScopeName,
      effectiveFrom: iso(row.effectiveFrom),
    };
  }

  @Put('properties/:propertyId/settings/:key')
  @TenantScoped()
  @Can('tenant.settings.read')
  @ApiParam({ name: 'key', example: 'billing.cutoff', description: 'Setting key (catalogue).' })
  @ApiEndpoint({
    id: 'owner.propertySettings.update',
    summary: 'Set a property value of a setting',
    description:
      'Property overrides (D-031 billing cut-off per property, utility providers, meter health rules): an effective-dated property version; the property must belong to my tenant (404 otherwise).',
    implements: ['D-031', 'D-144', 'ADR-0004'],
  })
  @ApiJsonBody(SettingUpdateDto, {
    value: { day: 'end_of_month', time: '23:59', timezone: 'Asia/Bangkok' },
    reason: 'รอบบิลสิ้นเดือน',
  })
  @ApiSuccess(200, {
    description: 'Version created',
    type: SettingVersionDto,
    example: { versionId: FAKE.uuid, key: 'billing.cutoff', scope: 'property', effectiveFrom: FAKE.dateTime },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'settings.unknown_key',
    'settings.not_editable',
    'settings.invalid_value',
    'settings.backdated',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async updateProperty(
    @CurrentTenant() ctx: TenantContext,
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
    @Param('key') key: string,
    @Body() body: SettingUpdateDto,
  ): Promise<SettingVersionDto> {
    const row = await this.settings.setProperty(
      ctx,
      propertyId,
      key,
      body.value,
      body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      body.reason,
    );
    return {
      versionId: row.id,
      key,
      scope: 'property' as SettingScopeName,
      effectiveFrom: iso(row.effectiveFrom),
    };
  }
}

export function currentTariffDto(t: TariffAt): CurrentTariffDto {
  return {
    tariffId: t.tariff.id,
    utility: t.tariff.utility as UtilityName,
    provider: t.tariff.provider as UtilityProviderName,
    tariffCode: t.tariff.tariffCode,
    nameTh: t.tariff.nameTh,
    versionId: t.version.id,
    effectiveFrom: dateOnly(t.version.effectiveFrom)!,
    effectiveTo: dateOnly(t.version.effectiveTo),
    state: t.version.state as TariffVersionStateName,
    sourceUrl: t.version.sourceUrl,
    ceilingPerUnit: t.version.ceilingPerUnit.toFixed(4),
    capBasis: t.version.capBasis,
    structure: t.structure as unknown as Record<string, unknown>,
    charge: t.charge
      ? {
          units: t.charge.units,
          totalExVat: t.charge.totalExVat,
          effectiveAverageRate: t.charge.effectiveAverageRate,
          minimumApplied: t.charge.minimumApplied,
          lines: t.charge.lines,
        }
      : null,
  };
}

@ApiTags('owner.utilityTariffs')
@ApiSurface(SURFACES.owner)
@Controller('owner/utility-tariffs')
export class OwnerUtilityTariffsController {
  constructor(
    private readonly tariffs: UtilityTariffsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('current')
  @TenantScoped()
  @Can('rate_plan.read')
  @ApiEndpoint({
    id: 'owner.utilityTariffs.current',
    summary: 'Utility tariff in force — the สคบ. 2568 cap reference',
    description:
      'The verified and published MEA/PEA/MWA/PWA tariff version(s) in force on `date` with their structure and, for `units`, the effective average rate per unit excl. VAT computed by the tariff math — the value a tenant rate is compared with (D-021a warning, D-140). 404 `tariff.not_found` when no published version covers the date.',
    implements: ['D-021', 'D-140', 'ADR-0004'],
  })
  @ApiSuccess(200, {
    description: 'Tariffs in force',
    type: [CurrentTariffDto],
    example: [
      {
        tariffId: FAKE.uuid,
        utility: 'electric',
        provider: 'mea',
        tariffCode: '1.1',
        nameTh: 'ประเภท 1.1 บ้านอยู่อาศัย',
        versionId: FAKE.uuid,
        effectiveFrom: '2026-09-01',
        effectiveTo: null,
        state: 'published',
        sourceUrl: 'https://www.mea.or.th/',
        ceilingPerUnit: '4.6189',
        capBasis: 'effective_average_rate',
        structure: { kind: 'tiered', unit: 'kwh', currency: 'THB' },
        charge: {
          units: '150',
          totalExVat: '523.35',
          effectiveAverageRate: '3.4890',
          minimumApplied: false,
          lines: [{ label: '0–150', units: '150', pricePerUnit: '3.2484', amount: '487.26' }],
        },
      },
    ],
  })
  @ApiStandardErrors('validation.failed', 'tariff.not_found', ...TENANT_ERRORS)
  async current(@Query() query: TariffCurrentQuery): Promise<CurrentTariffDto[]> {
    const date = query.date
      ? startOfBangkokDay(query.date.slice(0, 10))
      : startOfBangkokDay(bangkokDate(this.clock.now()));
    const day = new Date(`${bangkokDate(new Date(date.getTime() + 1))}T00:00:00.000Z`);
    const rows = await this.tariffs.current({
      utility: query.utility,
      provider: query.provider,
      tariffCode: query.tariffCode,
      date: day,
      units: query.units,
    });
    return rows.map(currentTariffDto);
  }
}

@ApiTags('owner.complianceAcknowledgements')
@ApiSurface(SURFACES.owner)
@Controller('owner/compliance-acknowledgements')
export class OwnerComplianceAcknowledgementsController {
  constructor(private readonly acks: ComplianceAcknowledgementService) {}

  @Post()
  @TenantScoped()
  @Can('compliance.acknowledge')
  @ApiEndpoint({
    id: 'owner.complianceAcknowledgements.create',
    summary: 'Acknowledge a compliance warning',
    description:
      'After a `409 compliance.acknowledgement_required` (contract §3): records who acknowledged, when, from which IP and user agent, the rule, the values shown and the warning text version (legal-reference §4, D-021a); repeat the original request with the returned id.',
    implements: ['D-021', 'D-149'],
  })
  @ApiJsonBody(AcknowledgementCreateDto, {
    evaluationId: FAKE.uuid,
    legalTextKey: 'compliance.tariff_cap.warning',
    legalTextVersion: 1,
    language: 'th',
  })
  @ApiSuccess(201, {
    description: 'Acknowledged',
    type: AcknowledgementDto,
    example: {
      id: FAKE.uuid,
      ruleId: 'compliance.tariff_cap',
      subjectType: 'ops.rate_plan_version',
      subjectId: FAKE.uuid,
      acknowledgedAt: FAKE.dateTime,
      shown: { tenantRate: '7.0000', capPerUnit: '4.4312' },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'http.conflict',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: AcknowledgementCreateDto,
  ): Promise<AcknowledgementDto> {
    const a = await this.acks.acknowledge(ctx, body);
    return {
      id: a.id,
      ruleId: a.ruleId,
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      acknowledgedAt: iso(a.acknowledgedAt),
      shown: a.shown as Record<string, unknown>,
    };
  }
}
