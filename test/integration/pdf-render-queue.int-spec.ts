import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

import { FakeObjectStorage } from '@collective/integrations/storage';
import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { consumePdfRenderJob } from '@integrations/pdf/pdf-render-consumer';
import { PDF_RENDER_QUEUE, type PdfRenderJobV1 } from '@integrations/pdf/pdf-render-contract';
import {
  BullmqPdfRenderTransport,
  PdfRenderError,
  QueuePdfRenderer,
} from '@integrations/pdf/queue-pdf-renderer';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const REDIS_BIN = process.env.REDIS_SERVER_BIN ?? '/usr/bin/redis-server';

/**
 * T-1 (D-236): the shared `pdf-render` BullMQ queue end to end against a real Valkey/Redis — this repository's producer
 * (`PDF_RENDERER_MODE=queue`) and the reference consumer of docs/pdf-render-queue.md standing in for getpack's worker.
 */
// needs a redis-server binary (the sandbox and CI images have one); reported as skipped otherwise
const suite = existsSync(REDIS_BIN) ? describe : describe.skip;

suite('pdf-render queue over BullMQ (D-236, T-1)', () => {
  let server: ChildProcess;
  let url: string;
  let worker: Worker<PdfRenderJobV1>;
  let workerConnection: Redis;
  let processed = 0;
  let failNext = false;
  const storage = new FakeObjectStorage();
  let transport: BullmqPdfRenderTransport;
  let pdf: QueuePdfRenderer;

  beforeAll(async () => {
    const port = await freePort();
    server = spawn(REDIS_BIN, ['--port', String(port), '--save', '', '--appendonly', 'no'], {
      stdio: 'ignore',
    });
    url = `redis://127.0.0.1:${port}/3`;
    // wait for the server: one short-lived client per attempt, no automatic reconnects left behind
    for (let i = 0; i < 100; i += 1) {
      const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
      try {
        await probe.connect();
        await probe.quit();
        break;
      } catch {
        probe.disconnect();
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    workerConnection = new Redis(url, { maxRetriesPerRequest: null });
    worker = new Worker<PdfRenderJobV1>(
      PDF_RENDER_QUEUE,
      async (job) => {
        processed += 1;
        if (failNext) throw new Error('chromium crashed');
        return consumePdfRenderJob(job.data, {
          bucket: () => storage,
          relativeKey: (k) => k,
          renderer: new FakePdfRenderer(),
          rendererName: 'reference-consumer',
        });
      },
      { connection: workerConnection, prefix: 'collective' },
    );
    transport = new BullmqPdfRenderTransport(url, 'collective');
    pdf = new QueuePdfRenderer(transport, storage, {
      bucket: 'collective-uat-getproperty-assets',
      keyPrefix: '',
      product: 'getproperty',
      renderTimeoutMs: 10_000,
      waitTimeoutMs: 20_000,
    });
  }, 30_000);

  afterAll(async () => {
    await pdf?.close();
    await worker?.close();
    workerConnection?.disconnect();
    if (server && server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      await exited;
    }
  });

  it('renders through the queue and reads the verified PDF back; the same input is one job', async () => {
    const html = '<h1>ใบเสร็จรับเงิน RC-2026-0001</h1>';
    const first = await pdf.render(html, { title: 'RC-2026-0001', footer: 'sha256 abc', paper: 'a4' });
    expect(FakePdfRenderer.textOf(first)).toContain('ใบเสร็จรับเงิน RC-2026-0001');
    const again = await pdf.render(html, { title: 'RC-2026-0001', footer: 'sha256 abc', paper: 'a4' });
    expect(again.equals(first)).toBe(true);
    expect(processed).toBe(1);
  }, 30_000);

  it('a consumer failure (after its retries) is a PdfRenderError for the subscriber to retry later', async () => {
    failNext = true;
    const before = processed;
    await expect(pdf.render('<p>fails</p>', { title: 't', footer: 'f' })).rejects.toBeInstanceOf(
      PdfRenderError,
    );
    expect(processed - before).toBe(3); // attempts 3 with exponential backoff
    failNext = false;
    // the same input is retried instead of answering the stored failure
    const ok = await pdf.render('<p>fails</p>', { title: 't', footer: 'f' });
    expect(ok.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60_000);
});
