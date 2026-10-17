# ADR-0008 — Payment adapters and the no-funds-held model

**Status:** Accepted (2026-10-17, B4.1; implemented in B4.4) — founder pre-approved recommendation (D-197)
**Decision ids:** D-042, D-043, D-044, D-046, D-091, O-001 · schema-design v2 §3.2.4, §3.3.5

## Context
D-011's loop ends with "paid by Thai QR and confirmed by the bank". D-042 fixes the money model: every invoice gets a dynamic Thai QR (PromptPay, EMVCo tag 30 "bill payment") with a unique reference, the **tenant's own bank or merchant account receives the money**, and the platform never holds funds — getproperty is not a payment agent (no e-money licence question, ⚖ to confirm). Which gateway the pilot uses is open (O-001: KBank, SCB, Opn), each tenant may use a different one, and none of them can be called from this sandbox.

## Decision
- **Port `QrPaymentAdapter`** (`src/integrations/payments`): `createQr({ amount, reference, account, expiresAt })` → EMVCo payload (+ provider QR id), `queryStatus(reference)`, `parseWebhook(headers, rawBody)` → verified events (signature check is the adapter's first step; an unverifiable request is refused 401 and logged without the body), `parseSettlement(file)` → statement rows. Providers: **KBank**, **SCB**, **Opn** — real adapters written to the providers' published API documents and marked `// UNVERIFIED against live provider` — and a **fake** that signs webhooks with a test secret and builds settlement CSVs (dev, tests). A provider is usable only when its feature flag (`payments.provider.kbank|scb|opn`) is on.
- **Per-tenant configuration**: the provider and merchant reference live on the tenant's own `platform.tenant_bank_account` (confirmed by Owner OTP, D-091); the QR is generated for that account (PromptPay id or the provider's biller id). Credentials for provider APIs are per tenant secrets (references only in the row, never logged). No platform account ever appears in a QR.
- **Reference = invoice number** (`ops.invoice.promptpay_ref`, `ops.payment_qr_code.reference`, unique per provider); a webhook pays an invoice only when the reference resolves **inside the tenant that owns the bank account** the provider reported (tenant B's reference can never pay tenant A's invoice).
- **Webhooks** (`POST /webhooks/payments/{provider}`): signature verified, idempotent on `(provider, provider_ref)` (unique index + `platform.event_consumption`), 200 for duplicates; the payment is confirmed in one transaction with its allocations and the invoice status, and `invoice.paid` drives the receipt (a subscriber, never inline).
- **Daily settlement reconcile**: the worker fetches/receives each provider's statement, creates payments for rows whose webhook never arrived (`confirmed_via = settlement_file`), and records discrepancies (unknown references, amount mismatches) for the owner.
- **Fallback**: slip upload → slip-verify adapter (EasySlip/SlipOK-class; fake + real UNVERIFIED) → auto-confirm when amount, receiving account and uniqueness match, else the owner review queue (D-043); manual cash/transfer records with evidence (audited).

## Alternatives considered
- **Platform-collected payments with payouts**: simpler reconciliation, but makes Collective a payment agent (licence, fund custody) — rejected by D-042.
- **Static PromptPay QR without reference**: no automatic matching; slips everywhere — the problem the product removes.

## Consequences
- Real adapters stay UNVERIFIED until the pilot bank's sandbox credentials exist (O-001); the fake proves the flow end to end.
- Overpayments become a credit of the payer (unallocated payment amount) with an advance receipt; refunds are recorded with transfer evidence — money still moves only between the resident and the tenant's account.
