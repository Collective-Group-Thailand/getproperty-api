import { Public } from '@common/auth/auth.decorators';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { toBangkokIso } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { RentRecordService } from '@modules/ops-leases/rent-record.service';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  MyRentRecordDto,
  PublicRentRecordDto,
  RENT_RECORD_EXAMPLE,
  RENT_RECORD_SHARE_EXAMPLE,
  rentRecordDto,
  RentRecordLetterDto,
  RentRecordShareDto,
  rentRecordShareDto,
  RentRecordShareKindName,
  RentRecordShareStateName,
} from './rent-record.dto';

function me(): string {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return actor.publicId;
}

const MINE_EXAMPLE: MyRentRecordDto = { record: RENT_RECORD_EXAMPLE, shares: [RENT_RECORD_SHARE_EXAMPLE] };
const LETTER_EXAMPLE: RentRecordLetterDto = {
  share: {
    ...RENT_RECORD_SHARE_EXAMPLE,
    kind: RentRecordShareKindName.Letter,
    lead: null,
    codeHint: 'K7QX',
    expiresAt: '2027-01-30T09:15:00+07:00',
  },
  code: 'H4N8R2K7QX',
  verifyUrl: 'https://getproperty.co/rent-record/H4N8R2K7QX',
};

const GET_DESCRIPTION =
  'My rent record (D-256): months paid on time, late or still outstanding, from payments getproperty confirmed (gateway or verified slip) — facts, no score — and everything I shared, with its state.';
const LETTER_DESCRIPTION =
  'A letter with a verification code a next landlord can check on getproperty (valid `rent_record.letter.valid_days`). The code is shown once; I can revoke the letter at any time. `rent_record.empty` while no month is confirmed (D-256).';
const REVOKE_DESCRIPTION =
  'Stops sharing at once: the owner no longer sees it on the enquiry, the letter code no longer checks (D-256).';

/** One controller per audience: a person is the same account as resident and as prospect (one LINE account). */
abstract class RentRecordBase {
  constructor(
    protected readonly records: RentRecordService,
    protected readonly config: AppConfig,
  ) {}

  protected share(s: Parameters<typeof rentRecordShareDto>[0]): RentRecordShareDto {
    return rentRecordShareDto(s, this.records.stateOf(s) as RentRecordShareStateName);
  }

  protected async read(): Promise<MyRentRecordDto> {
    const mine = await this.records.mine(me());
    return { record: rentRecordDto(mine.facts), shares: mine.shares.map((s) => this.share(s)) };
  }

  protected async letter(): Promise<RentRecordLetterDto> {
    const { share, code } = await this.records.createLetter(me());
    return {
      share: this.share(share),
      code,
      verifyUrl: `${this.config.get('PUBLIC_WEB_APP_URL')}/rent-record/${code}`,
    };
  }

  protected async stop(shareId: string): Promise<RentRecordShareDto> {
    return this.share(await this.records.revoke(me(), shareId));
  }
}

@ApiTags('resident.rentRecord')
@ApiSurface(SURFACES.resident)
@Controller('resident/me/rent-record')
export class ResidentRentRecordController extends RentRecordBase {
  constructor(records: RentRecordService, config: AppConfig) {
    super(records, config);
  }

  @Get()
  @ApiEndpoint({
    id: 'resident.rentRecord.get',
    summary: 'My rent record',
    description: GET_DESCRIPTION,
    implements: ['D-256'],
  })
  @ApiSuccess(200, { description: 'Record and shares', type: MyRentRecordDto, example: MINE_EXAMPLE })
  @ApiStandardErrors()
  get(): Promise<MyRentRecordDto> {
    return this.read();
  }

  @Post('letters')
  @HttpCode(201)
  @ApiEndpoint({
    id: 'resident.rentRecord.createLetter',
    summary: 'A letter with a verification code',
    description: LETTER_DESCRIPTION,
    implements: ['D-256'],
  })
  @ApiSuccess(201, { description: 'Letter', type: RentRecordLetterDto, example: LETTER_EXAMPLE })
  @ApiStandardErrors('rent_record.empty')
  createLetter(): Promise<RentRecordLetterDto> {
    return this.letter();
  }

