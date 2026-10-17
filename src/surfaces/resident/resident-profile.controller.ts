import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { TopicPreferencesService } from '@core/notifications/topic-preferences.service';
import { ResidentDocumentsService } from '@modules/ops-parties/resident-documents.service';
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  NotificationPreferencesDto,
  NotificationPreferencesUpdateDto,
  NotificationTopicName,
  ResidentDocumentDownloadDto,
  ResidentDocumentDto,
  ResidentDocumentKindName,
} from './resident-profile.dto';

const PREFERENCES_EXAMPLE: NotificationPreferencesDto = {
  items: [
    { topic: NotificationTopicName.Billing, line: true, sms: true, locked: true },
    { topic: NotificationTopicName.Lease, line: true, sms: true, locked: true },
    { topic: NotificationTopicName.ServiceRequests, line: true, sms: false, locked: false },
    { topic: NotificationTopicName.Announcements, line: true, sms: false, locked: false },
    { topic: NotificationTopicName.Parcels, line: true, sms: true, locked: false },
  ],
};

@ApiTags('resident.notificationPreferences')
@ApiSurface(SURFACES.resident)
@Controller('resident/me/notification-preferences')
export class ResidentNotificationPreferencesController {
  constructor(private readonly preferences: TopicPreferencesService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.notificationPreferences.get',
    summary: 'My notification preferences',
    description:
      'LINE and SMS per topic for my login (every tenant I am linked to). Topics are on unless I switched them off; `billing` and `lease` are `locked` — invoices, receipts, reminders and lease / deposit notices always reach me (D-042, D-061). PDPA consent still gates every message (D-025).',
    implements: ['D-025', 'D-063', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Preferences',
    type: NotificationPreferencesDto,
    example: PREFERENCES_EXAMPLE,
  })
  @ApiStandardErrors('auth.unauthenticated')
  async get(): Promise<NotificationPreferencesDto> {
    return { items: (await this.preferences.list()) as NotificationPreferencesDto['items'] };
  }

  @Put()
  @ApiEndpoint({
    id: 'resident.notificationPreferences.update',
    summary: 'Change my notification preferences',
    description:
      'Sets LINE / SMS per topic (topics not listed keep their value). Switching off a locked topic (`billing`, `lease`) is refused with 422 `validation.failed`. Audited (`notification.preferences_changed`).',
    implements: ['D-025', 'D-063', 'D-203'],
  })
  @ApiJsonBody(NotificationPreferencesUpdateDto, {
    items: [{ topic: 'announcements', line: true, sms: false }],
  })
  @ApiSuccess(200, {
    description: 'Preferences',
    type: NotificationPreferencesDto,
    example: PREFERENCES_EXAMPLE,
  })
  @ApiStandardErrors('auth.unauthenticated', 'validation.failed', 'http.bad_request')
  async update(@Body() body: NotificationPreferencesUpdateDto): Promise<NotificationPreferencesDto> {
    return {
      items: (await this.preferences.update(body.items)) as NotificationPreferencesDto['items'],
    };
  }
}

const DOCUMENT_EXAMPLE: ResidentDocumentDto = {
  id: FAKE.uuid,
  kind: ResidentDocumentKindName.LeaseContract,
  title: 'สัญญาเช่า CTR-2026-00001 ห้อง A-201',
  createdAt: FAKE.dateTime,
  leaseId: FAKE.uuid,
};

@ApiTags('resident.documents')
@ApiSurface(SURFACES.resident)
@Controller('resident/documents')
export class ResidentDocumentsController {
  constructor(private readonly documents: ResidentDocumentsService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.documents.list',
    summary: 'Documents on file for me',
    description:
      'View only, newest first: the contract of each lease I can open (the signed copy once countersigned), lease notice evidence, deposit receipts and settlement statements, and the receipts issued to me — across the tenants my login is linked to (D-063, D-203).',
    implements: ['D-063', 'D-203'],
  })
  @ApiSuccess(200, { description: 'Documents', type: [ResidentDocumentDto], example: [DOCUMENT_EXAMPLE] })
  @ApiStandardErrors('auth.unauthenticated')
  async list(): Promise<ResidentDocumentDto[]> {
    return (await this.documents.list()).map((d) => ({
      id: d.documentId,
      kind: d.kind as ResidentDocumentKindName,
      title: d.title,
      createdAt: iso(d.createdAt),
      leaseId: d.leaseId,
    }));
  }

  @Get(':documentId/download')
  @ApiEndpoint({
    id: 'resident.documents.download',
    summary: 'Open one of my documents',
    description:
      'A 5-minute signed URL of a document from my list; every download is audited (`document.downloaded`, D-025). 404 for any other document.',
    implements: ['D-025', 'D-063', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Download',
    type: ResidentDocumentDownloadDto,
    example: {
      id: FAKE.uuid,
      title: 'สัญญาเช่า CTR-2026-00001 ห้อง A-201',
      url: 'https://storage.example.com/contract.pdf?X-Amz-Signature=abc',
      expiresAt: '2026-11-01T00:20:00+07:00',
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'document.scan_pending')
  async download(
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<ResidentDocumentDownloadDto> {
    const r = await this.documents.download(documentId);
    return { id: documentId, title: r.entry.title, url: r.url, expiresAt: iso(r.expiresAt) };
  }
}
