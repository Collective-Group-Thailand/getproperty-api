import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { S3ObjectStorage } from './s3-object-storage';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

/**
 * An in-process S3-compatible stand-in (path-style, like LocalStack): records each request and answers the handful
 * of operations the adapter uses with the documented XML shapes. No network beyond 127.0.0.1.
 */
function s3Stub() {
  const seen: Seen[] = [];
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? '',
        path: decodeURIComponent(url.pathname),
        query: url.searchParams,
        headers: req.headers,
        body: body.toString('utf8'),
      });
      const key = decodeURIComponent(url.pathname).replace(/^\/[^/]+\//, '');
      const xml = (status: number, text: string) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>${text}`);
      };
      const q = url.searchParams;
      if (req.method === 'HEAD' && url.pathname.split('/').filter(Boolean).length === 1) {
        res.writeHead(200);
        return res.end();
      }
      if (req.method === 'POST' && q.has('uploads'))
        return xml(
          200,
          `<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>`,
        );
      if (req.method === 'GET' && q.has('uploadId')) {
        const second = q.get('part-number-marker') === '1';
        return xml(
          200,
          second
            ? '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><ETag>"e2"</ETag><Size>3</Size></Part></ListPartsResult>'
            : '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>"e1"</ETag><Size>5242880</Size></Part></ListPartsResult>',
        );
      }
      if (req.method === 'POST' && q.has('uploadId'))
        return xml(
          200,
          `<CompleteMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><ETag>"m-2"</ETag></CompleteMultipartUploadResult>`,
        );
      if (req.method === 'DELETE' && q.has('uploadId')) {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'PUT' && req.headers['x-amz-copy-source'])
        return xml(200, '<CopyObjectResult><ETag>"c"</ETag></CopyObjectResult>');
      if (req.method === 'PUT') {
        objects.set(key, { body, contentType: String(req.headers['content-type'] ?? '') });
        res.writeHead(200, { etag: '"p"' });
        return res.end();
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        const o = objects.get(key);
        if (!o) {
          if (req.method === 'HEAD') {
            res.writeHead(404);
            return res.end();
          }
          return xml(404, '<Error><Code>NoSuchKey</Code><Message>nf</Message></Error>');
        }
        res.writeHead(200, { 'content-type': o.contentType, 'content-length': String(o.body.length) });
        return res.end(req.method === 'GET' ? o.body : undefined);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      xml(400, '<Error><Code>Unsupported</Code></Error>');
    });
  };
  return { server: createServer(handler), seen, objects };
}

async function streamText(r: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

describe('S3 object storage (D-230: production path, same adapter as getpack)', () => {
  const env = { ...process.env };
  let stub: ReturnType<typeof s3Stub>;
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    // LocalStack-style dummy keys; deployments use the ECS task role (default provider chain).
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    stub = s3Stub();
    server = stub.server;
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    process.env = env;
    await new Promise<void>((done) => server.close(() => done()));
  });

  const storage = (keyPrefix = 'getproperty/') =>
    new S3ObjectStorage({
      region: 'ap-southeast-1',
      bucket: 'gp-test-documents',
      endpoint,
      forcePathStyle: true,
      keyPrefix,
    });

  it('presigns V4 PUT and GET (ap-southeast-1, key prefix, content type signed, attachment file name)', async () => {
    const s = storage();
    const put = await s.presignPut('t/1/a.jpg', {
      contentType: 'image/jpeg',
      contentLength: 10,
      expiresInSeconds: 300,
    });
    const u = new URL(put.url);
    expect(u.pathname).toBe('/gp-test-documents/getproperty/t/1/a.jpg');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Credential')).toContain('/ap-southeast-1/s3/aws4_request');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(put.headers).toEqual({ 'Content-Type': 'image/jpeg' });

    const get = new URL(
      await s.presignGet('t/1/a.jpg', {
        expiresInSeconds: 60,
        fileName: 'ใบเสร็จ.pdf',
        contentType: 'application/pdf',
      }),
    );
    expect(get.pathname).toBe('/gp-test-documents/getproperty/t/1/a.jpg');
    expect(get.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(get.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('ใบเสร็จ.pdf')}`,
    );

    const part = new URL(await s.presignPart('t/1/big.mp4', 'up-1', 3, 600));
    expect(part.searchParams.get('partNumber')).toBe('3');
    expect(part.searchParams.get('uploadId')).toBe('up-1');
    expect(part.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  it('a presigned PUT works with a plain HTTP client (what the browser does)', async () => {
    const s = storage();
    const put = await s.presignPut('t/1/slip.png', {
      contentType: 'image/png',
      contentLength: 3,
      expiresInSeconds: 60,
    });
    const res = await fetch(put.url, { method: 'PUT', headers: put.headers, body: 'png' });
    expect(res.status).toBe(200);
    expect(stub.objects.get('getproperty/t/1/slip.png')?.body.toString()).toBe('png');
  });

  it('multipart: initiate, list parts across pages, complete in part order, abort', async () => {
    const s = storage();
    expect(await s.createMultipart('t/1/big.mp4', 'video/mp4')).toBe('up-1');
    expect(await s.listParts('t/1/big.mp4', 'up-1')).toEqual([
      { partNumber: 1, etag: '"e1"', sizeBytes: 5242880 },
      { partNumber: 2, etag: '"e2"', sizeBytes: 3 },
    ]);
    await s.completeMultipart('t/1/big.mp4', 'up-1', [
      { partNumber: 1, etag: '"e1"' },
      { partNumber: 2, etag: '"e2"' },
    ]);
    const complete = stub.seen.find((r) => r.method === 'POST' && r.query.has('uploadId'))!;
    expect(complete.path).toBe('/gp-test-documents/getproperty/t/1/big.mp4');
    expect(complete.body).toContain(
      '<Part><ETag>&quot;e1&quot;</ETag><PartNumber>1</PartNumber></Part><Part><ETag>&quot;e2&quot;</ETag><PartNumber>2</PartNumber></Part>',
    );
    await s.abortMultipart('t/1/big.mp4', 'up-1');
    expect(stub.seen.some((r) => r.method === 'DELETE' && r.query.get('uploadId') === 'up-1')).toBe(true);
  });

  it('put / head / stream / copy / delete under the prefix; head of a missing key is null; ping heads the bucket', async () => {
    const s = storage();
    await s.ping();
    await s.put('t/2/doc.pdf', Buffer.from('%PDF'), 'application/pdf');
    expect(await s.head('t/2/doc.pdf')).toEqual({ sizeBytes: 4, contentType: 'application/pdf' });
    expect(await s.head('t/2/missing.pdf')).toBeNull();
    expect(await streamText(await s.getStream('t/2/doc.pdf'))).toBe('%PDF');
    await s.copy('t/2/doc.pdf', 't/2/copy ก.pdf');
    const copy = stub.seen.find((r) => r.headers['x-amz-copy-source'])!;
    expect(copy.path).toBe('/gp-test-documents/getproperty/t/2/copy ก.pdf');
    expect(decodeURIComponent(String(copy.headers['x-amz-copy-source']))).toBe(
      'gp-test-documents/getproperty/t/2/doc.pdf',
    );
    await s.delete('t/2/doc.pdf');
    expect(stub.objects.has('getproperty/t/2/doc.pdf')).toBe(false);
  });

  it('without a prefix keys sit at the bucket root', async () => {
    const url = new URL(
      await storage('').presignGet('t/3/x.jpg', {
        expiresInSeconds: 60,
        fileName: 'x.jpg',
        contentType: 'image/jpeg',
      }),
    );
    expect(url.pathname).toBe('/gp-test-documents/t/3/x.jpg');
  });
});
