import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { LanguageName } from '../shared/common.dto';
import { MoneyOutput } from '../shared/fields';

// ------------------------------------------------------------------------------------------- enums

/** `juristic.payment_plan_state` (D-325). */
export enum PaymentPlanStateName {
  Proposed = 'proposed',
  Active = 'active',
  Completed = 'completed',
  Defaulted = 'defaulted',
  Cancelled = 'cancelled',
  Rejected = 'rejected',
}

/** `juristic.plan_proposer`. */
export enum PlanProposerName {
  Staff = 'staff',
  Resident = 'resident',
}

/** `juristic.instalment_state`. */
export enum InstalmentStateName {
  Scheduled = 'scheduled',
  Billed = 'billed',
  Paid = 'paid',
  Cancelled = 'cancelled',
}

/** `juristic.debt_clearance_state` (D-306). */
export enum DebtClearanceStateName {
  Requested = 'requested',
  Issued = 'issued',
  Refused = 'refused',
}

/** `juristic.request_channel`. */
export enum RequestChannelName {
  Liff = 'liff',
  Web = 'web',
}

/** `ops.payment_mandate_state` (D-308). */
export enum PaymentMandateStateName {
  Pending = 'pending',
  Active = 'active',
  Revoked = 'revoked',
  Failed = 'failed',
}

/** `ops.payment_mandate_method`. */
export enum PaymentMandateMethodName {
  DirectDebit = 'direct_debit',
  CardToken = 'card_token',
}

/** `ops.payment_mandate_scope`. */
export enum PaymentMandateScopeName {
  AdvanceInvoices = 'advance_invoices',
  AllInvoices = 'all_invoices',
}

/** Kinds of document the public verification page checks. */
export enum VerifiedDocumentTypeName {
  DebtClearance = 'debt_clearance',
}

/** Status of a document on the public verification page. */
export enum VerifiedDocumentStatusName {
  Valid = 'valid',
  Expired = 'expired',
}

// ------------------------------------------------------------------------------------------- payment plans

export class PaymentPlanInstalmentDto {
  @ApiProperty({ type: 'integer', example: 1 })
  seq!: number;

  @ApiProperty({ format: 'date', example: '2027-02-01' })
  dueOn!: string;

  @MoneyOutput({ example: '3333.33', description: 'The instalment (Σ instalments = the principal).' })
  amount!: string;

  @ApiProperty({
    enum: InstalmentStateName,
    enumName: 'InstalmentState',
    example: InstalmentStateName.Scheduled,
  })
  state!: InstalmentStateName;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The invoice charge (line kind `plan_instalment`) once queued for its monthly cycle.',
  })
  invoiceChargeId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  paidAt!: string | null;
}

