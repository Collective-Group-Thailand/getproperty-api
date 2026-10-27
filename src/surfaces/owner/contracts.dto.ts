import { ProblemFieldError } from '@common/errors/problem-details.dto';
import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { LanguageName } from '../shared/common.dto';
import { MoneyInput, MoneyOutput } from '../shared/fields';
import { ComplianceSeverityName } from './leases.dto';

export enum ContractKindName {
  LeaseApartmentOcpb = 'lease_apartment_ocpb',
  LeaseCondoPrivate = 'lease_condo_private',
  LeaseHouse = 'lease_house',
  LeaseRoom = 'lease_room',
  Reservation = 'reservation',
  BrokerageMandate = 'brokerage_mandate',
  CoBroke = 'co_broke',
  Addendum = 'addendum',
  NoticeTermination = 'notice_termination',
  NoticeRenewal = 'notice_renewal',
}
export enum SignableContractKindName {
  Reservation = 'reservation',
  BrokerageMandate = 'brokerage_mandate',
  CoBroke = 'co_broke',
  Addendum = 'addendum',
}
export enum LegalReviewStateName {
  PendingLegalVerification = 'pending_legal_verification',
  Reviewed = 'reviewed',
}
export enum TemplateStateName {
  Draft = 'draft',
  Published = 'published',
  Retired = 'retired',
}
export enum ContractDocumentStateName {
  Draft = 'draft',
  PendingSignature = 'pending_signature',
  Signed = 'signed',
  Cancelled = 'cancelled',
}
export enum ContractSignerRoleName {
  Lessor = 'lessor',
  Lessee = 'lessee',
  CoTenant = 'co_tenant',
  Prospect = 'prospect',
  Owner = 'owner',
  Agency = 'agency',
  CoAgency = 'co_agency',
}
export enum ClauseStatusName {
  Unchanged = 'unchanged',
  Changed = 'changed',
  Added = 'added',
  Removed = 'removed',
}
export enum ClauseFindingSourceName {
  RemovedProtection = 'removed_protection',
  AddedWording = 'added_wording',
}
export enum RenewalOfferStateName {
  Offered = 'offered',
  Accepted = 'accepted',
  Declined = 'declined',
  Expired = 'expired',
  Withdrawn = 'withdrawn',
}
export enum RenewalRentSourceName {
  Benchmark = 'benchmark',
  Comparables = 'comparables',
  CurrentRent = 'current_rent',
}

const SHA = /^[0-9a-fA-F]{64}$/;
const CONTRACT_SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export class DisclaimerDto {
  @ApiProperty({ example: 'ตัวอย่างสัญญาเพื่ออำนวยความสะดวก ไม่ใช่คำแนะนำทางกฎหมาย' })
  th!: string;

  @ApiProperty({ example: 'A sample contract provided for convenience; not legal advice.' })
  en!: string;

  @ApiProperty({
    example: 'contract.library.disclaimer',
    description: 'The platform setting the text comes from (edited by the platform admin, D-290).',
  })
  settingKey!: string;
}

// ------------------------------------------------------------------------------------------------- library

export class ContractTemplateVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  language!: LanguageName;

  @ApiProperty({
    enum: TemplateStateName,
    enumName: 'TemplateVersionState',
    example: TemplateStateName.Published,
  })
  state!: TemplateStateName;

  @ApiProperty({
    enum: LegalReviewStateName,
    enumName: 'LegalReviewState',
    example: LegalReviewStateName.PendingLegalVerification,
    description: 'Every draft is `pending_legal_verification` until counsel signs this version off (O-025).',
  })
  legalReviewState!: LegalReviewStateName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  legalReviewedAt!: string | null;

  @ApiProperty({ format: 'date', example: FAKE.date })
  effectiveFrom!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  publishedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The library version this text was copied from (D-294).',
  })
  derivedFromVersionId!: string | null;

  @ApiProperty({ example: '⚖ ร่างโดยระบบ รอการตรวจสอบทางกฎหมาย (O-025)' })
  legalRef!: string;
}

export class ContractTemplateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'library_reservation' })
  key!: string;

  @ApiProperty({ example: 'สัญญาจองห้องเช่า (ร่างจากคลังสัญญา)' })
  name!: string;

  @ApiProperty({ enum: ContractKindName, enumName: 'ContractKind', example: ContractKindName.Reservation })
  kind!: ContractKindName;

  @ApiProperty({ example: true, description: 'A platform draft (read-only; copy it to edit).' })
  platform!: boolean;

  @ApiProperty({ type: [ContractTemplateVersionDto] })
  versions!: ContractTemplateVersionDto[];
}

export class ContractLibraryDto {
  @ApiProperty({
    type: DisclaimerDto,
    description: 'Shown with every draft (`contract.library.disclaimer`, D-290).',
  })
  disclaimer!: DisclaimerDto;

