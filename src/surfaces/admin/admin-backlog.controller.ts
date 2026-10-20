import { Can } from '@common/auth/can.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { DocumentsService } from '@core/documents/documents.service';
import { type IntegrationEvent } from '@generated/prisma/client';
import { IntegrationEventsService } from '@modules/bridge-integrations/integration-events.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { FILE_EXAMPLE, fileDto } from '../shared/files.controller';
import { FileCompleteDto, FileDownloadDto, FileDto, FilePresignedDto } from '../shared/files.dto';
import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  AdminFilePresignDto,
  type IntegrationDirectionName,
  IntegrationEventDto,
  IntegrationEventListQuery,
  type IntegrationStatusName,
  type IntegrationSystemName,
} from './admin.dto';

const PLATFORM_FILE_EXAMPLE = {
  ...FILE_EXAMPLE,
  kind: 'tariff_source',
  scopeType: 'platform',
  scopeId: null,
  buildingId: null,
  title: 'ประกาศ กฟน. อัตรา ก.ย. 2569',
  mimeType: 'application/pdf',
  retentionClass: 'other',
};

/**
 * Platform files (web F5 contract request, D-214): the platform admin uploads the published notice behind a utility
 * tariff version (or a contract / other evidence) — `tenant_id` NULL, scope `platform`, scanned like every upload.
 */
@ApiTags('admin.files')
@ApiSurface(SURFACES.admin)
@Controller('admin/files')
export class AdminFilesController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('presign')
  @Can('admin.utility_tariff.enter')
  @ApiEndpoint({
    id: 'admin.files.presign',
    summary: 'Start a platform file upload',
    description:
      'A platform-scoped file (no tenant): kind `tariff_source` (the utility notice a tariff version cites as `sourceDocumentId`), `contract` or `other`; images or PDF up to the kind’s limit. Returns a 15-minute signed PUT URL; upload, then `complete` (D-214, D-021a).',
    implements: ['D-214', 'D-021', 'D-025'],
  })
  @ApiJsonBody(AdminFilePresignDto, {
    kind: 'tariff_source',
    fileName: 'mea-tariff-2026-09.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 345678,
    sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  })
  @ApiSuccess(201, {
    description: 'Presigned',
    type: FilePresignedDto,
    example: {
      file: PLATFORM_FILE_EXAMPLE,
      uploadUrl: 'https://storage.example.com/upload?X-Amz-Signature=abc',
      headers: { 'Content-Type': 'application/pdf' },
      multipart: null,
      expiresAt: '2026-11-01T00:30:00+07:00',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'document.type_not_allowed')
  async presign(@Body() body: AdminFilePresignDto): Promise<FilePresignedDto> {
    const r = await this.documents.presignPlatform({ ...body, kind: body.kind });
    return {
      file: fileDto(r.document),
      uploadUrl: r.uploadUrl,
      headers: r.headers,
      multipart: r.multipart,
      expiresAt: iso(r.expiresAt),
    };
  }

  @Post(':fileId/actions/complete')
  @HttpCode(200)
  @Can('admin.utility_tariff.enter')
  @ApiEndpoint({
    id: 'admin.files.complete',
    summary: 'Finish a platform file upload',
    description:
      'Checks the stored object (size) and emits `document.uploaded`; the virus scan and sha256 check follow. Repeating it is harmless.',
    implements: ['D-214', 'D-025'],
  })
  @ApiJsonBody(FileCompleteDto, {})
  @ApiSuccess(200, {
    description: 'Uploaded',
    type: FileDto,
    example: { ...PLATFORM_FILE_EXAMPLE, uploadState: 'uploaded' },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'document.not_uploaded',
    'document.size_mismatch',
  )
  async complete(@Param('fileId', ParseUUIDPipe) id: string): Promise<FileDto> {
    return fileDto(await this.documents.completePlatform(id));
  }

  @Get(':fileId')
  @Can('admin.utility_tariff.enter')
  @ApiEndpoint({
    id: 'admin.files.get',
    summary: 'Platform file metadata and a signed download URL',
    description:
      'A 5-minute signed URL of a clean platform file (`409 document.scan_pending` / `document.infected` otherwise); every download is audited. A tenant file is 404 here.',
    implements: ['D-214', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Download',
    type: FileDownloadDto,
    example: {
      file: { ...PLATFORM_FILE_EXAMPLE, scanStatus: 'clean', uploadState: 'verified' },
      url: 'https://storage.example.com/file?X-Amz-Signature=abc',
      thumbnailUrl: null,
      expiresAt: '2026-11-01T00:20:00+07:00',
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'document.not_uploaded',
    'document.scan_pending',
    'document.infected',
  )
  async get(@Param('fileId', ParseUUIDPipe) id: string): Promise<FileDownloadDto> {
    const r = await this.documents.downloadPlatform(id);
    return { file: fileDto(r.document), url: r.url, thumbnailUrl: null, expiresAt: iso(r.expiresAt) };
  }
}

const integrationEventDto = (e: IntegrationEvent): IntegrationEventDto => ({
  id: e.id,
  direction: e.direction as IntegrationDirectionName,
  system: e.platform as IntegrationSystemName,
  type: e.eventType,
  contractVersion: e.contractVersion,
  aggregateRef: e.subjectType && e.subjectId ? `${e.subjectType}:${e.subjectId}` : null,
  tenantId: e.tenantId,
  state: e.status as IntegrationStatusName,
  attempts: e.attempts,
  lastError: e.lastError,
  occurredAt: iso(e.occurredAt),
  ackedAt: isoOrNull(e.ackedAt),
});

/** `bridge.integration_event` for the admin console (web contract request, D-214, D-153). */
@ApiTags('admin.integrationEvents')
@ApiSurface(SURFACES.admin)
@Controller('admin/integration-events')
export class AdminIntegrationEventsController {
  constructor(private readonly events: IntegrationEventsService) {}

  @Get()
  @Can('admin.integration_event.read')
  @ApiEndpoint({
    id: 'admin.integrationEvents.list',
    summary: 'Integration events with getbuild / getpack',
    description:
      'Every event exchanged with getbuild / getpack (D-153), newest first, filtered by state, system, direction, tenant; `q` matches the event type, the idempotency key or the subject id. Payloads are not listed (they may carry encrypted PII).',
    implements: ['D-153', 'D-214'],
  })
  @ApiPaginated(IntegrationEventDto, {
    example: {
      id: FAKE.uuid,
      direction: 'outbound',
      system: 'getbuild',
      type: 'warranty.defect.reported',
      contractVersion: '1.0',
      aggregateRef: `ops.service_request:${FAKE.uuid}`,
      tenantId: FAKE.tenantId,
      state: 'pending',
      attempts: 0,
      lastError: null,
      occurredAt: FAKE.dateTime,
      ackedAt: null,
    },
  })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: IntegrationEventListQuery): Promise<Page<IntegrationEventDto>> {
    const { rows, total } = await this.events.list({
      state: q.state,
      platform: q.system,
      direction: q.direction,
      tenantId: q.tenantId,
      q: q.q,
      ...toSkipTake(q),
    });
    return paginated(rows.map(integrationEventDto), total, q);
  }
}
