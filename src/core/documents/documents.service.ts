import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Document, type DocumentKind, type DocumentScope } from '@generated/prisma/client';
import { OBJECT_STORAGE, type ObjectStorage } from '@integrations/s3/object-storage.port';
import { VIRUS_SCAN, type VirusScanPort } from '@integrations/virus-scan/virus-scan.port';
import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import {
  AUDITED_DOWNLOADS,
  DOCUMENT_POLICY,
  isImage,
  MULTIPART_THRESHOLD,
  PART_SIZE,
} from './document-policy';

export const UPLOAD_URL_TTL_SECONDS = 900;
/** Permission needed to see ID document images (B2.2). */
export const ID_DOCUMENT_PERMISSION = 'party.id_document.read';
export const DOWNLOAD_URL_TTL_SECONDS = 300;
/** Kinds the platform admin may upload as platform files (`POST /v1/admin/files/presign`). */
export const PLATFORM_UPLOAD_KINDS: DocumentKind[] = ['tariff_source', 'contract', 'other'];

export interface PresignInput {
  kind: DocumentKind;
  scopeType: DocumentScope;
  scopeId?: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Hex sha256 of the file (verified by the scan job). */
  sha256: string;
  title?: string | null;
}

export interface PresignResult {
  document: Document;
  uploadUrl: string | null;
  headers: Record<string, string>;
  multipart: { uploadId: string; partSize: number; parts: { partNumber: number; url: string }[] } | null;
  expiresAt: Date;
}

/**
 * Files (contract §3 "Files"): presign (single PUT or multipart) → the client uploads to object storage → `complete`
 * checks the object and emits `document.uploaded`; the `document-scan` subscriber streams it through the virus-scan
 * port, verifies the declared sha256, makes a thumbnail for images and marks it `verified`. Downloads are signed URLs
 * of 5 minutes, only for clean files; PDPA-sensitive kinds are audited. Storage keys start with the tenant id and
 * are never accepted from clients (a cross-tenant file id is a 404).
 */
