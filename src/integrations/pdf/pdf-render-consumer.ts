import { createHash } from 'node:crypto';
import { type Readable } from 'node:stream';

import { type ObjectStorage } from '../s3/object-storage.port';
import { type PdfRenderJobV1, type PdfRenderResultV1 } from './pdf-render-contract';
import { type PdfRendererPort } from './pdf-renderer.port';
import { type PdfRenderTransport } from './queue-pdf-renderer';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/**
 * The consumer side of `pdf-render` v1 as `docs/pdf-render-queue.md` requires it of getpack's worker — the executable
 * reference for that document, used by this repository's tests (and nowhere in production: getpack owns the
 * Chromium). Validates the job, reads the HTML (inline or from the producer's bucket), renders, writes
 * `application/pdf` to `output.key` and answers key, SHA-256 and size.
 */
export async function consumePdfRenderJob(
  job: PdfRenderJobV1,
  deps: {
    /** The producer's bucket (the consumer resolves `bucket` → a client allowed on that bucket's `tmp/pdf-render/`). */
    bucket: (name: string) => ObjectStorage;
    /** Strip the producer's key prefix: the storage port prefixes keys itself. */
    relativeKey: (key: string) => string;
    renderer: PdfRendererPort;
    rendererName: string;
    now?: () => Date;
  },
): Promise<PdfRenderResultV1> {
  if (job.v !== 1) throw new Error(`unsupported pdf-render contract version ${String(job.v)}`);
  if (!/^tmp\/pdf-render\//.test(deps.relativeKey(job.output.key)))
    throw new Error('output.key must lie under tmp/pdf-render/');
  const html =
    'html' in job.input
      ? job.input.html
      : (
          await readAll(await deps.bucket(job.input.bucket).getStream(deps.relativeKey(job.input.htmlKey)))
        ).toString('utf8');
  const pdf = await deps.renderer.render(html, { ...job.page });
  const out = deps.bucket(job.output.bucket);
  await out.put(deps.relativeKey(job.output.key), pdf, 'application/pdf');
  return {
    v: 1,
    bucket: job.output.bucket,
    key: job.output.key,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    bytes: pdf.length,
    pages: null,
    renderer: deps.rendererName,
    renderedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}

/** Runs the reference consumer in-process (tests; no Valkey). Idempotent on the job id like BullMQ. */
export class InProcessPdfRenderTransport implements PdfRenderTransport {
  readonly jobs: PdfRenderJobV1[] = [];
  private readonly done = new Map<string, PdfRenderResultV1>();

  constructor(private readonly consume: (job: PdfRenderJobV1) => Promise<PdfRenderResultV1>) {}

  async run(job: PdfRenderJobV1): Promise<unknown> {
    const hit = this.done.get(job.idempotencyKey);
    if (hit) return hit;
    this.jobs.push(job);
    const result = await this.consume(job);
    this.done.set(job.idempotencyKey, result);
    return result;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
