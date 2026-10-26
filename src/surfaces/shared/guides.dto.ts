import { FAKE } from '@common/openapi/examples';
import { type Guide } from '@generated/prisma/client';
import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { LanguageName } from './common.dto';
import { iso, isoOrNull } from './mappers';

export enum GuideStateName {
  Draft = 'draft',
  Published = 'published',
}
export enum GuideCategoryName {
  Tax = 'tax',
  Law = 'law',
  Landlord = 'landlord',
  Operations = 'operations',
}
export enum GuideAudienceName {
  Landlord = 'landlord',
  Apartment = 'apartment',
}

const BODY_SCHEMA = {
  sections: {
    type: 'array',
    description:
      'Sections `{ id, heading, blocks }`; a block is one of `{ p }`, `{ ul: [] }`, `{ ol: [] }`, `{ note, tone? (info | warning | product) }`, `{ affiliate: { name, url, merchant, why, imageUrl? } }` (the shared article of D-277).',
    items: { type: 'object', additionalProperties: true },
  },
  faq: {
    type: 'array',
    items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } } },
  },
  sources: {
    type: 'array',
    items: {
      type: 'object',
      properties: { label: { type: 'string' }, url: { type: 'string', format: 'uri' } },
    },
  },
} as const;

const SECTIONS_EXAMPLE = [
  {
    id: 'type',
    heading: 'ค่าเช่าเป็นเงินได้ประเภทไหน',
    blocks: [{ p: 'เงินที่ได้จากการให้เช่าบ้าน คอนโด ห้องพัก เป็นเงินได้ตามมาตรา 40(5)' }],
  },
];

export class GuideSummaryDto {
  @ApiProperty({ example: 'rental-income-tax' })
  slug!: string;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  locale!: LanguageName;

  @ApiProperty({ enum: GuideCategoryName, enumName: 'GuideCategory', example: 'tax' })
  category!: GuideCategoryName;

  @ApiProperty({ enum: GuideAudienceName, enumName: 'GuideAudience', example: 'landlord' })
  audience!: GuideAudienceName;

  @ApiProperty({ example: 'ภาษีค่าเช่าบ้านและคอนโด: ยื่นเมื่อไร หักค่าใช้จ่ายได้เท่าไร' })
  title!: string;

  @ApiProperty({ example: 'รายได้ค่าเช่าเป็นเงินได้ตามมาตรา 40(5) หักค่าใช้จ่ายเหมา 30% หรือตามจริง' })
  summary!: string;

  @ApiProperty({
    example: 'ค่าเช่าบ้านและคอนโดเป็นเงินได้ประเภทที่ 5',
    description: 'The short answer first (AEO).',
  })
  answer!: string;

  @ApiProperty({ example: 6 })
  readMinutes!: number;

  @ApiProperty({
    example: true,
    description: 'Legal or tax content: the page shows "general information, not advice".',
  })
  general!: boolean;

  @ApiProperty({
    format: 'date',
    example: '2026-10-24',
    description: 'The facts were last checked on this day.',
  })
  reviewed!: string;

  @ApiProperty({ format: 'date', example: '2026-10-24' })
  published!: string;
}

export class GuideFaqDto {
  @ApiProperty({ example: 'ปล่อยเช่าคอนโดห้องเดียวต้องยื่นภาษีไหม' })
  q!: string;

  @ApiProperty({ example: 'ต้องนำค่าเช่าไปรวมเป็นเงินได้ตามมาตรา 40(5) ทุกกรณี' })
  a!: string;
}

export class GuideSourceDto {
  @ApiProperty({ example: 'กรมสรรพากร' })
  label!: string;

  @ApiProperty({ example: 'https://www.rd.go.th/' })
  url!: string;
}

export class GuideDetailDto extends GuideSummaryDto {
  @ApiProperty({ ...BODY_SCHEMA.sections, example: SECTIONS_EXAMPLE })
  sections!: Record<string, unknown>[];

  @ApiProperty({ type: [GuideFaqDto] })
  faq!: GuideFaqDto[];

  @ApiProperty({ type: [GuideSourceDto] })
  sources!: GuideSourceDto[];
}

export class PublicGuidesDto {
  @ApiProperty({ type: [GuideSummaryDto] })
  data!: GuideSummaryDto[];
}

export class AdminGuideDto extends GuideDetailDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: GuideStateName, enumName: 'GuideState', example: 'published' })
  state!: GuideStateName;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Who reviewed and published it.',
  })
  reviewedBy!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The last editor.',
  })
  updatedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  publishedAt!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  updatedAt!: string;

  @ApiProperty({ example: 3 })
  version!: number;
}

export class GuideCreateDto {
  @ApiProperty({ example: 'rental-income-tax', pattern: '^[a-z0-9-]{1,80}$' })
  @Matches(/^[a-z0-9-]{1,80}$/)
  slug!: string;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  @IsEnum(LanguageName)
  locale!: LanguageName;

  @ApiProperty({ enum: GuideCategoryName, enumName: 'GuideCategory', example: 'tax' })
  @IsEnum(GuideCategoryName)
  category!: GuideCategoryName;

  @ApiProperty({ enum: GuideAudienceName, enumName: 'GuideAudience', example: 'landlord' })
  @IsEnum(GuideAudienceName)
  audience!: GuideAudienceName;

  @ApiProperty({ maxLength: 120, example: 'ภาษีค่าเช่าบ้านและคอนโด' })
  @IsString()
  @Length(1, 120)
  title!: string;