@Injectable()
export class DocumentsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(VIRUS_SCAN) private readonly scanner: VirusScanPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async scopeBuilding(
    tx: Tx,
    ctx: TenantContext,
    scopeType: DocumentScope,
    scopeId: string | null | undefined,
  ) {
    switch (scopeType) {
      case 'tenant':
        return null;
      case 'property':
        this.found(
          await tx.property.findFirst({ where: this.own(ctx, { id: scopeId ?? '', deletedAt: null }) }),
        );
        return null;
      case 'building': {
        const b = this.found(await tx.building.findFirst({ where: { id: scopeId ?? '', deletedAt: null } }));
        return b.id;
      }
      case 'floor':
        return this.found(await tx.floor.findFirst({ where: { id: scopeId ?? '', deletedAt: null } }))
          .buildingId;
      case 'unit':
        return this.found(await tx.unit.findFirst({ where: { id: scopeId ?? '', deletedAt: null } }))
          .buildingId;
      case 'party':
        this.found(
          await tx.party.findFirst({ where: this.own(ctx, { id: scopeId ?? '', deletedAt: null }) }),
        );
        return null;
      case 'asset_item':
        return this.found(await tx.assetItem.findFirst({ where: { id: scopeId ?? '', deletedAt: null } }))
          .buildingId;
      case 'platform':
        throw new DomainException('http.not_found');
    }
  }

  async presign(ctx: TenantContext, input: PresignInput): Promise<PresignResult> {
    const policy = DOCUMENT_POLICY[input.kind];
    if (!policy || !policy.mime.includes(input.mimeType))
      throw new DomainException('document.type_not_allowed');
    if (input.sizeBytes > policy.maxBytes)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'sizeBytes', code: 'max', message: `at most ${policy.maxBytes} bytes for ${input.kind}` },
        ],
      });
    if (!/^[0-9a-f]{64}$/i.test(input.sha256))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'sha256', code: 'isHexadecimal', message: 'sha256 must be 64 hex characters' }],
      });
    const now = this.clock.now();
    const id = uuidv7(now.getTime());
    const ym = now.toISOString().slice(0, 7).replace('-', '/');
    const storageKey = `t/${ctx.tenantId}/${input.kind}/${ym}/${id}`;
    const document = await this.db.tenant(ctx, async (tx) => {
      if (ctx.buildingIds && input.scopeType === 'tenant') throw new DomainException('auth.forbidden');
      const buildingId = await this.scopeBuilding(tx, ctx, input.scopeType, input.scopeId);
      if (buildingId && ctx.buildingIds && !ctx.buildingIds.includes(buildingId))
        throw new DomainException('http.not_found');
      return tx.document.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          scopeType: input.scopeType,
          scopeId: input.scopeType === 'tenant' ? ctx.tenantId : (input.scopeId ?? null),
          buildingId,
          kind: input.kind,
          title: input.title ?? input.fileName.slice(0, 200),
          storageBucket: this.config.get('S3_BUCKET'),
          storageKey,
          mimeType: input.mimeType,
          sizeBytes: BigInt(input.sizeBytes),
          sha256: new Uint8Array(Buffer.from(input.sha256, 'hex')),
          retentionClass: policy.retentionClass,
          uploadState: 'presigned',
          scanStatus: 'pending',
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
    });
    const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000);
    if (input.sizeBytes > MULTIPART_THRESHOLD) {
      const uploadId = await this.storage.createMultipart(storageKey, input.mimeType);
      const count = Math.ceil(input.sizeBytes / PART_SIZE);
      const parts = [];
      for (let partNumber = 1; partNumber <= count; partNumber += 1)
        parts.push({
          partNumber,
          url: await this.storage.presignPart(storageKey, uploadId, partNumber, UPLOAD_URL_TTL_SECONDS),
        });
      return {
        document,
        uploadUrl: null,
        headers: {},
        multipart: { uploadId, partSize: PART_SIZE, parts },
        expiresAt,
      };
    }
    const put = await this.storage.presignPut(storageKey, {
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return { document, uploadUrl: put.url, headers: put.headers, multipart: null, expiresAt };
  }

  private findOwn(tx: Tx, ctx: TenantContext, id: string) {
    return tx.document.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        deletedAt: null,
        ...(ctx.buildingIds
          ? {
              OR: [
                { buildingId: { in: [...ctx.buildingIds] } },
                { buildingId: null, scopeType: { not: 'tenant' } },
              ],
            }
          : {}),
      },
    });
  }

  /** The client finished uploading: the object must exist with the declared size. */
  async complete(
    ctx: TenantContext,
    id: string,
    input: { uploadId?: string; parts?: { partNumber: number; etag: string }[] },
  ) {
    const doc = await this.db.tenant(ctx, async (tx) => this.found(await this.findOwn(tx, ctx, id)));
    if (doc.uploadState !== 'presigned') return doc;
    if (input.uploadId)
      await this.storage.completeMultipart(doc.storageKey, input.uploadId, input.parts ?? []);
    const head = await this.storage.head(doc.storageKey);
    if (!head) throw new DomainException('document.not_uploaded');
    if (head.sizeBytes !== Number(doc.sizeBytes)) throw new DomainException('document.size_mismatch');
    return this.db.tenant(ctx, async (tx) => {
      const updated = await tx.document.update({
        where: { id: doc.id },
        data: {
          uploadState: 'uploaded',
          uploadedAt: this.clock.now(),
          updatedBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.events.record(tx, {
        type: 'document.uploaded',
        aggregateType: 'document',
        aggregateId: doc.id,
        tenantId: ctx.tenantId,
        buildingId: doc.buildingId,
        payload: { documentId: doc.id, kind: doc.kind },
      });
      return updated;
    });
  }

  /** Metadata + a 5-minute signed download URL (clean files only); PDPA-sensitive kinds are audited. */
  async download(ctx: TenantContext, id: string, purpose: string | null) {
    const doc = await this.db.tenant(ctx, async (tx) => this.found(await this.findOwn(tx, ctx, id)));
    // ID document images: Owner/Manager only (D-025, D-172), whatever surface the download comes from.
    if (doc.kind === 'id_document' && !RequestContext.permissions().has(ID_DOCUMENT_PERMISSION))
      throw new DomainException('auth.forbidden');
    if (doc.uploadState === 'presigned') throw new DomainException('document.not_uploaded');
    if (doc.scanStatus === 'pending') throw new DomainException('document.scan_pending');
    if (doc.scanStatus !== 'clean' && doc.scanStatus !== 'skipped')
      throw new DomainException('document.infected');
    if (AUDITED_DOWNLOADS.includes(doc.kind))
      await this.db.tenant(ctx, (tx) =>
        this.audit.record(tx, {
          action: 'document.downloaded',
          tenantId: ctx.tenantId,
          buildingId: doc.buildingId,
          subjectType: 'core.document',
          subjectId: doc.id,
          metadata: { kind: doc.kind, purpose },
        }),
      );
    const url = await this.storage.presignGet(doc.storageKey, {
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      fileName: doc.title ?? doc.id,
      contentType: doc.mimeType,
    });
    const thumbnailUrl = doc.thumbnailKey
      ? await this.storage.presignGet(doc.thumbnailKey, {
          expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
          fileName: `${doc.id}.webp`,
          contentType: 'image/webp',
        })
      : null;
    return {
      document: doc,
      url,
      thumbnailUrl,
      expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => this.found(await this.findOwn(tx, ctx, id)));
  }

  /**
   * The bytes of an uploaded file for server-side processing (Excel imports, B2.1): only clean files (scan done)
   * of the given kinds and MIME types, at most `maxBytes`; the stored sha256 is checked again.
   */
  async readBytes(
    ctx: TenantContext,
    id: string,
    options: { kinds: DocumentKind[]; mimeTypes: string[]; maxBytes: number },
  ): Promise<{ document: Document; body: Buffer }> {
    const doc = await this.db.tenant(ctx, async (tx) => this.found(await this.findOwn(tx, ctx, id)));
    if (!options.kinds.includes(doc.kind) || !options.mimeTypes.includes(doc.mimeType))
      throw new DomainException('document.type_not_allowed');
    if (doc.uploadState === 'presigned') throw new DomainException('document.not_uploaded');
    if (doc.scanStatus === 'pending') throw new DomainException('document.scan_pending');
    if (doc.scanStatus !== 'clean' && doc.scanStatus !== 'skipped')
      throw new DomainException('document.infected');
    if (Number(doc.sizeBytes) > options.maxBytes)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'fileId', code: 'max', message: `the file is larger than ${options.maxBytes} bytes` },
        ],
      });
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.getStream(doc.storageKey))
      chunks.push(Buffer.from(chunk as Buffer));
    const body = Buffer.concat(chunks);
    if (!createHash('sha256').update(body).digest().equals(Buffer.from(doc.sha256)))
      throw new DomainException('document.infected');
    return { document: doc, body };
  }

  /**
   * Stores a file the platform generated (contract PDF, statements, reports) inside the caller's transaction:
   * object first, then the `core.document` row (verified, scan `skipped` — the platform wrote it). A rollback
   * leaves an orphan object, never a row without its object; the retention job sweeps orphans by key prefix.
   */
  async storeGenerated(
    tx: Tx,
    input: {
      tenantId: string;
      kind: DocumentKind;
      scopeType: DocumentScope;
      scopeId: string | null;
      buildingId: string | null;
      title: string;
      mimeType: string;
      body: Buffer;
      retentionClass?: string;
      versionOfDocumentId?: string | null;
    },
  ): Promise<Document> {
    const now = this.clock.now();
    const id = uuidv7(now.getTime());
    const ym = now.toISOString().slice(0, 7).replace('-', '/');
    const storageKey = `t/${input.tenantId}/${input.kind}/${ym}/${id}`;
    await this.storage.put(storageKey, input.body, input.mimeType);
    return tx.document.create({
      data: {
        id,
        tenantId: input.tenantId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        buildingId: input.buildingId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        storageBucket: this.config.get('S3_BUCKET'),
        storageKey,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.body.length),
        sha256: new Uint8Array(createHash('sha256').update(input.body).digest()),
        retentionClass: input.retentionClass ?? DOCUMENT_POLICY[input.kind]?.retentionClass ?? 'other',
        uploadState: 'verified',
        uploadedAt: now,
        scanStatus: 'skipped',
        scannedAt: now,
        versionOfDocumentId: input.versionOfDocumentId ?? null,
        createdBy: userIdOf(RequestContext.actor()),
      },
    });
  }

  /** The stored bytes of a document the caller may already see (inside its transaction). */
  async bytesOf(document: Pick<Document, 'storageKey'>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.getStream(document.storageKey))
      chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  /** Signed URL of a document already authorised by the caller (resident contract download, B2.3). */
  async signedUrl(document: Pick<Document, 'id' | 'storageKey' | 'title' | 'mimeType'>) {
    const url = await this.storage.presignGet(document.storageKey, {
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      fileName: document.title ?? document.id,
      contentType: document.mimeType,
    });
    return { url, expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000) };
  }

  // ------------------------------------------------------------------------------------------------- platform files

  /**
   * Platform-scoped files (`tenant_id` NULL, scope `platform`, web F5 contract request): uploads of the platform
   * admin — the published notice behind a utility tariff version (kind `tariff_source`), contracts, other evidence.
   * Same presign → upload → complete → scan flow as tenant files; keys start with `p/` and are never tenant-visible.
   */
  async presignPlatform(input: Omit<PresignInput, 'scopeType' | 'scopeId'>): Promise<PresignResult> {
    const policy = DOCUMENT_POLICY[input.kind];
    if (!policy || !PLATFORM_UPLOAD_KINDS.includes(input.kind) || !policy.mime.includes(input.mimeType))
      throw new DomainException('document.type_not_allowed');
    if (input.sizeBytes > policy.maxBytes)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'sizeBytes', code: 'max', message: `at most ${policy.maxBytes} bytes for ${input.kind}` },
        ],
      });
    if (!/^[0-9a-f]{64}$/i.test(input.sha256))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'sha256', code: 'isHexadecimal', message: 'sha256 must be 64 hex characters' }],
      });
    const now = this.clock.now();
    const id = uuidv7(now.getTime());
    const storageKey = `p/${input.kind}/${now.toISOString().slice(0, 7).replace('-', '/')}/${id}`;
    const document = await this.db.platform((tx) =>
      tx.document.create({
        data: {
          id,
          tenantId: null,
          scopeType: 'platform',
          scopeId: null,
          buildingId: null,
          kind: input.kind,
          title: input.title ?? input.fileName.slice(0, 200),
          storageBucket: this.config.get('S3_BUCKET'),
          storageKey,
          mimeType: input.mimeType,
          sizeBytes: BigInt(input.sizeBytes),
          sha256: new Uint8Array(Buffer.from(input.sha256, 'hex')),
          retentionClass: policy.retentionClass,
          uploadState: 'presigned',
          scanStatus: 'pending',
          createdBy: userIdOf(RequestContext.actor()),
        },
      }),
    );
    const put = await this.storage.presignPut(storageKey, {
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      document,
      uploadUrl: put.url,
      headers: put.headers,
      multipart: null,
      expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  private async platformDoc(id: string): Promise<Document> {
    return this.db.platform(async (tx) =>
      this.found(
        await tx.document.findFirst({
          where: { id, tenantId: null, scopeType: 'platform', deletedAt: null },
        }),
      ),
    );
  }

  /** The platform file was uploaded: the object must exist with the declared size; the scan follows. */
  async completePlatform(id: string) {
    const doc = await this.platformDoc(id);
    if (doc.uploadState !== 'presigned') return doc;
    const head = await this.storage.head(doc.storageKey);
    if (!head) throw new DomainException('document.not_uploaded');
    if (head.sizeBytes !== Number(doc.sizeBytes)) throw new DomainException('document.size_mismatch');
    return this.db.platform(async (tx) => {
      const updated = await tx.document.update({
        where: { id: doc.id },
        data: {
          uploadState: 'uploaded',
          uploadedAt: this.clock.now(),
          updatedBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.events.record(tx, {
        type: 'document.uploaded',
        aggregateType: 'document',
        aggregateId: doc.id,
        tenantId: null,
        payload: { documentId: doc.id, kind: doc.kind },
      });
      return updated;
    });
  }

  /** Metadata + a 5-minute signed URL of a clean platform file (downloads audited). */
  async downloadPlatform(id: string) {
    const doc = await this.platformDoc(id);
    if (doc.uploadState === 'presigned') throw new DomainException('document.not_uploaded');
    if (doc.scanStatus === 'pending') throw new DomainException('document.scan_pending');
    if (doc.scanStatus !== 'clean' && doc.scanStatus !== 'skipped')
      throw new DomainException('document.infected');
    await this.db.platform((tx) =>
      this.audit.record(tx, {
        action: 'document.downloaded',
        tenantId: null,
        subjectType: 'core.document',
        subjectId: doc.id,
        metadata: { kind: doc.kind, purpose: 'platform_admin' },
      }),
    );
    const { url, expiresAt } = await this.signedUrl(doc);
    return { document: doc, url, thumbnailUrl: null, expiresAt };
  }

  /** A platform file a tariff version may cite as its source (uploaded, not infected), else 422. */
  async platformSource(tx: Tx, id: string): Promise<Document> {
    const doc = await tx.document.findFirst({
      where: {
        id,
        tenantId: null,
        scopeType: 'platform',
        deletedAt: null,
        kind: { in: PLATFORM_UPLOAD_KINDS },
      },
    });
    if (!doc || doc.uploadState === 'presigned' || ['infected', 'failed'].includes(doc.scanStatus))
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'sourceDocumentId',
            code: 'document',
            message: 'an uploaded platform file (tariff_source, contract or other) is required',
          },
        ],
      });
    return doc;
  }

  /**
   * Worker (`document-scan` subscriber): streams the object through the virus scanner, checks the sha256, makes a
   * 320 px WebP thumbnail of clean images. Runs in the subscriber's transaction.
   */
  async scan(tx: Tx, documentId: string): Promise<Document | null> {
    const doc = await tx.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.deletedAt || doc.scanStatus !== 'pending') return doc;
    const now = this.clock.now();
    const chunks: Buffer[] = [];
    const stream = await this.storage.getStream(doc.storageKey);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    const body = Buffer.concat(chunks);
    const sha = createHash('sha256').update(body).digest();
    let scanStatus: Document['scanStatus'];
    let reason: string | null;
    if (!sha.equals(Buffer.from(doc.sha256))) {
      scanStatus = 'failed';
      reason = 'sha256 mismatch';
    } else {
      const result = await this.scanner.scan(Readable.from([body]));
      scanStatus = result.clean ? 'clean' : 'infected';
      reason = result.signature ?? null;
    }
    let thumbnailKey: string | null = null;
    let width: number | null = null;
    let height: number | null = null;
    if (scanStatus === 'clean' && isImage(doc.mimeType)) {
      try {
        const meta = await sharp(body).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
        const thumb = await sharp(body)
          .rotate()
          .resize({ width: 320, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        thumbnailKey = `${doc.storageKey}.thumb.webp`;
        await this.storage.put(thumbnailKey, thumb, 'image/webp');
      } catch {
        thumbnailKey = null;
      }
    }
    const updated = await tx.document.update({
      where: { id: doc.id },
      data: {
        scanStatus,
        scannedAt: now,
        uploadState: scanStatus === 'clean' ? 'verified' : doc.uploadState,
        thumbnailKey,
        width,
        height,
      },
    });
    await this.events.record(tx, {
      type: 'document.scanned',
      aggregateType: 'document',
      aggregateId: doc.id,
      tenantId: doc.tenantId,
      buildingId: doc.buildingId,
      payload: { documentId: doc.id, scanStatus, reason },
    });
    return updated;
  }
}