  @ApiProperty({ type: [ContractTemplateDto] })
  data!: ContractTemplateDto[];
}

export class ContractLibraryQuery {
  @ApiPropertyOptional({ enum: ContractKindName, enumName: 'ContractKind' })
  @IsOptional()
  @IsEnum(ContractKindName)
  kind?: ContractKindName;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language' })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;
}

export class ContractTemplateDetailDto extends ContractTemplateDto {
  @ApiProperty({
    type: ContractTemplateVersionDto,
    description: 'The version shown: the open draft, else the latest published.',
  })
  current!: ContractTemplateVersionDto;

  @ApiProperty({ example: '<article class="contract"><section><h2>คู่สัญญา</h2>…</section></article>' })
  bodyHtml!: string;

  @ApiProperty({
    type: ContractTemplateVersionDto,
    nullable: true,
    description: 'The library version this template was copied from.',
  })
  base!: ContractTemplateVersionDto | null;

  @ApiProperty({
    type: [String],
    example: ['premises.unitNo', 'reservation.fee'],
    description:
      'Variables a text of this kind may use; anything else is refused (`contract.unknown_variable`).',
  })
  variables!: string[];

  @ApiProperty({ type: DisclaimerDto })
  disclaimer!: DisclaimerDto;
}

export class ContractTemplateCopyDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'A published version to copy (platform or own).',
  })
  @IsUUID()
  derivedFromVersionId!: string;

  @ApiPropertyOptional({ example: 'สัญญาจองของบ้านมาลี' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}

export class ContractTemplateUpdateDto {
  @ApiPropertyOptional({ example: 'สัญญาจองของบ้านมาลี' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    example:
      '<article class="contract"><section><h2>คู่สัญญา</h2><p>{{lessor.legalName}}</p></section></article>',
    description:
      'The Handlebars text: allowed HTML only (no script, style, links, handlers), variables of the kind, if / unless / each / with. Editing a published template opens its next draft version.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  bodyHtml?: string;
}

export class ClauseDiffDto {
  @ApiProperty({
    example: 'เงินจอง',
    description: 'Normalised heading of the clause (`_frame` = text outside sections).',
  })
  key!: string;

  @ApiProperty({ example: 'เงินจอง' })
  title!: string;

  @ApiProperty({ enum: ClauseStatusName, enumName: 'ClauseStatus', example: ClauseStatusName.Changed })
  status!: ClauseStatusName;

  @ApiProperty({ type: String, nullable: true, example: 'ผู้จองชำระเงินจองจำนวน 5,000.00 บาท' })
  baseText!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ผู้จองชำระเงินจองจำนวน 3,000.00 บาท' })
  text!: string | null;
}

export class ContractTemplateDiffDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  versionId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  baseVersionId!: string | null;

  @ApiProperty({ type: [ClauseDiffDto] })
  clauses!: ClauseDiffDto[];
}

export class ClauseFindingDto {
  @ApiProperty({ example: 'renewal_fee', description: 'Forbidden clause type of the announcement (D-020).' })
  clauseType!: string;

  @ApiProperty({ example: 'ข้อ ๑๒ ข้อปฏิบัติของผู้ให้เช่า' })
  clauseKey!: string;

  @ApiProperty({ example: 'ข้อ ๑๒ ข้อปฏิบัติของผู้ให้เช่า' })
  clauseTitle!: string;

  @ApiProperty({
    enum: ClauseFindingSourceName,
    enumName: 'ClauseFindingSource',
    example: ClauseFindingSourceName.AddedWording,
  })
  source!: ClauseFindingSourceName;

  @ApiProperty({ example: 'ค่าต่อสัญญา' })
  excerpt!: string;

  @ApiProperty({ example: 'ประกาศคณะกรรมการว่าด้วยสัญญา … พ.ศ. 2568 ข้อ 5 (11) ⚖' })
  legalRef!: string;

  @ApiProperty({
    enum: ComplianceSeverityName,
    enumName: 'ComplianceSeverity',
    example: ComplianceSeverityName.Block,
    description: '`block` inside the สคบ. 2568 scope (D-158), else `warn`.',
  })
  severity!: ComplianceSeverityName;
}

export class ContractTemplateCheckDto {
  @ApiProperty({ example: true, description: 'The tenant is in scope of the announcement (D-158).' })
  inScope!: boolean;

  @ApiProperty({ type: [ProblemFieldError] })
  problems!: ProblemFieldError[];

  @ApiProperty({ type: [String], example: [] })
  unknownVariables!: string[];

  @ApiProperty({ type: [ClauseFindingDto] })
  findings!: ClauseFindingDto[];

  @ApiProperty({ example: true })
  publishable!: boolean;
}

export class ContractTemplatePublishedDto extends ContractTemplateDetailDto {
  @ApiProperty({ type: ContractTemplateCheckDto, description: 'Warnings (outside the scope) stay visible.' })
  check!: ContractTemplateCheckDto;
}

export class LegalReviewUpdateDto {
  @ApiProperty({
    enum: LegalReviewStateName,
    enumName: 'LegalReviewState',
    example: LegalReviewStateName.Reviewed,
  })
  @IsEnum(LegalReviewStateName)
  state!: LegalReviewStateName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ตรวจโดยสำนักงานกฎหมาย … 2026-12-01' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class AdminContractLibraryDto {
  @ApiProperty({ type: [ContractTemplateDto] })
  data!: ContractTemplateDto[];
}

// ------------------------------------------------------------------------------------------------- documents

export class ClauseInputDto {
  @ApiProperty({ example: 'สัตว์เลี้ยง', maxLength: 200 })
  title!: string;

  @ApiProperty({ example: 'อนุญาตแมวได้ 1 ตัว', maxLength: 2000 })
  text!: string;
}

/** The values a user may type per kind (D-294); any other key is refused (`contract.unknown_variable`). */
export class ContractVariablesDto {
  @ApiPropertyOptional({
    example: '5000.00',
    description: 'reservation: reservation fee (THB, decimal string).',
  })
  fee?: string;

  @ApiPropertyOptional({
    example: '15000.00',
    description: 'reservation: monthly rent (default the unit’s base rent).',
  })
  rent?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-12-01', description: 'reservation: move-in date.' })
  moveInDate?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-11-15', description: 'reservation: held until.' })
  expiresOn?: string;

  @ApiPropertyOptional({
    example: 'คืนเต็มจำนวนหากผู้ให้เช่าไม่ทำสัญญา',
    description: 'reservation: extra refund terms.',
  })
  refundTerms?: string;

  @ApiPropertyOptional({
    example: 'แบ่งค่านายหน้า 60/40',
    description: 'brokerage_mandate / co_broke: further terms.',
  })
  note?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-01',
    description: 'addendum: effective date (default today).',
  })
  effectiveDate?: string;

  @ApiPropertyOptional({ type: [ClauseInputDto], description: 'addendum: 1–20 added clauses.' })
  clauses?: ClauseInputDto[];
}

