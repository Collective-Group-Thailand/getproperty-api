import { createHash } from 'node:crypto';

import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';

import { type IntApp } from './int-app';
import { bearer } from './int-auth';
import { type IntDatabase } from './int-db';

/**
 * Uploads a file the way a client does (presign → PUT to object storage → complete) and lets the worker scan it;
 * returns the `core.document` id. `surface` is the operator surface whose files endpoint is used.
 */
export async function uploadFile(
  t: IntApp,
  db: IntDatabase,
  token: string,
  input: {
    kind: string;
    scopeType: string;
    scopeId?: string | null;
    fileName: string;
    mimeType: string;
    body: Buffer;
    surface?: 'owner' | 'staff';
    tenantId?: string;
  },
): Promise<string> {
  const surface = input.surface ?? 'owner';
  const headers = { ...bearer(token), ...(input.tenantId ? { 'X-Tenant-Id': input.tenantId } : {}) };
  const presign = await t.http
    .post(`/v1/${surface}/files/presign`)
    .set(headers)
    .send({
      kind: input.kind,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? undefined,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.body.length,
      sha256: createHash('sha256').update(input.body).digest('hex'),
    });
  if (presign.status !== 201) throw new Error(`presign ${presign.status}: ${JSON.stringify(presign.body)}`);
  const fileId = presign.body.file.id as string;
  const { rows } = await db.admin.query<{ storage_key: string }>(
    'SELECT storage_key FROM core.document WHERE id = $1',
    [fileId],
  );
  t.app.get<FakeObjectStorage>(OBJECT_STORAGE).putDirect(rows[0]!.storage_key, input.body, input.mimeType);
  const complete = await t.http.post(`/v1/${surface}/files/${fileId}/actions/complete`).set(headers).send({});
  if (complete.status !== 200)
    throw new Error(`complete ${complete.status}: ${JSON.stringify(complete.body)}`);
  await t.worker.tick();
  return fileId;
}