export class PaymentPlanDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  partyName!: string;

  @ApiProperty({
    enum: PaymentPlanStateName,
    enumName: 'PaymentPlanState',
    example: PaymentPlanStateName.Active,
  })
  state!: PaymentPlanStateName;

  @ApiProperty({ enum: PlanProposerName, enumName: 'PlanProposer', example: PlanProposerName.Resident })
  proposedBy!: PlanProposerName;

  @ApiProperty({ type: 'integer', example: 3 })
  instalmentCount!: number;

  @ApiProperty({ format: 'date', example: '2027-02-01' })
  firstDueOn!: string;

  @MoneyOutput({
    example: '10000.00',
    description: 'Open balances when the plan was proposed (information).',
  })
  proposedPrincipal!: string;

  @MoneyOutput({
    example: '10000.00',
    nullable: true,
    description:
      'Open balances at approval, credited on the covered invoices and split into the instalments.',
  })
  principal!: string | null;

  @ApiProperty({ type: [String], example: [FAKE.uuid], description: 'Invoices the plan covers.' })
  invoiceIds!: string[];

  @ApiProperty({ type: [String], example: [FAKE.uuid], description: 'Credit notes (reason `payment_plan`).' })
  creditNoteIds!: string[];

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 30,
    description: 'Days after an instalment invoice’s due date before the plan defaults (snapshot).',
  })
  defaultAfterDays!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'ขอผ่อน 3 งวด' })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  decidedReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  approvedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  endedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Defaulted / cancelled while active: the charge carrying the rest of the principal.',
  })
  acceleratedChargeId!: string | null;

  @ApiProperty({ type: [PaymentPlanInstalmentDto] })
  instalments!: PaymentPlanInstalmentDto[];

  @ApiProperty({
    type: [String],
    example: ['cancel'],
    description:
      '`approve`, `reject`, `cancel` (owner) · `withdraw` (resident) — what the caller may do now.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;
}

export class PaymentPlanRequestDto {
  @ApiProperty({
    type: 'integer',
    minimum: 2,
    example: 3,
    description: 'Monthly instalments (≤ `juristic.plan_max_instalments`).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(60)
  instalments!: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2027-02-01',
    description: 'Due date of the first instalment (default: the 1st of next month; at most 3 months ahead).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  firstDueOn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, example: 'ขอผ่อน 3 งวด' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class PaymentPlanCreateDto extends PaymentPlanRequestDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The billed party (co-owner, payer or lessee).',
  })
  @IsUUID()
  partyId!: string;
}

export class PaymentPlanListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PaymentPlanStateName, enumName: 'PaymentPlanState' })
  @IsOptional()
  @IsEnum(PaymentPlanStateName)
  state?: PaymentPlanStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;
}

// ------------------------------------------------------------------------------------------- debt clearance

export class DebtClearanceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  partyName!: string;

  @ApiProperty({ enum: RequestChannelName, enumName: 'RequestChannel', example: RequestChannelName.Liff })
  requestedVia!: RequestChannelName;

  @ApiProperty({ format: 'date', example: '2027-03-15', description: 'The day the certificate speaks for.' })
  asOf!: string;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  language!: string;

  @ApiProperty({
    enum: DebtClearanceStateName,
    enumName: 'DebtClearanceState',
    example: DebtClearanceStateName.Issued,
  })
  state!: DebtClearanceStateName;

  @MoneyOutput({ example: '0.00', description: 'Fee of the certificate (`juristic.debt_clearance.fee`).' })
  fee!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'DCL-2027-00001',
    description: 'Gapless number (series DCL).',
  })
  number!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  documentId!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-04-14' })
  validUntil!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'H4N8R2K7QX',
    description:
      'The verification code (also in the PDF’s QR) — returned **only** by the response that issued the certificate; only its hash is stored.',
  })
  verifyCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'R7QX',
    description: 'Last 4 characters of the code.',
  })
  verifyCodeHint!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  issuedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  refuseReason!: string | null;

  @ApiProperty({ type: [String], example: [], description: '`issue`, `refuse` (owner, while requested).' })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class DebtClearanceRequestDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2027-03-15',
    description:
      'The day the certificate speaks for (e.g. the transfer date): today … +60 days; default today.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  asOf?: string | null;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', nullable: true, example: LanguageName.Th })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: 'th' | 'en' | null;
}

export class DebtClearanceCreateDto extends DebtClearanceRequestDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A co-owner of the unit today.' })
  @IsUUID()
  partyId!: string;
}

