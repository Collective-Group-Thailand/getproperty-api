import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { OtpChallengeDto } from '../shared/auth.dto';

/** Schema of a setting value: any JSON (the catalogue validates it per key). */
export const ANY_JSON = [
  { type: 'object', additionalProperties: true },
  { type: 'array', items: {} },
  { type: 'string' },
  { type: 'number' },
  { type: 'boolean' },
];

export enum BankAccountStateName {
  PendingOtp = 'pending_otp',
  Active = 'active',
  Replaced = 'replaced',
  Removed = 'removed',
}

export enum PaymentProviderName {
  Kbank = 'kbank',
  Scb = 'scb',
  Opn = 'opn',
  None = 'none',
}

export enum PromptpayIdTypeName {
  NationalId = 'national_id',
  TaxId = 'tax_id',
  Phone = 'phone',
  Ewallet = 'ewallet',
  BankAccount = 'bank_account',
}

export enum SettingScopeName {
  Platform = 'platform',
  Tenant = 'tenant',
  Property = 'property',
}

export enum SettingValueTypeName {
  String = 'string',
  Int = 'int',
  Decimal = 'decimal',
  Bool = 'bool',
  Json = 'json',
  Duration = 'duration',
  Money = 'money',
  Date = 'date',
  Time = 'time',
}

export enum UtilityName {
  Electric = 'electric',
  Water = 'water',
}

export enum UtilityProviderName {
  Mea = 'mea',
  Pea = 'pea',
  Mwa = 'mwa',
  Pwa = 'pwa',
}

export enum TariffVersionStateName {
  Draft = 'draft',
  Entered = 'entered',
  Verified = 'verified',
  Published = 'published',
  Superseded = 'superseded',
}

