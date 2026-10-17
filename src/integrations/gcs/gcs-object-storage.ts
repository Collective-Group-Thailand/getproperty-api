import { type Readable } from 'node:stream';

import { type Bucket, Storage } from '@google-cloud/storage';

import { type ObjectStorage, type PresignedUpload, type StoredObjectInfo } from '../s3/object-storage.port';

export interface GcsOptions {
  bucket: string;
  projectId?: string;
  /** Prepended to every object key (`GCS_KEY_PREFIX`), as `S3_KEY_PREFIX`. */
  keyPrefix?: string;
  /** Test seam: a pre-built client. */
  storage?: Storage;
}

const XML_API = 'https://storage.googleapis.com';

/** `<Tag>value</Tag>` occurrences of an XML API answer (flat, no namespaces needed). */
export function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) =>
    m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
  );
}

/** The S3-compatible `CompleteMultipartUpload` body of the GCS XML API. */
export function completeBody(parts: { partNumber: number; etag: string }[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<CompleteMultipartUpload>${[...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${esc(p.etag)}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;
}

/** The `<Part>` entries of a `ListParts` answer. */
export function parseParts(xml: string): { partNumber: number; etag: string; sizeBytes: number }[] {
  return [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
    partNumber: Number(xmlValues(m[1]!, 'PartNumber')[0]),
    etag: xmlValues(m[1]!, 'ETag')[0] ?? '',
    sizeBytes: Number(xmlValues(m[1]!, 'Size')[0] ?? 0),
  }));
}

/**
 * Google Cloud Storage (D-160, B6.5) behind the same port as S3: private bucket (uniform access, public access
 * prevention), V4 signed URLs for uploads and downloads, and the S3-compatible XML multipart API of GCS for large
 * uploads (initiate / signed part URLs / list / complete / abort). Credentials: the Cloud Run service account
 * (ADC); signing uses the IAM `signBlob` of that account (`roles/iam.serviceAccountTokenCreator` on itself).
 * // UNVERIFIED against live provider
 */
export class GcsObjectStorage implements ObjectStorage {
  readonly mode = 'real' as const;
  private readonly storage: Storage;
  private readonly bucket: Bucket;

  constructor(private readonly options: GcsOptions) {
    this.storage =
      options.storage ?? new Storage({ projectId: options.projectId, retryOptions: { maxRetries: 3 } });
    this.bucket = this.storage.bucket(options.bucket);
  }

  private k(key: string): string {
    return `${this.options.keyPrefix ?? ''}${key}`;
  }

  private objectUrl(key: string, query: string): string {
    const path = this.k(key).split('/').map(encodeURIComponent).join('/');
    return `${XML_API}/${encodeURIComponent(this.options.bucket)}/${path}?${query}`;
  }

  private async xml(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body?: string,
    headers: Record<string, string> = {},
  ) {
    const res = await this.storage.authClient.request<string>({
      method,
      url,
      data: body,
      headers,
      responseType: 'text',
    });
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  async ping(): Promise<void> {
    await this.bucket.getMetadata();
  }

  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    const [url] = await this.bucket.file(this.k(key)).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + options.expiresInSeconds * 1000,
      contentType: options.contentType,
    });
    return { url, headers: { 'Content-Type': options.contentType } };
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const xml = await this.xml('POST', this.objectUrl(key, 'uploads'), '', { 'Content-Type': contentType });
    const id = xmlValues(xml, 'UploadId')[0];
    if (!id) throw new Error('GCS returned no UploadId');
    return id;
  }

  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    const [url] = await this.bucket.file(this.k(key)).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + expiresInSeconds * 1000,
      queryParams: { partNumber: String(partNumber), uploadId },
    });
    return url;
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    await this.xml(
      'POST',
      this.objectUrl(key, `uploadId=${encodeURIComponent(uploadId)}`),
      completeBody(parts),
      {
        'Content-Type': 'application/xml',
      },
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.xml('DELETE', this.objectUrl(key, `uploadId=${encodeURIComponent(uploadId)}`));
  }

  async listParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; etag: string; sizeBytes: number }[]> {
    const parts: { partNumber: number; etag: string; sizeBytes: number }[] = [];
    let marker: string | undefined;
    do {
      const xml = await this.xml(
        'GET',
        this.objectUrl(
          key,
          `uploadId=${encodeURIComponent(uploadId)}${marker ? `&part-number-marker=${marker}` : ''}`,
        ),
      );
      parts.push(...parseParts(xml));
      marker =
        xmlValues(xml, 'IsTruncated')[0] === 'true' ? xmlValues(xml, 'NextPartNumberMarker')[0] : undefined;
    } while (marker);
    return parts;
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const [meta] = await this.bucket.file(this.k(key)).getMetadata();
      return { sizeBytes: Number(meta.size ?? 0), contentType: meta.contentType ?? null };
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  }

  getStream(key: string): Promise<Readable> {
    return Promise.resolve(this.bucket.file(this.k(key)).createReadStream());
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.bucket.file(this.k(key)).save(body, { contentType, resumable: false });
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    await this.bucket.file(this.k(sourceKey)).copy(this.bucket.file(this.k(targetKey)));
  }

  async delete(key: string): Promise<void> {
    await this.bucket.file(this.k(key)).delete({ ignoreNotFound: true });
  }

  async presignGet(
    key: string,
    options: { expiresInSeconds: number; fileName: string; contentType: string },
  ): Promise<string> {
    const [url] = await this.bucket.file(this.k(key)).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + options.expiresInSeconds * 1000,
      responseType: options.contentType,
      responseDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(options.fileName)}`,
    });
    return url;
  }
}
