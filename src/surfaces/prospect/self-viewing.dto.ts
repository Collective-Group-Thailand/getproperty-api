import { FAKE } from '@common/openapi/examples';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

import { LockScopeName } from '../owner/access.dto';

/** G7 (D-295): the visitor terms in force (draft wording pending legal review, O-024). */
export class VisitorTermsDto {
  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'Send it back as `visitorTermsVersion` when booking.',
  })
  version!: number;

  @ApiProperty({ example: 'ร่างเงื่อนไขผู้เข้าชม (รอตรวจทางกฎหมาย): …' })
  th!: string;

  @ApiProperty({ example: 'Draft visitor terms (pending legal review): …' })
  en!: string;
}

/** `GET /v1/prospect/me/self-viewing`. */
export class SelfViewingStatusDto {
  @ApiProperty({
    example: true,
    description: 'Self-viewing is switched on platform-wide (`viewing.self.enabled`; a tenant may differ).',
  })
  enabled!: boolean;

  @ApiProperty({ example: true, description: 'My identity is verified (e-KYC, D-267).' })
  identityVerified!: boolean;

  @ApiProperty({ example: false, description: 'My account has a verified phone.' })
  phoneVerified!: boolean;

  @ApiProperty({
    type: [String],
    example: ['phone', 'terms'],
    description:
      'What I still need before booking a self viewing: `identity`, `phone`; `terms` is always listed — accept the terms below with each booking.',
  })
  missing!: string[];

  @ApiProperty({ type: () => VisitorTermsDto })
  visitorTerms!: VisitorTermsDto;

  @ApiProperty({
    type: 'integer',
    example: 30,
    description: '`viewing.self.code_minutes` (platform default).',
  })
  codeMinutes!: number;

  @ApiProperty({
    type: 'integer',
    example: 5,
    description: '`viewing.self.code_early_minutes` (platform default).',
  })
  earlyMinutes!: number;
}

export class SelfViewingLockDto {
  @ApiProperty({ example: 'ประตูห้อง A-102' })
  name!: string;

  @ApiProperty({ enum: LockScopeName, enumName: 'LockScope', example: 'unit' })
  scope!: LockScopeName;

  @ApiProperty({ example: true, description: 'The vendor confirmed the code on this lock.' })
  ready!: boolean;
}

/** `GET /v1/prospect/viewings/{id}/access-code` — only inside the window, never cached. */
export class ViewingAccessCodeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  viewingId!: string;

  @ApiProperty({
    example: '482913',
    description: 'The keypad code (same on the unit lock and the building doors).',
  })
  doorCode!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-07T09:55:00+07:00' })
  validFrom!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-07T10:30:00+07:00' })
  validTo!: string;

  @ApiProperty({ type: [SelfViewingLockDto] })
  locks!: SelfViewingLockDto[];
}

export class IncidentReportDto {
  @ApiProperty({
    example: 'ก๊อกน้ำในห้องน้ำรั่ว น้ำนองพื้น',
    minLength: 3,
    maxLength: 2000,
    description: 'What is wrong at the unit (damage, a door that does not lock, someone inside).',
  })
  @IsString()
  @Length(3, 2000)
  note!: string;
}

export class ProspectPhoneDto {
  @ApiProperty({ example: '08•-•••-1234', description: 'My verified phone, masked.' })
  phoneMasked!: string;

  @ApiProperty({ example: true })
  phoneVerified!: boolean;
}
