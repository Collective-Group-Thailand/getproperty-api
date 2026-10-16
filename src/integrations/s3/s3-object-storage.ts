import { type Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { type ObjectStorage, type PresignedUpload, type StoredObjectInfo } from './object-storage.port';

export interface S3Options {
  region: string;
  bucket: string;
  endpoint?: string;
  forcePathStyle: boolean;
  /**
   * Prepended to every object key (`S3_KEY_PREFIX`, e.g. `getproperty/`): lets getproperty share a bucket with
   * another system without a custom endpoint. Stored keys (`file_objects.storage_key`) never carry it.
   */
  keyPrefix?: string;
}

/** Objects are private (no public ACLs); server-side encryption is enforced by the bucket policy. */
export class S3ObjectStorage implements ObjectStorage {
  readonly mode = 'real' as const;
  private readonly client: S3Client;

  constructor(private readonly options: S3Options) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 3,
    });
  }

  private get bucket(): string {
    return this.options.bucket;
  }

  /** The object's key in the bucket: the configured prefix + getproperty's key. */
  private k(key: string): string {
    return `${this.options.keyPrefix ?? ''}${key}`;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
  }

  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.k(key),
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds,
      signableHeaders: new Set(['content-type']),
    });
    return { url, headers: { 'Content-Type': options.contentType } };
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: this.k(key), ContentType: contentType }),
    );
    if (!result.UploadId) throw new Error('S3 returned no UploadId');
    return result.UploadId;
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      {
        expiresIn: expiresInSeconds,
      },
    );
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async listParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; etag: string; sizeBytes: number }[]> {
    const parts: { partNumber: number; etag: string; sizeBytes: number }[] = [];
    let marker: string | undefined;
    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: this.k(key),
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const p of page.Parts ?? [])
        if (p.PartNumber !== undefined && p.ETag)
          parts.push({ partNumber: p.PartNumber, etag: p.ETag, sizeBytes: p.Size ?? 0 });
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.k(key), UploadId: uploadId }),
    );
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: string }).name === 'NotFound') return null;
      throw error;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    return result.Body as Readable;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: contentType }),
    );
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: this.k(targetKey),
        CopySource: `${this.bucket}/${this.k(sourceKey).split('/').map(encodeURIComponent).join('/')}`,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }

  presignGet(
    key: string,
    options: { expiresInSeconds: number; fileName: string; contentType: string },
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        ResponseContentType: options.contentType,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(options.fileName)}`,
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }
}
