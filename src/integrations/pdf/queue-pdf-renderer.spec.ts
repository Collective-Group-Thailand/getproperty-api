import { FakeObjectStorage } from '../s3/fake-object-storage';
import { FakePdfRenderer } from './fake-pdf-renderer';
import { consumePdfRenderJob, InProcessPdfRenderTransport } from './pdf-render-consumer';
import { PDF_RENDER_INLINE_HTML_MAX_BYTES, type PdfRenderJobV1, pdfRenderKey } from './pdf-render-contract';
import { PdfRenderError, type PdfRenderTransport, QueuePdfRenderer } from './queue-pdf-renderer';

const PREFIX = 'gp/';

function setup(tamper?: (r: Awaited<ReturnType<typeof consumePdfRenderJob>>) => unknown) {
  const storage = new FakeObjectStorage();
  const renderer = new FakePdfRenderer();
  const consume = (job: PdfRenderJobV1) =>
    consumePdfRenderJob(job, {
      bucket: () => storage,
      relativeKey: (k) => k.slice(PREFIX.length),
      renderer,
      rendererName: 'reference-consumer',
    });
  const transport = new InProcessPdfRenderTransport(consume);
  const wrapped: PdfRenderTransport = tamper
    ? { run: async (job) => tamper(await consume(job)), close: () => Promise.resolve() }
    : transport;
  const pdf = new QueuePdfRenderer(wrapped, storage, {
    bucket: 'collective-uat-getproperty-assets',
    keyPrefix: PREFIX,
    product: 'getproperty',
    renderTimeoutMs: 30_000,
    waitTimeoutMs: 60_000,
  });
  return { storage, renderer, transport, pdf };
}

describe('QueuePdfRenderer — PDF_RENDERER_MODE=queue (D-236, T-1)', () => {
  it('sends small HTML inline, gets the PDF back from the bucket and verifies it', async () => {
    const { pdf, transport, storage } = setup();
    const out = await pdf.render('<p>ใบแจ้งหนี้ INV-1</p>', {
      title: 'INV-1',
      footer: 'sha',
      paper: 'thermal_80mm',
    });
    expect(out.subarray(0, 5).toString()).toBe('%PDF-');
    expect(FakePdfRenderer.textOf(out)).toContain('ใบแจ้งหนี้ INV-1');
    const job = transport.jobs[0]!;
    expect(job).toMatchObject({
      v: 1,
      product: 'getproperty',
      input: { html: '<p>ใบแจ้งหนี้ INV-1</p>' },
      page: { paper: 'thermal_80mm', title: 'INV-1', footer: 'sha' },
      output: { bucket: 'collective-uat-getproperty-assets' },
    });
    expect(job.idempotencyKey).toMatch(/^getproperty-[0-9a-f]{64}$/);
    expect(job.output.key).toBe(`gp/tmp/pdf-render/${job.idempotencyKey}.pdf`);
    expect(storage.objects.has(`tmp/pdf-render/${job.idempotencyKey}.pdf`)).toBe(true);
  });

  it('puts HTML over 256 KB into the bucket instead of Valkey', async () => {
    const { pdf, transport, storage } = setup();
    const big = `<p>${'x'.repeat(PDF_RENDER_INLINE_HTML_MAX_BYTES + 1)}</p>`;
    await pdf.render(big, { title: 'big', footer: 'f' });
    const job = transport.jobs[0]!;
    expect(job.input).toEqual({
      bucket: 'collective-uat-getproperty-assets',
      htmlKey: `gp/tmp/pdf-render/${job.idempotencyKey}.html`,
    });
    expect(storage.objects.get(`tmp/pdf-render/${job.idempotencyKey}.html`)?.body.toString()).toBe(big);
  });

  it('the same input is one job (idempotency key); different page options are another', async () => {
    const { pdf, transport } = setup();
    await pdf.render('<p>a</p>', { title: 't', footer: 'f' });
    await pdf.render('<p>a</p>', { title: 't', footer: 'f' });
    await pdf.render('<p>a</p>', { title: 't', footer: 'f', paper: 'thermal_80mm' });
    expect(transport.jobs).toHaveLength(2);
    expect(pdfRenderKey('getproperty', '<p>a</p>', { paper: 'a4', title: 't', footer: 'f' })).toBe(
      transport.jobs[0]!.idempotencyKey,
    );
  });

  it('refuses a result whose bytes, key or shape do not match, and wraps transport failures', async () => {
    await expect(
      setup((r) => ({ ...r, sha256: '0'.repeat(64) })).pdf.render('<p>a</p>', { title: 't', footer: 'f' }),
    ).rejects.toThrow(/does not match/);
    await expect(
      setup((r) => ({ ...r, key: 'gp/elsewhere.pdf' })).pdf.render('<p>a</p>', { title: 't', footer: 'f' }),
    ).rejects.toThrow(/not the requested key/);
    await expect(
      setup(() => ({ ok: true })).pdf.render('<p>a</p>', { title: 't', footer: 'f' }),
    ).rejects.toThrow(/no valid result/);
    const failing = new QueuePdfRenderer(
      { run: () => Promise.reject(new Error('timed out')), close: () => Promise.resolve() },
      new FakeObjectStorage(),
      { bucket: 'b', keyPrefix: '', product: 'getproperty', renderTimeoutMs: 1000, waitTimeoutMs: 1000 },
    );
    await expect(failing.render('<p>a</p>', { title: 't', footer: 'f' })).rejects.toBeInstanceOf(
      PdfRenderError,
    );
  });

  it('the reference consumer writes only under tmp/pdf-render/', async () => {
    const { renderer } = setup();
    const storage = new FakeObjectStorage();
    await expect(
      consumePdfRenderJob(
        {
          v: 1,
          product: 'getproperty',
          idempotencyKey: 'getproperty-x',
          input: { html: '<p/>' },
          page: { paper: 'a4', title: 't', footer: 'f' },
          output: { bucket: 'b', key: 'receipts/evil.pdf' },
          timeoutMs: 1000,
          requestedAt: new Date().toISOString(),
        },
        { bucket: () => storage, relativeKey: (k) => k, renderer, rendererName: 'r' },
      ),
    ).rejects.toThrow('tmp/pdf-render/');
  });
});
