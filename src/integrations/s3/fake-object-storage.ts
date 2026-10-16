import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { type ObjectStorage, type PresignedUpload, type StoredObjectInfo } from './object-storage.port';

const BASE = 'https://fake-s3.invalid';

/**
 * In-memory stand-in used by tests, `pnpm dev` and the contract build. Presigned URLs are not
 * reachable; tests "upload" with `putDirect`, which is what the client's PUT would do.
 */
export class FakeObjectStorage implements ObjectStorage {
  readonly mode = 'fake' as const;
  available = true;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  private readonly multiparts = new Map<
    string,
    { key: string; parts: Map<number, Buffer>; contentType: string }
  >();

  ping(): Promise<void> {
    return this.available ? Promise.resolve() : Promise.reject(new Error('fake object storage unavailable'));
  }

  presignPut(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    return Promise.resolve({
      url: `${BASE}/${encodeURIComponent(key)}?op=put&expires=${options.expiresInSeconds}`,
      headers: { 'Content-Type': options.contentType },
    });
  }

  createMultipart(key: string, contentType: string): Promise<string> {
    const uploadId = randomUUID();
    this.multiparts.set(uploadId, { key, parts: new Map(), contentType });
    return Promise.resolve(uploadId);
  }

  presignPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return Promise.resolve(
      `${BASE}/${encodeURIComponent(key)}?op=part&uploadId=${uploadId}&partNumber=${partNumber}`,
    );
  }

  /** Test helper: what a client's part PUT does. Returns the ETag. */
  putPart(uploadId: string, partNumber: number, body: Buffer): string {
    this.multiparts.get(uploadId)?.parts.set(partNumber, body);
    return `"etag-${partNumber}"`;
  }

  completeMultipart(_key: string, uploadId: string, parts: { partNumber: number }[]): Promise<void> {
    const upload = this.multiparts.get(uploadId);
    if (!upload) return Promise.reject(new Error('NoSuchUpload'));
    const body = Buffer.concat(
      parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => upload.parts.get(p.partNumber) ?? Buffer.alloc(0)),
    );
    this.objects.set(upload.key, { body, contentType: upload.contentType });
    this.multiparts.delete(uploadId);
    return Promise.resolve();
  }

  listParts(
    _key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; etag: string; sizeBytes: number }[]> {
    const upload = this.multiparts.get(uploadId);
    if (!upload) return Promise.reject(new Error('NoSuchUpload'));
    return Promise.resolve(
      [...upload.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([partNumber, body]) => ({ partNumber, etag: `"etag-${partNumber}"`, sizeBytes: body.length })),
    );
  }

  abortMultipart(_key: string, uploadId: string): Promise<void> {
    this.multiparts.delete(uploadId);
    return Promise.resolve();
  }

  /** Test helper: what a client's presigned PUT does. */
  putDirect(key: string, body: Buffer, contentType: string): void {
    this.objects.set(key, { body, contentType });
  }

  head(key: string): Promise<StoredObjectInfo | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { sizeBytes: object.body.length, contentType: object.contentType } : null,
    );
  }

  getStream(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    return object ? Promise.resolve(Readable.from([object.body])) : Promise.reject(new Error('NoSuchKey'));
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }

  copy(sourceKey: string, targetKey: string): Promise<void> {
    const object = this.objects.get(sourceKey);
    if (!object) return Promise.reject(new Error(`no object ${sourceKey}`));
    this.objects.set(targetKey, { body: Buffer.from(object.body), contentType: object.contentType });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  presignGet(key: string, options: { expiresInSeconds: number }): Promise<string> {
    return Promise.resolve(`${BASE}/${encodeURIComponent(key)}?op=get&expires=${options.expiresInSeconds}`);
  }
}