export class BankAccountDto {
  @ApiProperty({
    type: [String],
    example: ['remove'],
    description: 'Actions (`…/actions/{name}`) the caller may take now — never infer them from the status.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: '004', description: 'Bank of Thailand 3-digit bank code.' })
  bankCode!: string;

  @ApiProperty({ example: 'ธนาคารตัวอย่าง' })
  bankNameTh!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  branch!: string | null;

  @ApiProperty({
    example: 'xxxxxx1234',
    description: 'Masked; the full number is encrypted with the tenant key (D-148).',
  })
  accountNoMasked!: string;

  @ApiProperty({ example: FAKE.companyName })
  accountName!: string;

  @ApiProperty({ enum: PaymentProviderName, enumName: 'PaymentProvider', example: PaymentProviderName.None })
  paymentProvider!: PaymentProviderName;

  @ApiProperty({ type: [String], example: [], description: '[] = every building.' })
  buildingIds!: string[];

  @ApiProperty({ example: true })
  isDefault!: boolean;

  @ApiProperty({
    enum: BankAccountStateName,
    enumName: 'BankAccountState',
    example: BankAccountStateName.Active,
  })
  state!: BankAccountStateName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  confirmedAt!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class BankAccountCreateDto {
  @ApiProperty({ example: '004' })
  @IsString()
  @Matches(/^\d{3}$/)
  bankCode!: string;

  @ApiProperty({ example: 'ธนาคารตัวอย่าง' })
  @IsString()
  @Length(1, 100)
  bankNameTh!: string;

  @ApiPropertyOptional({ example: 'สาขาตัวอย่าง' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branch?: string;

  @ApiProperty({
    example: '000-0-00000-1',
    description: 'Digits only are kept; never logged or returned in clear.',
  })
  @IsString()
  @Length(6, 30)
  accountNo!: string;

  @ApiProperty({ example: FAKE.companyName })
  @IsString()
  @Length(1, 200)
  accountName!: string;

  @ApiPropertyOptional({
    enum: PromptpayIdTypeName,
    enumName: 'PromptpayIdType',
    example: PromptpayIdTypeName.TaxId,
  })
  @IsOptional()
  @IsEnum(PromptpayIdTypeName)
  promptpayIdType?: PromptpayIdTypeName;

  @ApiPropertyOptional({ example: FAKE.taxId })
  @IsOptional()
  @IsString()
  @Length(5, 30)
  promptpayId?: string;

  @ApiPropertyOptional({
    enum: PaymentProviderName,
    enumName: 'PaymentProvider',
    example: PaymentProviderName.None,
  })
  @IsOptional()
  @IsEnum(PaymentProviderName)
  paymentProvider?: PaymentProviderName;

  @ApiPropertyOptional({
    example: '010555012345601',
    maxLength: 64,
    description:
      'Merchant / biller id of this account at the payment provider (Thai QR per invoice, D-042); stored sealed. Required for QR payments when `paymentProvider` is not `none`.',
  })
  @IsOptional()
  @IsString()
  @Length(3, 64)
  providerMerchantRef?: string;

  @ApiPropertyOptional({ type: [String], example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  buildingIds?: string[];

  @ApiProperty({ example: true, description: 'Becomes the default receiving account once confirmed.' })
  @IsBoolean()
  isDefault!: boolean;
}

export class BankAccountRequestedDto {
  @ApiProperty({ type: () => BankAccountDto })
  account!: BankAccountDto;

  @ApiProperty({
    type: () => OtpChallengeDto,
    description: 'OTP sent to the acting Owner’s verified phone (D-091).',
  })
  otp!: OtpChallengeDto;
}

export class SettingDto {
  @ApiProperty({ example: 'reminders.schedule' })
  key!: string;

  @ApiProperty({
    enum: SettingValueTypeName,
    enumName: 'SettingValueType',
    example: SettingValueTypeName.Json,
  })
  valueType!: SettingValueTypeName;

  @ApiProperty({
    oneOf: ANY_JSON,
    example: [1, 3, 7],
    description: 'JSON value of the type.',
  })
  value!: unknown;

  @ApiProperty({
    enum: SettingScopeName,
    enumName: 'SettingScope',
    example: SettingScopeName.Tenant,
    description: 'Where the value in force comes from.',
  })
  scope!: SettingScopeName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  effectiveFrom!: string;

  @ApiProperty({
    enum: SettingScopeName,
    enumName: 'SettingScope',
    isArray: true,
    example: ['platform', 'tenant'],
  })
  scopeAllowed!: SettingScopeName[];

  @ApiProperty({ example: true, description: 'The current user may set a tenant value.' })
  editable!: boolean;

  @ApiProperty({
    example: 'D-045: LINE reminders after due date + grace, on these days (default day 1, 3, 7).',
  })
  description!: string;
}

export class SettingUpdateDto {
  @ApiProperty({
    oneOf: ANY_JSON,
    example: [1, 3, 7],
    description: 'JSON value matching the setting type.',
  })
  @IsDefined()
  value!: unknown;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-12-01T00:00:00+07:00',
    description: 'Now or future (no backdating).',
  })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiProperty({ example: 'ส่งแจ้งเตือนวันที่ 1, 3, 7 หลังครบกำหนด' })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class SettingVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  versionId!: string;

  @ApiProperty({ example: 'reminders.schedule' })
  key!: string;

  @ApiProperty({ enum: SettingScopeName, enumName: 'SettingScope', example: SettingScopeName.Tenant })
  scope!: SettingScopeName;

  @ApiProperty({ format: 'date-time', example: '2026-12-01T00:00:00+07:00' })
  effectiveFrom!: string;
}

export class SettingHistoryQuery {
  @ApiPropertyOptional({
    format: 'uuid',
    example: FAKE.propertyId,
    description: 'Only this property’s overrides (default: every property of my tenant).',
  })
  @IsOptional()
  @IsUUID()
  propertyId?: string;
}

export class SettingHistoryEntryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  versionId!: string;

  @ApiProperty({ enum: SettingScopeName, enumName: 'SettingScope', example: SettingScopeName.Tenant })
  scope!: SettingScopeName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  propertyId!: string | null;

  @ApiProperty({ oneOf: ANY_JSON, example: [1, 3, 7], description: 'The value (JSON) of this version.' })
  value!: unknown;

  @ApiProperty({ format: 'date-time', example: '2026-12-01T00:00:00+07:00' })
  effectiveFrom!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  effectiveTo!: string | null;

  @ApiProperty({ example: true, description: 'Effective in the future (not in force yet).' })
  scheduled!: boolean;

  @ApiProperty({ example: 'ส่งแจ้งเตือนวันที่ 1, 3, 7' })
  reason!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  createdBy!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class SettingsQuery {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'Values in force at this instant (default now).',
  })
  @IsOptional()
  @IsDateString()
  at?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: FAKE.propertyId,
    description: 'Include property overrides.',
  })
  @IsOptional()
  @IsUUID()
  propertyId?: string;
}

export class TariffCurrentQuery {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  @IsEnum(UtilityProviderName)
  provider!: UtilityProviderName;

