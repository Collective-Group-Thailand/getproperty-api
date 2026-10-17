import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { resolveLanguage } from '@common/i18n/language';
import {
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { PartiesService, type PartyRow } from '@modules/ops-parties/parties.service';
import { ResidentPrivacyService } from '@modules/ops-parties/resident-privacy.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { FILE_EXAMPLE, fileDto } from '../shared/files.controller';
import { FileDownloadDto, FileDownloadQuery, FileDto } from '../shared/files.dto';
import { currentUserId, dateOnly, iso, isoOrNull } from '../shared/mappers';
import { PURPOSE_EXAMPLE, purposeDto } from '../shared/privacy.controllers';
import { ApiSurface, type Surface, SURFACES } from '../surfaces';
import { ifMatchVersion } from './assets.mappers';
import { DSR_EXAMPLE, dsrDto } from './governance.controller';
import {
  type HeldFieldName,
  type IdDocumentTypeName,
  PartyCreateDto,
  PartyDto,
  PartyLinkDto,
  type PartyLinkStateName,
  type PartyLinkViaName,
  PartyListQuery,
  type PartyTypeName,
  PartyUpdateDto,
  type ResidentLanguageName,
  ResidentPrivacyDto,
  RevealedPiiDto,
  RevealPiiDto,
  UnlinkDto,
} from './parties.dto';
import { type AddressDto } from './tenancy.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

export function partyDto(p: PartyRow): PartyDto {
  const address = p.address as AddressDto | null;
  const emergency = p.emergencyContact as { name: string; relation: string; phoneEnc?: string } | null;
  const occ = p.occupantProfileParty;
  return {
    id: p.id,
    type: p.type as PartyTypeName,
    displayName: p.displayName,
    firstName: p.firstName,
    lastName: p.lastName,
    companyName: p.companyName,
    taxId: p.taxId,
    phone: p.phoneE164,
    email: p.email,
    lineLinked: Boolean(p.lineUserId),
    language: p.language as ResidentLanguageName,
    nationality: p.nationality,
    idDocumentType: p.idDocumentType as IdDocumentTypeName | null,
    idDocumentCountry: p.idDocumentCountry,
    idNumberOnFile: Boolean(p.idNumberEnc),
    idExpiresOn: dateOnly(p.idExpiresOn),
    dateOfBirth: dateOnly(p.dateOfBirth),
    gender: p.gender,
    address: address && Object.keys(address).length ? address : null,
    emergencyContact: emergency
      ? { name: emergency.name, relation: emergency.relation, phoneOnFile: Boolean(emergency.phoneEnc) }
      : null,
    occupantProfile: occ
      ? {
          visaType: occ.visaType,
          arrivalDate: dateOnly(occ.arrivalDate),
          entryPort: occ.entryPort,
          passportIssuedCountry: occ.passportIssuedCountry,
          occupation: occ.occupation,
          notes: occ.notes,
        }
      : null,
    linkedLogins: p.userLinks.length,
    notes: p.notes,
    anonymised: Boolean(p.anonymisedAt),
    version: p.version,
    createdAt: iso(p.createdAt),
  };
}

export const PARTY_EXAMPLE: PartyDto = {
  id: FAKE.uuid,
  type: 'person' as PartyTypeName,
  displayName: FAKE.nameTh,
  firstName: 'ผู้เช่า',
  lastName: 'ทดสอบ',
  companyName: null,
  taxId: null,
  phone: '+66810001234',
  email: FAKE.email,
  lineLinked: true,
  language: 'th' as ResidentLanguageName,
  nationality: 'TH',
  idDocumentType: 'thai_national_id' as IdDocumentTypeName,
  idDocumentCountry: 'TH',
  idNumberOnFile: true,
  idExpiresOn: '2030-01-31',
  dateOfBirth: null,
  gender: null,
  address: null,
  emergencyContact: { name: 'ญาติ ทดสอบ', relation: 'พี่สาว', phoneOnFile: true },
  occupantProfile: null,
  linkedLogins: 1,
  notes: null,
  anonymised: false,
  version: 1,
  createdAt: FAKE.dateTime,
};

const CREATE_EXAMPLE = {
  type: 'person',
  displayName: FAKE.nameTh,
  firstName: 'ผู้เช่า',
  lastName: 'ทดสอบ',
  phone: '081-000-1234',
  language: 'th',
  nationality: 'TH',
};

const PARTY_ERRORS = [
  'validation.failed',
  'http.bad_request',
  'http.not_found',
  'tenant.read_only',
  ...T,
] as const;

/**
 * Party endpoints shared by the owner console and the staff PWA (contract §2: same operator audience, the staff
 * prefix keeps the PWA allow-list narrow). Create, list and read need `party.manage` / `party.read`.
 */
export function partiesController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.parties`)
  @ApiSurface(SURFACES[surface])
  @Controller(`${surface}/parties`)
  class PartiesController {
    constructor(readonly parties: PartiesService) {}

    @Get()
    @TenantScoped()
    @Can('party.read')
    @ApiEndpoint({
      id: `${surface}.parties.list`,
      summary: 'People and companies of my tenant',
      description:
        'Lessees, co-tenants, guarantors and owners (D-151). `q` matches the name, an exact phone or an exact ID number (through lookup hashes, D-148); ID numbers are never returned.',
      implements: ['D-148', 'D-151'],
    })
    @ApiPaginated(PartyDto, { example: PARTY_EXAMPLE })
    @ApiStandardErrors(...T)
    async list(@CurrentTenant() ctx: TenantContext, @Query() query: PartyListQuery): Promise<Page<PartyDto>> {
      const { rows, total } = await this.parties.list(ctx, {
        q: query.q,
        type: query.type,
        ...toSkipTake(query),
      });
      return paginated(rows.map(partyDto), total, query);
    }

    @Post()
    @TenantScoped()
    @Can('party.manage')
    @ApiEndpoint({
      id: `${surface}.parties.create`,
      summary: 'Add a person or company',
      description:
        'Minimal fields first; ID documents and the ID number are optional until the contract is signed (D-025). The ID number and the emergency-contact phone are sealed with the tenant data key (D-148). TM30 fields go into `occupantProfile` (D-052).',
      implements: ['D-025', 'D-052', 'D-148', 'D-151'],
    })
    @ApiJsonBody(PartyCreateDto, CREATE_EXAMPLE)
    @ApiSuccess(201, { description: 'Created', type: PartyDto, example: PARTY_EXAMPLE })
    @ApiStandardErrors(...PARTY_ERRORS)
    async create(@CurrentTenant() ctx: TenantContext, @Body() body: PartyCreateDto): Promise<PartyDto> {
      return partyDto(await this.parties.create(ctx, { ...body, address: body.address as never }));
    }

    @Get(':partyId')
    @TenantScoped()
    @Can('party.read')
    @UseEtag((p: PartyDto) => etagOf(p.id, p.version))
    @ApiEndpoint({
      id: `${surface}.parties.get`,
      summary: 'One party',
      description:
        'A party of the tenant without sealed values (404 for another tenant’s party, contract §8).',
      implements: ['D-148', 'D-151'],
    })
    @ApiSuccess(200, { description: 'The party', type: PartyDto, example: PARTY_EXAMPLE })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async get(
      @CurrentTenant() ctx: TenantContext,
      @Param('partyId', ParseUUIDPipe) id: string,
    ): Promise<PartyDto> {
      return partyDto(await this.parties.get(ctx, id));
    }
  }
  Object.defineProperty(PartiesController, 'name', {
    value: `${surface.charAt(0).toUpperCase()}${surface.slice(1)}PartiesController`,
  });
  return PartiesController;
}

@ApiTags('owner.parties')
@ApiSurface(SURFACES.owner)
@Controller('owner/parties/:partyId')
export class OwnerPartyDetailsController {
  constructor(private readonly parties: PartiesService) {}

  @Patch()
  @TenantScoped()
  @Can('party.manage')
  @UseEtag((p: PartyDto) => etagOf(p.id, p.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.parties.update',
    summary: 'Update a party',
    description:
      'Contact data, identity document (sealed again when changed, D-148), emergency contact, TM30 fields. Requires `If-Match`.',
    implements: ['D-052', 'D-148'],
  })
  @ApiJsonBody(PartyUpdateDto, { phone: '081-000-1235', notes: 'โทรหลัง 18:00' })
  @ApiSuccess(200, { description: 'Updated', type: PartyDto, example: PARTY_EXAMPLE })
  @ApiStandardErrors(...PARTY_ERRORS)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('partyId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: PartyUpdateDto,
  ): Promise<PartyDto> {
    const version = ifMatchVersion(ifMatch, await this.parties.get(ctx, id));
    return partyDto(await this.parties.update(ctx, id, version, body));
  }

  @Post('actions/reveal-pii')
  @HttpCode(200)
  @TenantScoped()
  @Can('party.pii.decrypt')
  @ApiEndpoint({
    id: 'owner.parties.revealPii',
    summary: 'Reveal a sealed ID number or emergency phone',
    description:
      'Owner and Manager only (D-172). Every field revealed writes a `pii.decrypted` audit row with the purpose (D-148, D-025).',
    implements: ['D-025', 'D-148', 'D-172'],
  })
  @ApiJsonBody(RevealPiiDto, { fields: ['idNumber'], purpose: 'ตรวจสอบตัวตนก่อนทำสัญญา' })
  @ApiSuccess(200, {
    description: 'Revealed values (null when not on file)',
    type: RevealedPiiDto,
    example: { idNumber: FAKE.nationalId, emergencyContactPhone: null },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async reveal(
    @CurrentTenant() ctx: TenantContext,
    @Param('partyId', ParseUUIDPipe) id: string,
    @Body() body: RevealPiiDto,
  ): Promise<RevealedPiiDto> {
    return this.parties.reveal(ctx, id, body.fields, body.purpose);
  }

  @Get('id-documents')
  @TenantScoped()
  @Can('party.id_document.read')
  @ApiEndpoint({
    id: 'owner.parties.listIdDocuments',
    summary: 'ID document images of a party',
    description:
      'Files of kind `id_document` scoped to the party (upload through `files/presign` with `scopeType=party`). Owner and Manager only (D-172); retention class `id_document` (D-025).',
    implements: ['D-025', 'D-172'],
  })
  @ApiSuccess(200, {
    description: 'Files',
    type: [FileDto],
    example: [
      {
        ...FILE_EXAMPLE,
        kind: 'id_document',
        scopeType: 'party',
        retentionClass: 'id_document',
        scanStatus: 'clean',
        uploadState: 'verified',
      },
    ],
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async idDocuments(
    @CurrentTenant() ctx: TenantContext,
    @Param('partyId', ParseUUIDPipe) id: string,
  ): Promise<FileDto[]> {
    return (await this.parties.idDocuments(ctx, id)).map(fileDto);
  }

  @Get('id-documents/:documentId')
  @TenantScoped()
  @Can('party.id_document.read')
  @ApiEndpoint({
    id: 'owner.parties.downloadIdDocument',
    summary: 'Open an ID document image',
    description:
      'A 5-minute signed URL; every download is audited with its purpose (`document.downloaded`, D-025).',
    implements: ['D-025', 'D-172'],
  })
  @ApiSuccess(200, {
    description: 'Download',
    type: FileDownloadDto,
    example: {
      file: {
        ...FILE_EXAMPLE,
        kind: 'id_document',
        scopeType: 'party',
        retentionClass: 'id_document',
        scanStatus: 'clean',
        uploadState: 'verified',
      },
      url: 'https://storage.example.com/file?X-Amz-Signature=abc',
      thumbnailUrl: null,
      expiresAt: '2026-11-01T00:20:00+07:00',
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'document.not_uploaded',
    'document.scan_pending',
    'document.infected',
    ...T,
  )
  async downloadIdDocument(
    @CurrentTenant() ctx: TenantContext,
    @Param('partyId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query() query: FileDownloadQuery,
  ): Promise<FileDownloadDto> {
    const r = await this.parties.downloadIdDocument(ctx, id, documentId, query.purpose ?? 'id_document');
    return {
      file: fileDto(r.document),
      url: r.url,
      thumbnailUrl: r.thumbnailUrl,
      expiresAt: iso(r.expiresAt),
    };
  }

  @Get('links')
  @TenantScoped()
  @Can('party.read')
  @ApiEndpoint({
    id: 'owner.parties.listLinks',
    summary: 'Resident logins linked to a party',
    description:
      'LINE / phone logins linked by invitation or sign-in matching (D-061); one login may hold parties in several tenants.',
    implements: ['D-061'],
  })
  @ApiSuccess(200, {
    description: 'Links',
    type: [PartyLinkDto],
    example: [
      {
        id: FAKE.uuid,
        userId: FAKE.uuid,
        userDisplayName: FAKE.nameTh,
        lineLinked: true,
        linkedVia: 'invitation',
        state: 'active',
        linkedAt: FAKE.dateTime,
        unlinkedAt: null,
        unlinkReason: null,
      },
    ],
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async links(
    @CurrentTenant() ctx: TenantContext,
    @Param('partyId', ParseUUIDPipe) id: string,
  ): Promise<PartyLinkDto[]> {
    return (await this.parties.links(ctx, id)).map(({ link, user }) => ({
      id: link.id,
      userId: link.userId,
      userDisplayName: user?.displayName ?? null,
      lineLinked: Boolean(user?.lineUserId),
      linkedVia: link.linkedVia as PartyLinkViaName,
      state: link.state as PartyLinkStateName,
      linkedAt: iso(link.linkedAt),
      unlinkedAt: isoOrNull(link.unlinkedAt),
      unlinkReason: link.unlinkReason,
    }));
  }

  @Post('links/:linkId/actions/unlink')
  @HttpCode(204)
  @TenantScoped()
  @Can('party.link.manage')
  @ApiEndpoint({
    id: 'owner.parties.unlink',
    summary: 'Unlink a resident login (Owner approval)',
    description:
      'The Owner approves an unlink requested by the resident or the office (D-061, D-172): the login loses this tenant’s leases at its next token refresh. Audited (`party.unlinked`).',
    implements: ['D-061', 'D-172'],
  })
  @ApiJsonBody(UnlinkDto, { unlinkReason: 'ผู้เช่าเปลี่ยนบัญชี LINE' })
  @ApiSuccess(204, { description: 'Unlinked' })
  @ApiStandardErrors('party.link_not_active', ...PARTY_ERRORS)
  async unlink(
    @CurrentTenant() ctx: TenantContext,
    @Param('partyId', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body() body: UnlinkDto,
  ): Promise<void> {
    await this.parties.unlink(ctx, id, linkId, body.unlinkReason);
  }
}

@ApiTags('resident.privacy')
@ApiSurface(SURFACES.resident)
@Controller('resident/me/privacy')
export class ResidentPrivacyController {
  constructor(private readonly privacy: ResidentPrivacyService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.privacy.get',
    summary: 'My personal data and privacy choices',
    description:
      'Which tenants hold my data as controllers and which categories (never the values), my consents in their current versions (asked on first use, D-025) and my PDPA requests (filed at `/v1/resident/data-subject-requests`).',
    implements: ['D-025', 'D-154'],
  })
  @ApiSuccess(200, {
    description: 'Privacy overview',
    type: ResidentPrivacyDto,
    example: {
      user: { id: FAKE.uuid, displayName: FAKE.nameTh },
      controllers: [
        {
          tenantId: FAKE.tenantId,
          tenantName: FAKE.propertyName,
          legalName: FAKE.companyName,
          parties: [
            { partyId: FAKE.uuid, displayName: FAKE.nameTh, fieldsHeld: ['name', 'phone', 'id_number'] },
          ],
        },
      ],
      consents: [PURPOSE_EXAMPLE],
      consentComplete: true,
      requests: [DSR_EXAMPLE],
    },
  })
  @ApiStandardErrors('auth.unauthenticated')
  async get(@Headers('accept-language') acceptLanguage?: string): Promise<ResidentPrivacyDto> {
    const o = await this.privacy.overview(currentUserId(), resolveLanguage(acceptLanguage));
    const consents = o.purposes.map(purposeDto);
    return {
      user: o.user,
      controllers: o.controllers.map((c) => ({
        ...c,
        parties: c.parties.map((p) => ({ ...p, fieldsHeld: p.fieldsHeld as HeldFieldName[] })),
      })),
      consents,
      consentComplete: o.purposes.filter((p) => p.required).every((p) => p.granted === true),
      requests: o.requests.map(dsrDto),
    };
  }
}
