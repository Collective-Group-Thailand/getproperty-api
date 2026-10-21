# `pdf-render` — the shared PDF queue of the Collective platform (contract v1)

> Owner of this contract: **getproperty-api** (producer, first user) — D-236, blueprint task T-1, infrastructure ask
> A-8. Consumer and owner of the Chromium: **getpack's worker** (locked decision 12: one Chromium per box). Referenced
> by collective-infra (`PLAN.md`, `platform/products/getproperty/docker-compose.yml`). Changes are additive within v1;
> a breaking change is v2 with both versions consumed during the switch. Executable reference of every rule below:
> `src/integrations/pdf/pdf-render-contract.ts` (types), `queue-pdf-renderer.ts` (producer),
> `pdf-render-consumer.ts` (the consumer behaviour getpack implements; used by getproperty's tests),
> `test/integration/pdf-render-queue.int-spec.ts` (BullMQ end to end against a real Valkey/Redis).

## 1. Status (2026-10-22)

| Side | State |
|---|---|
| getproperty producer | **implemented** — `PDF_RENDERER_MODE=queue` (`QueuePdfRenderer`), tested against BullMQ + Redis 7 |
| getpack consumer | **not deployed** — getpack-api renders in-process with Puppeteer behind its `PdfRenderer` port (`src/integrations/pdf/pdf-renderer.port.ts`); its PDF work is finished locally but not deployed (founder, 2026-10-22). The requirements in §6 are what the getpack worker must add |
| Production setting | `PDF_RENDERER_MODE=real` (getproperty's own Chromium, worker 1.5 GB) **until §6 is deployed** — ADR-0012, D-242 (O-015 resolved). collective-infra: `GETPROPERTY_PDF_RENDERER_MODE=real\|queue`, `GETPROPERTY_WORKER_MEMORY` |

## 2. Transport

| | |
|---|---|
| Broker | the platform's Valkey 8 (`noeviction`, persistence on), logical DB **15**, reserved by collective-infra for **shared platform queues** (products use DBs 0–14; a URL without a DB number lands in 0, so 0 is never the shared DB) — `PDF_RENDER_REDIS_URL` on the producer (`redis://:<pw>@platform-valkey-1:6379/15`, built by the getproperty post-secrets hook from `REDIS_URL`), the same URL on the consumer. Products keep their own queues in their own logical DB |
| Queue | BullMQ queue **`pdf-render`**, key prefix **`collective`** (`PDF_RENDER_QUEUE_PREFIX`) |
| Job name | `render` |
| Job id | the job's `idempotencyKey`: `<product>-<hex sha256(contract version, paper, title, footer, "\n", html)>` (BullMQ ids may not contain `:`). The same input is one job: a second `add` returns the queued or completed job |
| Producer options | `attempts: 3`, `backoff: exponential 2 s`, `removeOnComplete: { age: 3600 }`, `removeOnFail: { age: 86400 }`; a job found `failed` is retried once more (`job.retry('failed')`) instead of answering its old error |
| Waiting | the producer waits with `QueueEvents` / `job.waitUntilFinished` up to `PDF_RENDER_QUEUE_TIMEOUT_MS` (default 120 s); a timeout or failure is an error for the caller (getproperty: the event subscriber's `prepare()` throws and the outbox retries later — rendering never holds a database transaction, D-225) |

## 3. Job data (v1)

```jsonc
{
  "v": 1,
  "product": "getproperty",
  "idempotencyKey": "getproperty-3f0c…",                // = job id
  "input": { "html": "<!doctype html>…" },               // ≤ 256 KB UTF-8 inline, otherwise:
  // "input": { "bucket": "collective-prod-getproperty-assets", "htmlKey": "tmp/pdf-render/getproperty-3f0c….html" },
  "page": {
    "paper": "a4",                                       // a4 | thermal_80mm
    "title": "ใบแจ้งหนี้ INV202611-0042",                 // PDF metadata title
    "footer": "INV202611-0042 · sha256 9a1f…"            // a4: left footer, "page x / y" right; thermal: none
  },
  "output": { "bucket": "collective-prod-getproperty-assets", "key": "tmp/pdf-render/getproperty-3f0c….pdf" },
  "timeoutMs": 30000,                                    // the consumer's own render budget
  "requestedAt": "2026-11-01T00:15:03.120Z"
}
```

- HTML is self-contained: fonts (Sarabun, embedded as `data:` URLs), images and CSS inline; **no network** is needed or
  allowed while rendering; JavaScript is not needed.
- Keys are absolute in the bucket (the producer's `S3_KEY_PREFIX` included; empty on the platform).
- Personal data: invoices, receipts, contracts and tax documents carry names, unit numbers, amounts and possibly tax
  ids. Job data lives in Valkey ≤ 1 h after completion (≤ 24 h after failure); objects under `tmp/pdf-render/` expire
  after 1 day by lifecycle rule. Neither side logs the HTML or the PDF.

## 4. Result (BullMQ return value, v1)

```jsonc
{
  "v": 1,
  "bucket": "collective-prod-getproperty-assets",
  "key": "tmp/pdf-render/getproperty-3f0c….pdf",       // exactly output.key
  "sha256": "9a1f…",                                    // hex SHA-256 of the stored bytes
  "bytes": 48213,
  "pages": 2,                                           // null when unknown
  "renderer": "getpack-worker@1.8.0 chromium/140",
  "renderedAt": "2026-11-01T00:15:04.010Z"
}
```

The producer reads the object, checks size, SHA-256, the `%PDF-` header and that the key is the one it asked for, and
only then hands the bytes to the caller; the caller stores the document under its own key and computes its own hash
from the stored bytes (D-225). A mismatch is an error (the subscriber retries).

## 5. Timeouts, retries, capacity

- Consumer render budget `timeoutMs` (getproperty: `PDF_RENDER_TIMEOUT_MS`, 30 s); BullMQ retries a failed attempt
  twice (2 s, 4 s). Producer wait 120 s covers queueing at the bill-day peak.
- Volume (blueprint A-8): pilot ≈ 600 PDFs/month (300 invoices + 300 receipts); Phase 4 ≈ 120,000/month; peak at the
  billing cut-off ≈ 300 within 60 s. Consumer concurrency 2–4 pages on the shared Chromium keeps the peak under the
  producer's wait.

## 6. Requirements on the consumer (getpack worker — not implemented there yet)

1. A BullMQ `Worker` on queue `pdf-render`, prefix `collective`, the shared-queue Valkey URL; concurrency 2–4; one
   Chromium per box (the one getpack already runs), JavaScript disabled, every network request except `data:` aborted.
2. Accept job data v1 (§3): reject other `v` values and any `output.key` / `input.htmlKey` outside
   `tmp/pdf-render/` with a non-retryable failure (`UnrecoverableError`).
3. Paper: `a4` = A4, margins 16/16/18/16 mm, footer `page.footer` left and `page x / y` right, 7 px, `#555`;
   `thermal_80mm` = 80 mm wide, height = content height + 8 mm, margins 3 mm, no header/footer (receipt printers,
   B4.3). Thai text must render with the embedded Sarabun (no system font substitution: `--font-render-hinting=none`).
   Set the PDF title from `page.title`.
4. Read `input.htmlKey` from and write `output.key` to the **producer's bucket** with `ContentType: application/pdf`
   and SSE-S3; return §4. collective-infra grants getpack's instance role `s3:GetObject` + `s3:PutObject` on
   `arn:aws:s3:::collective-<env>-getproperty-assets/tmp/pdf-render/*` only (and the bucket's lifecycle rule expires
   `tmp/` after 1 day).
5. Never log HTML, PDF bytes or the rendered text; log job id, product, paper, duration, bytes.
6. Metrics: `pdf_render_jobs_total{product,paper,outcome}`, `pdf_render_duration_seconds{product,paper}`, queue
   depth (BullMQ `getJobCounts`) on getpack-worker's `/metrics`.
7. Memory: the Chromium stays inside getpack's 3.2 GB budget (locked decision 14).

## 7. Switching getproperty to the queue

When §6 is deployed on a box: set `GETPROPERTY_PDF_RENDERER_MODE=queue` and `GETPROPERTY_WORKER_MEMORY=512M` in
collective-infra `platform/env/<env>.env` (the compose maps it to `PDF_RENDERER_MODE`, and `PDF_RENDER_REDIS_URL` into
getproperty's env), deploy, render one invoice and one receipt on UAT (RUNBOOK §12), then remove Chromium from the
api image (Dockerfile) and the worker's `shm_size` — the end of ADR-0012's interim.
