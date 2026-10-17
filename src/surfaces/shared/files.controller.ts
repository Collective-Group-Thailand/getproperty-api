import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { DocumentsService } from '@core/documents/documents.service';
import { type Document } from '@generated/prisma/client';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, type Surface } from '../surfaces';
import {
  type DocumentScanStatusName,
  type DocumentScopeName,
  type DocumentUploadStateName,
  FileCompleteDto,
  FileDownloadDto,
  FileDownloadQuery,
  FileDto,
  FilePresignDto,
  FilePresignedDto,
} from './files.dto';
import { iso } from './mappers';
import { DocumentKindName } from './status.enums';

export function fileDto(d: Document): FileDto {
  return {
    id: d.id,
    kind: d.kind as DocumentKindName,
    scopeType: d.scopeType as DocumentScopeName,
    scopeId: d.scopeId,
    buildingId: d.buildingId,
    title: d.title,
    mimeType: d.mimeType,
    sizeBytes: Number(d.sizeBytes),
    width: d.width,
    height: d.height,
    retentionClass: d.retentionClass,
    scanStatus: d.scanStatus as DocumentScanStatusName,
    uploadState: d.uploadState as DocumentUploadStateName,
    createdAt: iso(d.createdAt),
  };
}

export const FILE_EXAMPLE = {
  id: FAKE.uuid,
  kind: 'meter_photo',
  scopeType: 'unit',
  scopeId: FAKE.uuid,
  buildingId: FAKE.buildingId,
  title: 'มิเตอร์ห้อง A-201',
  mimeType: 'image/jpeg',
  sizeBytes: 2345678,
  width: null,
  height: null,
  retentionClass: 'meter_photo',
  scanStatus: 'pending',
  uploadState: 'presigned',
  createdAt: FAKE.dateTime,
};
const TENANT_ERRORS = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

/**
 * `/v1/{owner,staff}/files` (contract §3 "Files"): presign → upload to object storage → complete → scan → signed
 * download. Storage keys are generated server-side under the tenant; Staff are limited to their buildings; a file of
 * another tenant (or outside the Staff building scope) is a 404.
 */
export function filesController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.files`)
  @ApiSurface(surface)
  @Controller(`${surface}/files`)
  class FilesController {
    constructor(readonly documents: DocumentsService) {}

    @Post('presign')
    @TenantScoped()
    @Can('document.upload')
    @ApiEndpoint({
      id: `${surface}.files.presign`,
      summary: 'Start a file upload',
      description:
        'Creates the file record and returns a 15-minute signed PUT URL (or multipart part URLs above 50 MB). Kind decides accepted types, size limit and retention class (D-025). Upload, then call `complete`.',
      implements: ['D-025', 'D-035'],
    })
    @ApiJsonBody(FilePresignDto, {
      kind: 'meter_photo',
      scopeType: 'unit',
      scopeId: FAKE.uuid,
      fileName: 'meter-A-201.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2345678,
      sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    })
    @ApiSuccess(201, {
      description: 'Presigned',
      type: FilePresignedDto,
      example: {
        file: FILE_EXAMPLE,
        uploadUrl: 'https://storage.example.com/upload?X-Amz-Signature=abc',
        headers: { 'Content-Type': 'image/jpeg' },
        multipart: null,
        expiresAt: '2026-11-01T00:30:00+07:00',
      },
    })
    @ApiStandardErrors(
      'validation.failed',
      'http.bad_request',
      'http.not_found',
      'document.type_not_allowed',
      'auth.forbidden',
      'tenant.read_only',
      ...TENANT_ERRORS,
    )
    async presign(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: FilePresignDto,
    ): Promise<FilePresignedDto> {
      const r = await this.documents.presign(ctx, { ...body, scopeId: body.scopeId ?? null });
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
    @TenantScoped()
    @Can('document.upload')
    @ApiEndpoint({
      id: `${surface}.files.complete`,
      summary: 'Finish a file upload',
      description:
        'Checks the stored object (size), completes a multipart upload, emits `document.uploaded`; virus scan, sha256 check and thumbnail follow asynchronously. Repeating it is harmless.',
      implements: ['D-025'],
    })
    @ApiJsonBody(FileCompleteDto, {})
    @ApiSuccess(200, {
      description: 'Uploaded',
      type: FileDto,
      example: { ...FILE_EXAMPLE, uploadState: 'uploaded' },
    })
    @ApiStandardErrors(
      'validation.failed',
      'http.not_found',
      'document.not_uploaded',
      'document.size_mismatch',
      ...TENANT_ERRORS,
    )
    async complete(
      @CurrentTenant() ctx: TenantContext,
      @Param('fileId', ParseUUIDPipe) id: string,
      @Body() body: FileCompleteDto,
    ): Promise<FileDto> {
      return fileDto(await this.documents.complete(ctx, id, body));
    }

    @Get(':fileId')
    @TenantScoped()
    @Can('document.read')
    @ApiEndpoint({
      id: `${surface}.files.get`,
      summary: 'File metadata and a signed download URL',
      description:
        'A 5-minute signed URL for clean files only (`409 document.scan_pending` / `document.infected` otherwise); downloads of ID documents, slips and contracts are audited (D-025).',
      implements: ['D-025'],
    })
    @ApiSuccess(200, {
      description: 'Download',
      type: FileDownloadDto,
      example: {
        file: { ...FILE_EXAMPLE, scanStatus: 'clean', uploadState: 'verified' },
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
      ...TENANT_ERRORS,
    )
    async get(
      @CurrentTenant() ctx: TenantContext,
      @Param('fileId', ParseUUIDPipe) id: string,
      @Query() query: FileDownloadQuery,
    ): Promise<FileDownloadDto> {
      const r = await this.documents.download(ctx, id, query.purpose ?? null);
      return {
        file: fileDto(r.document),
        url: r.url,
        thumbnailUrl: r.thumbnailUrl,
        expiresAt: iso(r.expiresAt),
      };
    }
  }
  Object.defineProperty(FilesController, 'name', {
    value: `${surface.charAt(0).toUpperCase()}${surface.slice(1)}FilesController`,
  });
  return FilesController;
}