  @ApiProperty({ maxLength: 200, example: 'รายได้ค่าเช่าเป็นเงินได้ตามมาตรา 40(5)' })
  @IsString()
  @Length(1, 200)
  summary!: string;

  @ApiProperty({ maxLength: 600, example: 'ค่าเช่าบ้านและคอนโดเป็นเงินได้ประเภทที่ 5' })
  @IsString()
  @Length(1, 600)
  answer!: string;

  @ApiProperty({ minimum: 1, maximum: 60, example: 6 })
  @IsInt()
  @Min(1)
  @Max(60)
  readMinutes!: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  general!: boolean;

  @ApiProperty({ format: 'date', example: '2026-10-24' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  reviewed!: string;

  @ApiProperty({ format: 'date', example: '2026-10-24' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  published!: string;

  @ApiProperty({ ...BODY_SCHEMA.sections, example: SECTIONS_EXAMPLE })
  @IsArray()
  sections!: Record<string, unknown>[];

  @ApiProperty({ type: [GuideFaqDto] })
  @IsArray()
  faq!: GuideFaqDto[];

  @ApiProperty({ type: [GuideSourceDto] })
  @IsArray()
  sources!: GuideSourceDto[];
}

export class GuideUpdateDto extends PartialType(OmitType(GuideCreateDto, ['slug', 'locale'] as const)) {}

export class GuideListQuery {
  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language' })
  @IsOptional()
  @IsEnum(LanguageName)
  locale?: LanguageName;

  @ApiPropertyOptional({ enum: GuideStateName, enumName: 'GuideState' })
  @IsOptional()
  @IsEnum(GuideStateName)
  state?: GuideStateName;
}

const DAY = (d: Date) => d.toISOString().slice(0, 10);

export function guideSummaryDto(g: Guide): GuideSummaryDto {
  return {
    slug: g.slug,
    locale: g.locale as LanguageName,
    category: g.category as GuideCategoryName,
    audience: g.audience as GuideAudienceName,
    title: g.title,
    summary: g.summary,
    answer: g.answer,
    readMinutes: g.readMinutes,
    general: g.general,
    reviewed: DAY(g.reviewedOn),
    published: DAY(g.publishedOn),
  };
}

export function guideDetailDto(g: Guide): GuideDetailDto {
  return {
    ...guideSummaryDto(g),
    sections: g.sections as Record<string, unknown>[],
    faq: g.faq as unknown as GuideFaqDto[],
    sources: g.sources as unknown as GuideSourceDto[],
  };
}

export function adminGuideDto(g: Guide): AdminGuideDto {
  return {
    ...guideDetailDto(g),
    id: g.id,
    state: g.state as GuideStateName,
    reviewedBy: g.reviewedBy,
    updatedBy: g.updatedBy,
    publishedAt: isoOrNull(g.publishedAt),
    updatedAt: iso(g.updatedAt),
    version: g.version,
  };
}

export const GUIDE_SUMMARY_EXAMPLE: GuideSummaryDto = {
  slug: 'rental-income-tax',
  locale: LanguageName.Th,
  category: GuideCategoryName.Tax,
  audience: GuideAudienceName.Landlord,
  title: 'ภาษีค่าเช่าบ้านและคอนโด: ยื่นเมื่อไร หักค่าใช้จ่ายได้เท่าไร',
  summary: 'รายได้ค่าเช่าเป็นเงินได้ตามมาตรา 40(5) หักค่าใช้จ่ายเหมา 30% หรือตามจริง',
  answer: 'ค่าเช่าบ้านและคอนโดเป็นเงินได้ประเภทที่ 5 (มาตรา 40(5))',
  readMinutes: 6,
  general: true,
  reviewed: '2026-10-24',
  published: '2026-10-24',
};

export const GUIDE_DETAIL_EXAMPLE: GuideDetailDto = {
  slug: 'rental-income-tax',
  locale: LanguageName.Th,
  category: GuideCategoryName.Tax,
  audience: GuideAudienceName.Landlord,
  title: 'ภาษีค่าเช่าบ้านและคอนโด: ยื่นเมื่อไร หักค่าใช้จ่ายได้เท่าไร',
  summary: 'รายได้ค่าเช่าเป็นเงินได้ตามมาตรา 40(5) หักค่าใช้จ่ายเหมา 30% หรือตามจริง',
  readMinutes: 6,
  general: true,
  reviewed: '2026-10-24',
  published: '2026-10-24',
  answer: 'ค่าเช่าบ้านและคอนโดเป็นเงินได้ประเภทที่ 5 (มาตรา 40(5))',
  sections: SECTIONS_EXAMPLE,
  faq: [{ q: 'ปล่อยเช่าคอนโดห้องเดียวต้องยื่นภาษีไหม', a: 'ต้องนำค่าเช่าไปรวมเป็นเงินได้ตามมาตรา 40(5)' }],
  sources: [{ label: 'กรมสรรพากร', url: 'https://www.rd.go.th/' }],
};

export const ADMIN_GUIDE_EXAMPLE: AdminGuideDto = {
  ...GUIDE_DETAIL_EXAMPLE,
  id: FAKE.uuid,
  state: GuideStateName.Published,
  reviewedBy: FAKE.uuid,
  updatedBy: FAKE.uuid,
  publishedAt: FAKE.dateTime,
  updatedAt: FAKE.dateTime,
  version: 2,
};
