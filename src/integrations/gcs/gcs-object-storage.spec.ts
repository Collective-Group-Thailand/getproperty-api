import { gcpSecretId, GcpSecretsProvider } from '../secrets/gcp-secrets.provider';
import { completeBody, GcsObjectStorage, parseParts, xmlValues } from './gcs-object-storage';

/** A stand-in for the `@google-cloud/storage` client: records calls, answers like the service. */
function fakeStorage(xmlAnswers: string[] = []) {
  const calls: { method: string; url: string; data?: unknown; headers?: Record<string, string> }[] = [];
  const signed: Record<string, unknown>[] = [];
  const files = new Map<string, { meta?: { size: string; contentType: string } }>();
  const file = (name: string) => ({
    getSignedUrl: (o: Record<string, unknown>) => {
      signed.push({ name, ...o });
      return Promise.resolve([`https://storage.googleapis.com/b/${name}?X-Goog-Signature=x`]);
    },
    getMetadata: () => {
      const f = files.get(name);
      return f?.meta
        ? Promise.resolve([f.meta])
        : Promise.reject(Object.assign(new Error('nf'), { code: 404 }));
    },
    save: (_b: Buffer, o: { contentType: string }) => {
      files.set(name, { meta: { size: String(_b.length), contentType: o.contentType } });
      return Promise.resolve();
    },
    delete: () => Promise.resolve(),
  });
  const storage = {
    bucket: () => ({ file, getMetadata: () => Promise.resolve([{}]) }),
    authClient: {
      request: (o: { method: string; url: string; data?: unknown; headers?: Record<string, string> }) => {
        calls.push(o);
        return Promise.resolve({ data: xmlAnswers.shift() ?? '' });
      },
    },
  };
  return { storage, calls, signed, files };
}

describe('GCS object storage (D-207, UNVERIFIED against the live provider)', () => {
  it('parses the S3-compatible XML of the multipart API', () => {
    expect(xmlValues('<a><UploadId>u-1</UploadId></a>', 'UploadId')).toEqual(['u-1']);
    expect(
      completeBody([
        { partNumber: 2, etag: '"b"' },
        { partNumber: 1, etag: '"a"' },
      ]),
    ).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part></CompleteMultipartUpload>',
    );
    expect(
      parseParts(
        '<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>5242880</Size></Part></ListPartsResult>',
      ),
    ).toEqual([{ partNumber: 1, etag: '"e1"', sizeBytes: 5242880 }]);
  });

  it('presigns V4 PUT / GET with the key prefix, multipart through the XML API, head → null on 404', async () => {
    const f = fakeStorage([
      '<InitiateMultipartUploadResult><UploadId>up-9</UploadId></InitiateMultipartUploadResult>',
      '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>e1</ETag><Size>10</Size></Part></ListPartsResult>',
      '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><ETag>e2</ETag><Size>4</Size></Part></ListPartsResult>',
      '',
    ]);
    const gcs = new GcsObjectStorage({ bucket: 'gp-docs', keyPrefix: 'gp/', storage: f.storage as never });
    const put = await gcs.presignPut('t/1/a b.jpg', {
      contentType: 'image/jpeg',
      contentLength: 10,
      expiresInSeconds: 600,
    });
    expect(put.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(f.signed[0]).toMatchObject({
      name: 'gp/t/1/a b.jpg',
      version: 'v4',
      action: 'write',
      contentType: 'image/jpeg',
    });

    expect(await gcs.createMultipart('t/1/big.pdf', 'application/pdf')).toBe('up-9');
    expect(f.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://storage.googleapis.com/gp-docs/gp/t/1/big.pdf?uploads',
      headers: { 'Content-Type': 'application/pdf' },
    });
    await gcs.presignPart('t/1/big.pdf', 'up-9', 2, 600);
    expect(f.signed[1]).toMatchObject({ queryParams: { partNumber: '2', uploadId: 'up-9' } });
    expect(await gcs.listParts('t/1/big.pdf', 'up-9')).toEqual([
      { partNumber: 1, etag: 'e1', sizeBytes: 10 },
      { partNumber: 2, etag: 'e2', sizeBytes: 4 },
    ]);
    expect(f.calls[2]!.url).toContain('part-number-marker=1');
    await gcs.completeMultipart('t/1/big.pdf', 'up-9', [{ partNumber: 1, etag: 'e1' }]);
    expect(f.calls[3]).toMatchObject({ method: 'POST', url: expect.stringContaining('?uploadId=up-9') });

    expect(await gcs.head('t/1/missing')).toBeNull();
    await gcs.put('t/1/x.pdf', Buffer.from('pdf'), 'application/pdf');
    expect(await gcs.head('t/1/x.pdf')).toEqual({ sizeBytes: 3, contentType: 'application/pdf' });
    await gcs.presignGet('t/1/x.pdf', {
      expiresInSeconds: 300,
      fileName: 'ใบแจ้งหนี้.pdf',
      contentType: 'application/pdf',
    });
    expect(f.signed[2]).toMatchObject({ action: 'read', responseType: 'application/pdf' });
  });
});

describe('GCP Secret Manager (D-207, UNVERIFIED against the live provider)', () => {
  it('maps path-like ids to Secret Manager ids', () => {
    expect(gcpSecretId('getproperty/payments/platform/kbank/GP-PLATFORM')).toBe(
      'getproperty--payments--platform--kbank--GP-PLATFORM',
    );
    expect(gcpSecretId('a.b/c d')).toBe('a_b--c_d');
  });

  it('reads the latest version of a JSON secret', async () => {
    const urls: string[] = [];
    const auth = {
      getClient: () =>
        Promise.resolve({
          request: (o: { url: string }) => {
            urls.push(o.url);
            return Promise.resolve({
              data: {
                payload: { data: Buffer.from(JSON.stringify({ apiKey: 'k', n: 1 })).toString('base64') },
              },
            });
          },
        }),
    };
    const secrets = new GcpSecretsProvider({ projectId: 'gp-uat', auth: auth as never });
    expect(await secrets.getJsonSecret('getproperty/payments/tenant/kbank/M-1')).toEqual({
      apiKey: 'k',
      n: '1',
    });
    expect(urls[0]).toBe(
      'https://secretmanager.googleapis.com/v1/projects/gp-uat/secrets/getproperty--payments--tenant--kbank--M-1/versions/latest:access',
    );
  });
});