  @Post('shares/:shareId/actions/revoke')
  @HttpCode(200)
  @ApiParam({ name: 'shareId', format: 'uuid' })
  @ApiEndpoint({
    id: 'resident.rentRecord.revokeShare',
    summary: 'Stop sharing',
    description: REVOKE_DESCRIPTION,
    implements: ['D-256'],
  })
  @ApiSuccess(200, { description: 'Revoked', type: RentRecordShareDto, example: RENT_RECORD_SHARE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  revoke(@Param('shareId', ParseUUIDPipe) shareId: string): Promise<RentRecordShareDto> {
    return this.stop(shareId);
  }
}

@ApiTags('prospect.rentRecord')
@ApiSurface(SURFACES.prospect)
@Controller('prospect')
export class ProspectRentRecordController extends RentRecordBase {
  constructor(records: RentRecordService, config: AppConfig) {
    super(records, config);
  }

  @Get('me/rent-record')
  @ApiEndpoint({
    id: 'prospect.rentRecord.get',
    summary: 'My rent record',
    description: GET_DESCRIPTION,
    implements: ['D-256'],
  })
  @ApiSuccess(200, { description: 'Record and shares', type: MyRentRecordDto, example: MINE_EXAMPLE })
  @ApiStandardErrors()
  get(): Promise<MyRentRecordDto> {
    return this.read();
  }

  @Post('me/rent-record/letters')
  @HttpCode(201)
  @ApiEndpoint({
    id: 'prospect.rentRecord.createLetter',
    summary: 'A letter with a verification code',
    description: LETTER_DESCRIPTION,
    implements: ['D-256'],
  })
  @ApiSuccess(201, { description: 'Letter', type: RentRecordLetterDto, example: LETTER_EXAMPLE })
  @ApiStandardErrors('rent_record.empty')
  createLetter(): Promise<RentRecordLetterDto> {
    return this.letter();
  }

  @Post('me/rent-record/shares/:shareId/actions/revoke')
  @HttpCode(200)
  @ApiParam({ name: 'shareId', format: 'uuid' })
  @ApiEndpoint({
    id: 'prospect.rentRecord.revokeShare',
    summary: 'Stop sharing',
    description: REVOKE_DESCRIPTION,
    implements: ['D-256'],
  })
  @ApiSuccess(200, { description: 'Revoked', type: RentRecordShareDto, example: RENT_RECORD_SHARE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  revoke(@Param('shareId', ParseUUIDPipe) shareId: string): Promise<RentRecordShareDto> {
    return this.stop(shareId);
  }

  @Post('enquiries/:leadId/rent-record')
  @HttpCode(200)
  @ApiParam({ name: 'leadId', format: 'uuid' })
  @ApiEndpoint({
    id: 'prospect.rentRecord.shareWithEnquiry',
    summary: 'Share my rent record with this enquiry',
    description:
      'The owner of the listing sees my rent record on this enquiry until I revoke it; the same enquiry again answers the live share. Explicit consent per share (PDPA, D-256); `rent_record.empty` while no month is confirmed.',
    implements: ['D-256'],
  })
  @ApiSuccess(200, { description: 'Shared', type: RentRecordShareDto, example: RENT_RECORD_SHARE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'rent_record.empty')
  async shareWithEnquiry(@Param('leadId', ParseUUIDPipe) leadId: string): Promise<RentRecordShareDto> {
    return this.share(await this.records.shareWithLead(me(), leadId));
  }
}

@ApiTags('public.rentRecords')
@ApiSurface(SURFACES.public)
@Controller('public/rent-records')
export class PublicRentRecordsController {
  constructor(private readonly records: RentRecordService) {}

  @Get(':code')
  @Public()
  @ApiParam({ name: 'code', example: 'H4N8R2K7QX', description: 'The letter’s verification code.' })
  @ApiEndpoint({
    id: 'public.rentRecords.get',
    summary: 'Check a rent record letter',
    description:
      'The rent record behind a letter’s verification code while the letter is live — the holder’s name, when it was issued and until when it checks, and the facts (D-256). Revoked, expired or unknown codes are a 404.',
    implements: ['D-256'],
  })
  @ApiSuccess(200, {
    description: 'Record',
    type: PublicRentRecordDto,
    example: {
      holderName: 'สมศรี ใจดี',
      issuedAt: '2026-11-01T09:15:00+07:00',
      expiresAt: '2027-01-30T09:15:00+07:00',
      record: RENT_RECORD_EXAMPLE,
    },
  })
  @ApiStandardErrors('http.not_found')
  async get(@Param('code') code: string): Promise<PublicRentRecordDto> {
    const r = await this.records.byCode(code);
    return {
      holderName: r.holderName,
      issuedAt: toBangkokIso(r.issuedAt),
      expiresAt: toBangkokIso(r.expiresAt),
      record: rentRecordDto(r.facts),
    };
  }
}
