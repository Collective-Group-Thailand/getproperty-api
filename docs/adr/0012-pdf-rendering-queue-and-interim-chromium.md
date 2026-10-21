# ADR-0012 — PDF rendering: the shared `pdf-render` queue, getproperty's own Chromium as a time-boxed interim

**Status:** Accepted (2026-10-22, founder decision: O-015 resolved as recommended → D-242)
**Decision ids:** D-236, D-242, D-225, D-233 · locked decision 12 of collective-infra · blueprint T-1, A-8, T-11

## Context
Bills, receipts, tax documents, lease contracts / e-sign copies, statements and platform invoices are HTML rendered to
PDF (Sarabun embedded, A4 and the 80 mm thermal roll). Locked decision 12: one Chromium per box — getpack's worker —
and every other product uses the shared `pdf-render` BullMQ queue (HTML in → S3 key out) **or justifies its own
Chromium in an ADR with a 1.5 GB worker**. On 2026-10-22 getpack has no `pdf-render` queue: getpack-api renders
in-process with Puppeteer behind its `PdfRenderer` port; its PDF work is finished locally but not deployed. getproperty
must not wait for it to go live (pilot: ≈ 600 PDFs/month, each owner's invoice run depends on them).

## Decision
1. **The contract is defined now** (`docs/pdf-render-queue.md`, v1, owned by getproperty-api): queue `pdf-render`,
   prefix `collective`, job id = idempotency key (`<product>-<sha256>`), job data (inline HTML ≤ 256 KB or an object
   in the producer's bucket, page options, output bucket/key, timeout), result (key, SHA-256, bytes), retries, the
   consumer requirements for getpack's worker (the Chromium owner), and the S3 grant it needs.
2. **getproperty implements the producer** behind the existing `PdfRendererPort`: `PDF_RENDERER_MODE=queue`
   (`QueuePdfRenderer`), verified bytes back, no change for callers (rendering stays in subscribers' `prepare()`,
   hashes from the stored bytes — D-225). Tested against real BullMQ + Redis with the reference consumer.
3. **Interim — `PDF_RENDERER_MODE=real` stays the production setting** (own headless Chromium in the worker, the
   existing `PuppeteerPdfRenderer`) **until getpack's consumer is deployed on that box**. While it is active:
   - the worker container's limit is **1.5 GB** (`GETPROPERTY_WORKER_MEMORY=1536M` in collective-infra; getproperty
     ≈ 2.8 GB instead of 1.8 GB on the 16 GB prod box — inside the box because ClamAV left getproperty's compose, T-2);
   - Chromium runs only in the worker (the API process never renders; `shm_size` on the worker only);
   - the image keeps Debian's `chromium` package.
   `fake` remains for tests and `pnpm dev`; `real` also for local development of templates.
4. **Exit trigger (closes this ADR):** getpack's worker consumes `pdf-render` per §6 of the contract on the box →
   set `GETPROPERTY_PDF_RENDERER_MODE=queue`, `GETPROPERTY_WORKER_MEMORY=512M`, verify an invoice and a receipt on
   UAT, then remove Chromium from the Dockerfile and `shm_size` from the worker (T-1, T-11). Review at gate 2 at the
   latest: if the consumer is still not deployed then, the founder decides between a getproperty-owned consumer on
   the worker box and keeping the interim.

## Consequences
- + The pilot is not blocked by getpack's release; the switch is a two-line env change, reviewed.
- + The producer, the wire format and the consumer behaviour are tested here, so getpack implements against an
  executable reference.
- − Until the switch the box runs two Chromiums (getpack's and getproperty's) and getproperty exceeds its 1.8 GB line by
  ≈ 1 GB — accepted by the founder (O-015) for the interim only, visible in Grafana (`container_memory_working_set_bytes`).
- − The queue path's live behaviour (Valkey DB of shared queues, getpack's S3 grant on `tmp/pdf-render/`) is
  **UNVERIFIED** until the first deploy of the consumer.