export class DebtClearanceListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: DebtClearanceStateName, enumName: 'DebtClearanceState' })
  @IsOptional()
  @IsEnum(DebtClearanceStateName)
  state?: DebtClearanceStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class VerifiedDocumentDto {
  @ApiProperty({
    enum: VerifiedDocumentTypeName,
    enumName: 'VerifiedDocumentType',
    example: VerifiedDocumentTypeName.DebtClearance,
  })
  documentType!: 'debt_clearance';

  @ApiProperty({ example: 'DCL-2027-00001' })
  number!: string;

  @ApiProperty({
    enum: VerifiedDocumentStatusName,
    enumName: 'VerifiedDocumentStatus',
    example: VerifiedDocumentStatusName.Valid,
  })
  status!: VerifiedDocumentStatusName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ format: 'date', example: '2027-04-14' })
  validUntil!: string;

  @ApiProperty({ format: 'date', example: '2027-03-15', description: 'The day the certificate speaks for.' })
  asOf!: string;

  @ApiProperty({
    example: 'นิติบุคคลอาคารชุด ตัวอย่าง',
    description: 'The issuing juristic person (display name).',
  })
  issuer!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ example: 'ส. จ.', description: 'The holder’s initials only (PDPA, D-025).' })
  holderInitials!: string;
}

// ------------------------------------------------------------------------------------------- mandates

export class PaymentMandateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({
    example: FAKE.nameTh,
    description: 'Whose mandate it is: the party’s display name (J-CR, D-335).',
  })
  partyName!: string;

  @ApiProperty({ example: 'fake' })
  provider!: string;

  @ApiProperty({
    enum: PaymentMandateMethodName,
    enumName: 'PaymentMandateMethod',
    example: PaymentMandateMethodName.DirectDebit,
  })
  method!: PaymentMandateMethodName;

  @ApiProperty({
    enum: PaymentMandateScopeName,
    enumName: 'PaymentMandateScope',
    example: PaymentMandateScopeName.AdvanceInvoices,
    description:
      '`advance_invoices`: quarterly / semiannual / annual invoices only; `all_invoices`: every invoice.',
  })
  scope!: PaymentMandateScopeName;

  @ApiProperty({
    enum: PaymentMandateStateName,
    enumName: 'PaymentMandateState',
    example: PaymentMandateStateName.Active,
  })
  state!: PaymentMandateStateName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'xxx-x-x1234-x',
    description: 'Masked account / card.',
  })
  masked!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  activatedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  endedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  endReason!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class PaymentMandateCreateDto {
  @ApiProperty({ enum: PaymentMandateMethodName, enumName: 'PaymentMandateMethod' })
  @IsEnum(PaymentMandateMethodName)
  method!: PaymentMandateMethodName;

  @ApiPropertyOptional({ enum: PaymentMandateScopeName, enumName: 'PaymentMandateScope', nullable: true })
  @IsOptional()
  @IsEnum(PaymentMandateScopeName)
  scope?: PaymentMandateScopeName | null;
}

export class PaymentMandateCreatedDto {
  @ApiProperty({ type: PaymentMandateDto })
  mandate!: PaymentMandateDto;

  @ApiProperty({
    example: 'https://provider.example/mandates/abc',
    description:
      'Open it to authorise the debit / card at the provider; the mandate becomes active on its webhook.',
  })
  setupUrl!: string;
}

export class PaymentMandateListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PaymentMandateStateName, enumName: 'PaymentMandateState' })
  @IsOptional()
  @IsEnum(PaymentMandateStateName)
  state?: PaymentMandateStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

/** What a resident's payment-plan request may ask (J-CR, D-335). */
export class PaymentPlanOptionsDto {
  @ApiProperty({ type: 'integer', example: 2 }) minInstalments!: number;
  @ApiProperty({ type: 'integer', example: 12, description: '`juristic.plan_max_instalments`.' })
  maxInstalments!: number;
  @ApiProperty({ format: 'date', example: '2027-01-15' }) earliestFirstDueOn!: string;
  @ApiProperty({ format: 'date', example: '2027-04-17' }) latestFirstDueOn!: string;
  @ApiProperty({ format: 'date', example: '2027-02-01', description: 'The 1st of next month.' })
  defaultFirstDueOn!: string;
  @MoneyOutput({
    example: '10000.00',
    description: 'What would be split now (open balance of my billed party).',
  })
  proposedPrincipal!: string;
  @ApiProperty({ example: true, description: 'Something can be split now.' })
  available!: boolean;
}
