import { createHash } from 'node:crypto';

/**
 * The shared `pdf-render` queue contract (D-236, blueprint T-1, A-8; `docs/pdf-render-queue.md` is normative — keep
 * both in step). Producers (getproperty, later getpop) enqueue BullMQ jobs on the platform's shared Valkey; getpack's
 * worker — the one Chromium on the box (locked decision 12) — renders them and writes the PDF into the producer's own
 * bucket. Version 1.
 */
export const PDF_RENDER_QUEUE = 'pdf-render';
export const PDF_RENDER_JOB_NAME = 'render';
export const PDF_RENDER_CONTRACT_VERSION = 1;
/** HTML larger than this travels through the producer's bucket (`input.htmlKey`), never inline in Valkey. */
export const PDF_RENDER_INLINE_HTML_MAX_BYTES = 256 * 1024;
/** Object key prefix of render inputs / outputs in the producer's bucket (S3 lifecycle: expire after 1 day). */
export const PDF_RENDER_TMP_PREFIX = 'tmp/pdf-render/';

export type PdfRenderPaper = 'a4' | 'thermal_80mm';

/** BullMQ job data (`queue = pdf-render`, `name = render`, `jobId = idempotencyKey`). */
export interface PdfRenderJobV1 {
  v: 1;
  /** Producing product (`getproperty`); the consumer logs and meters per product. */
  product: string;
  /** = the BullMQ job id: `<product>-<sha256 of html + page options>` (BullMQ ids may not contain `:`) — the same input renders once. */
  idempotencyKey: string;
  input: { html: string } | { bucket: string; htmlKey: string };
  page: {
    paper: PdfRenderPaper;
    /** PDF metadata title. */
    title: string;
    /** A4 only: footer text left, "page x / y" right; thermal: no footer. */
    footer: string;
  };
  /** Where the consumer writes the PDF (the producer's bucket; `application/pdf`, SSE-S3). */
  output: { bucket: string; key: string };
  /** Upper bound for the consumer's own render (ms); the job fails after it. */
  timeoutMs: number;
  requestedAt: string;
}

/** BullMQ job return value. */
export interface PdfRenderResultV1 {
  v: 1;
  bucket: string;
  key: string;
  /** Hex SHA-256 of the stored bytes; the producer verifies it after reading the object. */
  sha256: string;
  bytes: number;
  pages: number | null;
  /** Consumer build, e.g. `getpack-worker@1.8.0 chromium/140`. */
  renderer: string;
  renderedAt: string;
}

/** The deterministic idempotency key of a render: same product, HTML and page options → same job. */
export function pdfRenderKey(product: string, html: string, page: PdfRenderJobV1['page']): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([PDF_RENDER_CONTRACT_VERSION, page.paper, page.title, page.footer]))
    .update('\n')
    .update(html, 'utf8')
    .digest('hex');
  return `${product}-${digest}`;
}

/** Structural check of a result (the producer never trusts the queue blindly). */
export function isPdfRenderResult(value: unknown): value is PdfRenderResultV1 {
  const r = value as Partial<PdfRenderResultV1> | null;
  return (
    !!r &&
    r.v === 1 &&
    typeof r.bucket === 'string' &&
    typeof r.key === 'string' &&
    typeof r.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(r.sha256) &&
    typeof r.bytes === 'number' &&
    r.bytes > 0
  );
}
