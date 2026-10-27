import { Can } from '@common/auth/can.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ContractLibraryService } from '@modules/ops-leases/contract-library.service';
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { templateDto, templateVersionDto } from '../owner/contracts.controller';
import {
  AdminContractLibraryDto,
  type ContractKindName,
  ContractTemplateVersionDto,
  LegalReviewUpdateDto,
} from '../owner/contracts.dto';
import { type LanguageName } from '../shared/common.dto';
import { ApiSurface, SURFACES } from '../surfaces';

const VERSION = {
  id: FAKE.uuid,
  version: 1,
  language: 'th' as LanguageName,
  state: 'published',
  legalReviewState: 'pending_legal_verification',
  legalReviewedAt: null,
  effectiveFrom: FAKE.date,
  publishedAt: FAKE.dateTime,
  derivedFromVersionId: null,
  legalRef: '⚖ ร่างโดยระบบ รอการตรวจสอบทางกฎหมาย (O-025)',
};

/**
 * Contract library — platform side (G3, D-294, O-025): the platform drafts with their legal-review state; counsel's
 * sign-off is recorded on a published version without changing its text.
 */
@ApiTags('admin.contractLibrary')
@ApiSurface(SURFACES.admin)
@Controller('admin/contract-library')
export class AdminContractLibraryController {
  constructor(private readonly library: ContractLibraryService) {}

  @Get()
  @Can('admin.compliance.manage')
  @ApiEndpoint({
    id: 'admin.contractLibrary.list',
    summary: 'Platform contract drafts',
    description:
      'Every platform template of the library (lease kinds, reservation, brokerage mandate, co-broke, addendum, notice texts; th / en) with each version’s legal-review state (D-290, D-294, O-025).',
    implements: ['D-290', 'D-294'],
  })
  @ApiSuccess(200, {
    description: 'Library',
    type: AdminContractLibraryDto,
    example: {
      data: [
        {
          id: FAKE.uuid,
          key: 'library_reservation',
          name: 'สัญญาจองห้องเช่า (ร่างจากคลังสัญญา)',
          kind: 'reservation' as ContractKindName,
          platform: true,
          versions: [VERSION],
        },
      ],
    },
  })
  @ApiStandardErrors('auth.unauthenticated', 'auth.forbidden')
  async list(): Promise<AdminContractLibraryDto> {
    return { data: (await this.library.adminLibrary()).map(templateDto) };
  }

  @Put('versions/:versionId/legal-review')
  @Can('admin.compliance.manage')
  @ApiEndpoint({
    id: 'admin.contractLibrary.setLegalReview',
    summary: 'Record the legal review of a draft',
    description:
      'Marks a published (or retired) platform version `reviewed` once counsel signed it off — with who, when and a note — or back to `pending_legal_verification`; the text never changes (a new text is a new version). Audited (O-025, D-294).',
    implements: ['D-294'],
  })
  @ApiJsonBody(LegalReviewUpdateDto, { state: 'reviewed', note: 'ตรวจโดยสำนักงานกฎหมาย … 2026-12-01' })
  @ApiSuccess(200, {
    description: 'Recorded',
    type: ContractTemplateVersionDto,
    example: { ...VERSION, legalReviewState: 'reviewed', legalReviewedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'contract.invalid_state',
    'auth.forbidden',
  )
  async review(
    @Param('versionId', ParseUUIDPipe) id: string,
    @Body() body: LegalReviewUpdateDto,
  ): Promise<ContractTemplateVersionDto> {
    return templateVersionDto(await this.library.setReview(id, body));
  }
}