export class ContractCreateDto {
  @ApiProperty({ enum: SignableContractKindName, enumName: 'SignableContractKind', example: 'reservation' })
  @IsEnum(SignableContractKindName)
  kind!: SignableContractKindName;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A published version of this kind (own or platform); default the platform draft in `language`.',
  })
  @IsOptional()
  @IsUUID()
  templateVersionId?: string;

  @ApiPropertyOptional({ example: 'สัญญาจองห้อง A-101' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'addendum: the lease.' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'reservation: the unit.' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'reservation: the person reserving (a party of the tenant).',
  })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'co_broke: the agreement (the listing agency writes it).',
  })
  @IsOptional()
  @IsUUID()
  coBrokeAgreementId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'brokerage_mandate: the mandate (the owner writes it).',
  })
  @IsOptional()
  @IsUUID()
  mandateId?: string;

  @ApiPropertyOptional({
    type: ContractVariablesDto,
    description:
      'Values typed by the user; everything else is filled from the unit, lease, mandate or agreement. Unknown keys → `contract.unknown_variable`.',
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;
}

export class ContractListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: SignableContractKindName, enumName: 'SignableContractKind' })
  @IsOptional()
  @IsEnum(SignableContractKindName)
  kind?: SignableContractKindName;

  @ApiPropertyOptional({ enum: ContractDocumentStateName, enumName: 'ContractDocumentState' })
  @IsOptional()
  @IsEnum(ContractDocumentStateName)
  state?: ContractDocumentStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;
}

export class ContractSignerDto {
  @ApiProperty({ example: 0 })
  index!: number;

  @ApiProperty({
    enum: ContractSignerRoleName,
    enumName: 'ContractSignerRole',
    example: ContractSignerRoleName.Lessor,
  })
  role!: ContractSignerRoleName;

  @ApiProperty({ example: 'มาลี มีสุข' })
  name!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  partyId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  tenantId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  signedAt!: string | null;
}

