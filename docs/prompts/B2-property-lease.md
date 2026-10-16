# B2 — Property, tenants, leases, deposits & inspections

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, `docs/schema-design.md` ก่อน · ต้องทำ B1 เสร็จแล้ว · ทำทีละ Deliverable (2.1 → 2.4) ต่อ 1 session · Plan Mode ทุกครั้ง

---

You are a senior backend engineer on **`getproperty-api`**. This prompt builds the property and lease domain that metering (B3) and billing (B4) attach to. Decisions D-010, D-020, D-023, D-025, D-060–D-064 rule here.

## Deliverable 2.1 — Properties, floors, rooms, room types, common-area meters points
1. Migrations per `schema-design.md`: `properties` (name, address, geo, billing cycle settings reference, utility accounts: MEA/PEA customer number, MWA/PWA, VAT status inherited from org), `floors`, `room_types` (size, default rent, default lease lines), `rooms` (code, type, floor, status `vacant | reserved | occupied | maintenance | inactive`, meter points), `meter_points` (`electric | water`, `room | common_area | main`, physical location, current `meter_id` nullable until B3 binds a device or a manual meter record), `amenities`.
2. Endpoints `/v1/owner/properties*`, `/rooms*`, bulk room creation (floor × pattern `A-{floor}{nn}`), Excel import/export of rooms (template download, validate, preview, commit), room map data (`GET /v1/owner/properties/{id}/map` → floors with room cards: status, tenant name, balance, meter health — later fields null until B3/B4).
3. Room status transitions are driven by leases (B2.3) and maintenance (B5); manual override only `vacant ↔ inactive | maintenance` with a reason and audit.
4. Acceptance: e2e create property → bulk rooms → import Excel → map; cross-org 404s; room-count snapshot endpoint for subscriptions (B6) returns rooms ≠ `inactive`.

## Deliverable 2.2 — Tenants, invitations, LINE linking
1. `tenants` (person: names, phone, nationality, language, document type/number **encrypted**, document file refs with retention class `id_document`, emergency contact, consent state), `tenant_links` (tenant ↔ user/LINE account), `invitations` (lease-bound, QR + SMS link, expiry, state).
2. Endpoints: owner/staff create tenant (minimal fields; documents optional until contract signing), invite to a lease (`POST /v1/owner/leases/{id}/invitations` → LINE QR image + SMS), tenant accepts (`POST /v1/tenant/invitations/{code}/accept` after LINE login + consent D-025), one LINE account across several leases, unlink with Owner approval.
3. PDPA: consent capture with purpose versions on first tenant login; `GET /v1/tenant/me/privacy`, DSR entry points; ID document images downloadable only by Owner/Manager with audit.
4. Acceptance: e2e invite → LINE login (fake) → consent → accept → `/v1/tenant/me` lists the lease; document access audited; tenant of org A cannot be invited to org B's lease.

## Deliverable 2.3 — Leases, standard contract, e-signature, notices
1. `lease_templates` (platform-provided **สคบ. standard contract** text, versioned, th; org may add an addendum within allowed clauses — the compliance engine lists forbidden clause types), `leases` (room, tenant(s), term, start/end, rent, deposit, advance rent, lease lines: fixed monthly items with amount and type, billing day, utility billing mode: metered at tariff / included, parking, keys; state `draft → pending_signature → active → notice_given → ending → ended | terminated`), `lease_signatures` (signer, method, OTP ref, LINE user id, signed PDF file, sha256, ip, ua), `lease_events`.
2. Compliance at lease creation (D-020/D-023): deposit + advance ≤ cap setting; forbidden clauses blocked; utility mode `metered` requires tariff-capped billing (B4); renewal fee not allowed; mid-term rent increase only if the lease recorded it at signing.
3. Endpoints: owner CRUD drafts, preview contract PDF, send for signature; tenant views contract in LIFF, signs (draw-to-sign, OTP, D-062); owner countersigns; activation sets room `occupied` and opens deposit receipt (2.4); **30-day notice** by tenant (`POST /v1/tenant/leases/{id}/notice`) or owner (with legal reason codes); renewal (new lease from old, pre-filled); termination with reason and evidence; lease history; `GET /v1/tenant/leases/{id}/contract` (signed PDF).
4. Documents: contract PDF (Puppeteer, Thai fonts, both signatures, hash in footer) through the `documents` module stub (full module in B4.3; here only the renderer and the file).
5. Acceptance: golden test of the contract PDF text for a sample lease; e2e draft → sign (tenant) → countersign → active → notice → ending → ended; deposit above cap refused with `compliance.deposit_cap` + `legalRef`; forbidden clause refused.

## Deliverable 2.4 — Deposits, move-in/out inspections, settlement
1. `deposits` (lease, amounts received per type, receipt doc ref, state `held → settling → refunded | forfeited_partially | disputed`), `deposit_settlements` (opened_at, deadline = ended_at + 7 days, inspection ref, damage items with evidence file refs and amounts, utilities final bill ref (B4), proposed refund, tenant response, refund record with transfer evidence, closed_at), `inspections` (type `move_in | move_out`, checklist per room type, items with condition + photos, signatures), `inspection_templates`.
2. Flow (D-023): activation → deposit receipt; lease ending → move-out inspection task for staff (B5 queue; here an endpoint) → comparison view move-in vs move-out per item → owner proposes settlement (deductions require a damage item + photo; normal wear category cannot be deducted — rule `compliance.deposit_wear`) → tenant accepts or disputes in LIFF → refund recorded (bank transfer reference) → closed. Deadline reminders to owner at T-3, T-1, overdue; dashboard counter.
3. Endpoints under `/v1/owner/deposits*`, `/v1/staff/inspections*`, `/v1/tenant/deposits*`.
4. Acceptance: e2e full flow with a deduction accepted and one disputed; deduction without evidence refused; refund after deadline flagged `late` in the audit and the org's compliance score (B6 analytics).

After each deliverable: `docs/PROGRESS.md`, contract regenerated, commit.