  @ApiPropertyOptional({ example: '1.1', description: 'Customer class; all classes when omitted.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tariffCode?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: FAKE.date,
    description: 'Default today (Asia/Bangkok).',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({
    example: '150.000',
    description: 'Units consumed: returns the effective average rate for them (D-140).',
  })
  @IsOptional()
  @Matches(/^\d{1,9}(\.\d{1,3})?$/)
  units?: string;
}

export class TariffChargeLineDto {
  @ApiProperty({ example: '0–150' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: '150' })
  units!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '3.2484' })
  pricePerUnit!: string | null;

  @ApiProperty({ example: '487.26', description: 'Unit: THB (exact, before rounding)' })
  amount!: string;
}

export class TariffChargeDto {
  @ApiProperty({ example: '150' })
  units!: string;

  @ApiProperty({ example: '487.26', description: 'Unit: THB' })
  totalExVat!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '3.4890',
    description:
      'Effective average rate per unit excl. VAT — the cap compared with a tenant rate (D-140, D-021a).',
  })
  effectiveAverageRate!: string | null;

  @ApiProperty({ example: false })
  minimumApplied!: boolean;

  @ApiProperty({ type: () => [TariffChargeLineDto] })
  lines!: TariffChargeLineDto[];
}

export class CurrentTariffDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  tariffId!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  provider!: UtilityProviderName;

  @ApiProperty({ example: '1.1' })
  tariffCode!: string;

  @ApiProperty({ example: 'ประเภท 1.1 บ้านอยู่อาศัย' })
  nameTh!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  versionId!: string;

  @ApiProperty({ format: 'date', example: '2026-09-01' })
  effectiveFrom!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  effectiveTo!: string | null;

  @ApiProperty({
    enum: TariffVersionStateName,
    enumName: 'TariffVersionState',
    example: TariffVersionStateName.Published,
  })
  state!: TariffVersionStateName;

  @ApiProperty({ example: 'https://www.mea.or.th/', description: 'Published source of the rates.' })
  sourceUrl!: string;

  @ApiProperty({ example: '4.6189', description: 'Highest marginal rate + Ft excl. VAT (UI hint only).' })
  ceilingPerUnit!: string;

  @ApiProperty({ example: 'effective_average_rate', description: 'D-140' })
  capBasis!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      kind: 'tiered',
      unit: 'kwh',
      currency: 'THB',
      tiers: [{ fromUnits: '0', toUnits: '150', pricePerUnit: '3.2484' }],
    },
    description: 'schema-design §4.2.1 structure: tiers | flat | tou, Ft, service charge, minimum, VAT.',
  })
  structure!: Record<string, unknown>;

  @ApiProperty({
    type: () => TariffChargeDto,
    nullable: true,
    description: 'Present when `units` was given.',
  })
  charge!: TariffChargeDto | null;
}

export class AcknowledgementCreateDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'From the `compliance.acknowledgement_required` problem.',
  })
  @IsUUID()
  evaluationId!: string;

  @ApiProperty({ example: 'compliance.tariff_cap.warning' })
  @IsString()
  @MaxLength(100)
  legalTextKey!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  @IsInt()
  @Min(1)
  legalTextVersion!: number;

  @ApiProperty({ example: 'th' })
  @IsIn(['th', 'en'])
  language!: string;
}

export class AcknowledgementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'Send it with the repeated request.' })
  id!: string;

  @ApiProperty({ example: 'compliance.tariff_cap' })
  ruleId!: string;

  @ApiProperty({ example: 'ops.rate_plan_version' })
  subjectType!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  subjectId!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  acknowledgedAt!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { tenantRate: '7.0000', capPerUnit: '4.4312' },
  })
  shown!: Record<string, unknown>;
}
