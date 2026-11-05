import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { toBangkokIso } from '@common/time/bangkok';
import { DebtClearancesService } from '@modules/ops-juristic/debt-clearances.service';
import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import { VerifiedDocumentDto, type VerifiedDocumentStatusName } from '../owner/juristic-collections.dto';
import { ApiSurface, SURFACES } from '../surfaces';

@ApiTags('public.documents')
@ApiSurface(SURFACES.public)
@Controller('public/documents')
export class PublicDocumentsController {
  constructor(private readonly clearances: DebtClearancesService) {}

  @Get('verify/:code')
  @Public()
  @Header('Cache-Control', 'no-store')
  @ApiParam({
    name: 'code',
    example: 'H4N8R2K7QX',
    description: 'The verification code printed (and in the QR) on the document.',
  })
  @ApiEndpoint({
    id: 'public.documents.verify',
    summary: 'Check a document by its verification code',
    description:
      'Anyone holding a document issued through getproperty (today: a debt clearance certificate, หนังสือรับรองการปลอดหนี้) checks it is genuine: document type, number, status (`valid` until `validUntil`, else `expired`), issue date, the day it speaks for, the issuer and the unit number — the holder only as **initials** (PDPA, D-025). Unknown or refused codes are a 404. Anonymous, not cached (D-306, D-325).',
    implements: ['D-025', 'D-306', 'D-325'],
  })
  @ApiSuccess(200, {
    description: 'Document',
    type: VerifiedDocumentDto,
    example: {
      documentType: 'debt_clearance',
      number: 'DCL-2027-00001',
      status: 'valid' as VerifiedDocumentStatusName,
      issuedAt: '2027-03-15T10:00:00+07:00',
      validUntil: '2027-04-14',
      asOf: '2027-03-15',
      issuer: 'นิติบุคคลอาคารชุด ตัวอย่าง',
      unitNo: 'A-1204',
      holderInitials: 'ส. จ.',
    },
  })
  @ApiStandardErrors('http.not_found')
  async verify(@Param('code') code: string): Promise<VerifiedDocumentDto> {
    const v = await this.clearances.verify(code.slice(0, 40));
    return {
      documentType: v.documentType,
      number: v.number,
      status: v.status as VerifiedDocumentStatusName,
      issuedAt: toBangkokIso(v.issuedAt),
      validUntil: v.validUntil,
      asOf: v.asOf,
      issuer: v.issuer,
      unitNo: v.unitNo,
      holderInitials: v.holderInitials,
    };
  }
}