export class ContractDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: SignableContractKindName, enumName: 'SignableContractKind', example: 'reservation' })
  kind!: SignableContractKindName;

  @ApiProperty({ example: 'สัญญาจองห้องเช่า (ร่างจากคลังสัญญา) A-101' })
  title!: string;

  @ApiProperty({ type: String, nullable: true, example: 'CTR-2026-00002' })
  number!: string | null;

  @ApiProperty({
    enum: ContractDocumentStateName,
    enumName: 'ContractDocumentState',
    example: 'pending_signature',
  })
  state!: ContractDocumentStateName;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  language!: LanguageName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The pinned template version.' })
  templateVersionId!: string;

  @ApiProperty({ example: 'library_reservation' })
  templateKey!: string;

  @ApiProperty({ example: 1 })
  templateVersion!: number;

  @ApiProperty({
    enum: LegalReviewStateName,
    enumName: 'LegalReviewState',
    example: 'pending_legal_verification',
  })
  legalReviewState!: LegalReviewStateName;

  @ApiProperty({ type: DisclaimerDto })
  disclaimer!: DisclaimerDto;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  leaseId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  coBrokeAgreementId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  mandateId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  counterpartyTenantId!: string | null;

  @ApiProperty({ type: [ContractSignerDto] })
  signers!: ContractSignerDto[];

  @ApiProperty({ type: ContractVariablesDto, description: 'The values typed when it was drafted.' })
  variables!: Record<string, unknown>;

  @ApiProperty({
    type: String,
    nullable: true,
    example: CONTRACT_SHA,
    description: 'sha256 of the PDF to sign.',
  })
  sha256!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  sentAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  signedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ type: [String], example: ['sign', 'download'] })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ContractsDto {
  @ApiProperty({ type: [ContractDto] })
  data!: ContractDto[];
}

export class ContractOperatorSignDto {
  @ApiProperty({ example: CONTRACT_SHA, description: 'sha256 of the contract PDF read (from `…/document`).' })
  @Matches(SHA)
  contractSha256!: string;

  @ApiProperty({ example: PNG_BASE64, description: 'Drawn signature, base64 PNG ≤ 200 KB.' })
  @IsString()
  @IsBase64()
  @MaxLength(280_000)
  signaturePng!: string;
}

// ------------------------------------------------------------------------------------------------- renewals

export class RentSuggestionDto {
  @ApiProperty({ enum: RenewalRentSourceName, enumName: 'RenewalRentSource', example: 'benchmark' })
  source!: RenewalRentSourceName;

  @MoneyOutput({ example: '15500.00', description: 'Suggested monthly rent.' })
  rent!: string;

  @ApiProperty({ example: 'rent_per_m2 p50 516.67 × 30.00 m² (k = 7, 2026-10-26)' })
  basis!: string;
}

export class RenewalSuggestionDto {
  @MoneyOutput({ example: '15000.00', description: 'Current monthly rent.' })
  currentRent!: string;

  @ApiProperty({ type: RentSuggestionDto, description: 'The first available of the candidates.' })
  suggested!: RentSuggestionDto;

  @ApiProperty({ type: [RentSuggestionDto] })
  candidates!: RentSuggestionDto[];
}

export class RenewalOfferCreateDto {
  @MoneyInput({ example: '15500.00', description: 'Offered rent (default the suggestion).', optional: true })
  rent?: string;

  @ApiPropertyOptional({
    example: 12,
    description: 'Term of the renewal in months (default the current term).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  months?: number;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language' })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ขอบคุณที่ดูแลห้องอย่างดีค่ะ' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string | null;
}

export class RenewalOfferQuery {
  @ApiPropertyOptional({ enum: RenewalOfferStateName, enumName: 'RenewalOfferState' })
  @IsOptional()
  @IsEnum(RenewalOfferStateName)
  state?: RenewalOfferStateName;
}

export class RenewalOfferDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The B7.5 letter.',
  })
  noticeId!: string | null;

  @MoneyOutput({ example: '15000.00', description: 'Rent when offered.' })
  currentRent!: string;

  @MoneyOutput({ example: '15500.00', description: 'The suggestion shown to the owner.', nullable: true })
  suggestedRent!: string | null;

  @ApiProperty({ enum: RenewalRentSourceName, enumName: 'RenewalRentSource', example: 'benchmark' })
  suggestionSource!: RenewalRentSourceName;

  @MoneyOutput({ example: '15500.00', description: 'Offered monthly rent.' })
  offeredRent!: string;

  @ApiProperty({ example: 12 })
  months!: number;

  @ApiProperty({ format: 'date', example: '2027-10-01' })
  startDate!: string;

  @ApiProperty({ format: 'date', example: '2027-08-15' })
  respondBy!: string;

  @ApiProperty({ enum: RenewalOfferStateName, enumName: 'RenewalOfferState', example: 'offered' })
  state!: RenewalOfferStateName;

  @ApiProperty({ type: String, nullable: true, example: null })
  message!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The renewal lease.',
  })
  newLeaseId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  declineReason!: string | null;

  @ApiProperty({ type: [String], example: ['accept', 'decline'] })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class RenewalOffersDto {
  @ApiProperty({ type: [RenewalOfferDto] })
  data!: RenewalOfferDto[];
}
