import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { type CsatStatus, CsatSurveyService } from '@modules/platform-analytics/csat-survey.service';
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

export class CsatSurveyQuery {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'One of my units.' })
  @IsUUID()
  unitId!: string;
}

export class CsatAnswerDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, example: 'แจ้งซ่อมได้เร็วดี' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null;
}

export class CsatQuestionDto {
  @ApiProperty({ example: 'โดยรวมแล้ว คุณพึงพอใจกับการอยู่อาศัยและบริการของอาคารนี้มากน้อยเพียงใด' })
  th!: string;

  @ApiProperty({ example: 'Overall, how satisfied are you with living here and the building’s service?' })
  en!: string;
}

export class CsatSurveyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: true, description: 'Show the survey now.' })
  due!: boolean;

  @ApiProperty({ example: 'csat.overall_v1' })
  questionKey!: string;

  @ApiProperty({ type: () => CsatQuestionDto })
  question!: CsatQuestionDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  lastAnsweredAt!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  nextDueOn!: string | null;
}

const dto = (s: CsatStatus): CsatSurveyDto => ({
  unitId: s.unitId,
  due: s.due,
  questionKey: s.questionKey,
  question: s.question,
  lastAnsweredAt: isoOrNull(s.lastAnsweredAt),
  nextDueOn: s.nextDueOn,
});

const EXAMPLE = {
  unitId: FAKE.uuid,
  due: true,
  questionKey: 'csat.overall_v1',
  question: {
    th: 'โดยรวมแล้ว คุณพึงพอใจกับการอยู่อาศัยและบริการของอาคารนี้มากน้อยเพียงใด',
    en: 'Overall, how satisfied are you with living here and the building’s service?',
  },
  lastAnsweredAt: null,
  nextDueOn: null,
};

/** The periodic 1-question satisfaction survey in the LIFF (B6.3, D-083 CSAT, D-217). */
@ApiTags('resident.surveys')
@ApiSurface(SURFACES.resident)
@Controller('resident/surveys/csat')
export class ResidentCsatSurveyController {
  constructor(private readonly survey: CsatSurveyService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.surveys.csat',
    summary: 'Is the satisfaction survey due?',
    description:
      'For one of my units: whether to show the 1-question survey now (I have not answered it for `analytics.csat_survey_interval_days`, 90) and the question in Thai and English (D-083, D-217). 404 outside my units.',
    implements: ['D-083', 'D-217'],
  })
  @ApiSuccess(200, { description: 'Survey state', type: CsatSurveyDto, example: EXAMPLE })
  @ApiStandardErrors('auth.unauthenticated', 'validation.failed', 'http.not_found')
  async status(@Query() q: CsatSurveyQuery): Promise<CsatSurveyDto> {
    return dto(await this.survey.status(q.unitId));
  }

  @Post()
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.surveys.csatAnswer',
    summary: 'Answer the satisfaction survey',
    description:
      'A 1–5 rating with an optional comment, counted in the building’s CSAT with the repair ratings (D-083). 409 `csat.not_due` when I answered within the interval.',
    implements: ['D-083', 'D-217'],
  })
  @ApiJsonBody(CsatAnswerDto, { unitId: FAKE.uuid, rating: 4, comment: 'แจ้งซ่อมได้เร็วดี' })
  @ApiSuccess(200, {
    description: 'Recorded',
    type: CsatSurveyDto,
    example: { ...EXAMPLE, due: false, lastAnsweredAt: FAKE.dateTime, nextDueOn: '2027-02-01' },
  })
  @ApiStandardErrors(
    'auth.unauthenticated',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'csat.not_due',
  )
  async answer(@Body() body: CsatAnswerDto): Promise<CsatSurveyDto> {
    return dto(await this.survey.answer(body.unitId, body.rating, body.comment ?? null));
  }
}
