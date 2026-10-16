import { type Readable } from 'node:stream';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface PresignedUpload {
  url: string;
  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}

/**
 * Private object storage (S3). Meter photos, slips, ID documents and contracts are private. Clients upload with presigned PUTs (single or multipart) and
 * download through short-lived signed URLs after an authorisation check (contract §3 "Files").
 */
export interface ObjectStorage {
  /** `fake` for the in-memory stand-in; `/health` reports it instead of probing. */
  readonly mode: 'fake' | 'real';
  /** Resolves when the bucket is reachable; used by `/health`. */
  ping(signal?: AbortSignal): Promise<void>;
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<PresignedUpload>;
  createMultipart(key: string, contentType: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** Parts already stored of an open multipart upload (resume of large uploads, B1.3 files). */
  listParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; etag: string; sizeBytes: number }[]>;
  head(key: string): Promise<StoredObjectInfo | null>;
  getStream(key: string): Promise<Readable>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Server-side copy inside the bucket (e.g. inspection photo sets, B2.4). */
  copy(sourceKey: string, targetKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  presignGet(
    key: string,
    options: { expiresInSeconds: number; fileName: string; contentType: string },
  ): Promise<string>;
}
