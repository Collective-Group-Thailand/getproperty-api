import { createHash } from 'node:crypto';
import { type Readable } from 'node:stream';

import { Logger } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';

import { type ObjectStorage } from '../s3/object-storage.port';
import {
  isPdfRenderResult,
  PDF_RENDER_INLINE_HTML_MAX_BYTES,
  PDF_RENDER_JOB_NAME,
  PDF_RENDER_QUEUE,
  PDF_RENDER_TMP_PREFIX,
  type PdfRenderJobV1,
  pdfRenderKey,
  type PdfRenderResultV1,
} from './pdf-render-contract';
import { type PdfRendererPort, type PdfRenderOptions } from './pdf-renderer.port';

/** How a render job reaches the consumer and its result comes back (BullMQ in production, in-process in tests). */
export interface PdfRenderTransport {
  /** Enqueues the job (idempotent on its id) and resolves with the job's return value; rejects on failure / timeout. */
  run(job: PdfRenderJobV1, waitMs: number): Promise<unknown>;
  close(): Promise<void>;
}

export class PdfRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfRenderError';
  }
}

/**
 * The shared `pdf-render` queue on the platform's Valkey (`PDF_RENDER_REDIS_URL`, BullMQ prefix
 * `PDF_RENDER_QUEUE_PREFIX`; docs/pdf-render-queue.md). The job id is the render's idempotency key, so a repeated
 * render of the same input joins the job already queued or returns the completed one; a job that failed before is
 * retried once more instead of answering its old error. Producer-side only — getpack's worker consumes.
 */
export class BullmqPdfRenderTransport implements PdfRenderTransport {
  private readonly logger = new Logger(BullmqPdfRenderTransport.name);
  private readonly connection: Redis;
  private readonly eventsConnection: Redis;
  private readonly queue: Queue;
  private readonly events: QueueEvents;
  private ready: Promise<void> | null = null;

  constructor(url: string, prefix: string) {
    const options = { maxRetriesPerRequest: null, enableAutoPipelining: false, lazyConnect: true } as const;
    this.connection = new Redis(url, options);
    this.eventsConnection = new Redis(url, options);
    for (const c of [this.connection, this.eventsConnection])
      c.on('error', (e: Error) => this.logger.error(`pdf-render valkey: ${e.message}`));
    this.queue = new Queue(PDF_RENDER_QUEUE, { connection: this.connection, prefix });
    this.events = new QueueEvents(PDF_RENDER_QUEUE, { connection: this.eventsConnection, prefix });
  }

  private start(): Promise<void> {
    this.ready ??= this.events.waitUntilReady().then(() => undefined);
    return this.ready;
  }

  async run(job: PdfRenderJobV1, waitMs: number): Promise<unknown> {
    await this.start();
    const queued = await this.queue.add(PDF_RENDER_JOB_NAME, job, {
      jobId: job.idempotencyKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600 },
      removeOnFail: { age: 86_400 },
    });
    if ((await queued.getState()) === 'failed') await queued.retry('failed');
    return queued.waitUntilFinished(this.events, waitMs);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.events.close(), this.queue.close()]);
    // the QueueEvents connection sits in a blocking XREAD: QUIT would wait for it, so it is dropped
    this.eventsConnection.disconnect();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/**
 * `PDF_RENDERER_MODE=queue` (D-236, T-1): renders through the shared `pdf-render` queue instead of a local Chromium.
 * The HTML travels inline up to 256 KB, else as an object in this product's bucket under `tmp/pdf-render/`; the
 * consumer writes the PDF next to it, the result carries its key, SHA-256 and size, and this adapter reads the bytes
 * back and verifies them — callers keep computing their document hashes from the bytes they store (D-225), and the
 * port stays `render(html) → Buffer`. Temporary objects expire by the bucket lifecycle rule on `tmp/` (1 day); they are
 * not deleted here so a repeated render of the same input can reuse the completed job.
 */
export class QueuePdfRenderer implements PdfRendererPort {
  readonly mode = 'queue' as const;

  constructor(
    private readonly transport: PdfRenderTransport,
    private readonly storage: ObjectStorage,
    private readonly options: {
      bucket: string;
      /** `S3_KEY_PREFIX`: keys in the job are absolute in the bucket, keys towards `storage` are relative. */
      keyPrefix: string;
      product: string;
      renderTimeoutMs: number;
      waitTimeoutMs: number;
      now?: () => Date;
    },
  ) {}

  async render(html: string, options: PdfRenderOptions): Promise<Buffer> {
    const page = { paper: options.paper ?? 'a4', title: options.title, footer: options.footer };
    const id = pdfRenderKey(this.options.product, html, page);
    const rel = `${PDF_RENDER_TMP_PREFIX}${id}`;
    const absolute = (key: string) => `${this.options.keyPrefix}${key}`;
    let input: PdfRenderJobV1['input'];
    if (Buffer.byteLength(html, 'utf8') > PDF_RENDER_INLINE_HTML_MAX_BYTES) {
      await this.storage.put(`${rel}.html`, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
      input = { bucket: this.options.bucket, htmlKey: absolute(`${rel}.html`) };
    } else {
      input = { html };
    }
    const job: PdfRenderJobV1 = {
      v: 1,
      product: this.options.product,
      idempotencyKey: id,
      input,
      page,
      output: { bucket: this.options.bucket, key: absolute(`${rel}.pdf`) },
      timeoutMs: this.options.renderTimeoutMs,
      requestedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    let raw: unknown;
    try {
      raw = await this.transport.run(job, this.options.waitTimeoutMs);
    } catch (error) {
      throw new PdfRenderError(`pdf-render job ${id} failed: ${(error as Error).message}`, { cause: error });
    }
    if (!isPdfRenderResult(raw)) throw new PdfRenderError(`pdf-render job ${id} returned no valid result`);
    const result: PdfRenderResultV1 = raw;
    if (result.bucket !== job.output.bucket || result.key !== job.output.key)
      throw new PdfRenderError(
        `pdf-render job ${id} wrote ${result.bucket}/${result.key}, not the requested key`,
      );
    const bytes = await readAll(await this.storage.getStream(`${rel}.pdf`));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== result.bytes || sha256 !== result.sha256)
      throw new PdfRenderError(
        `pdf-render job ${id}: the stored PDF does not match the result (size or SHA-256)`,
      );
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw new PdfRenderError(`pdf-render job ${id}: the stored object is not a PDF`);
    return bytes;
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
