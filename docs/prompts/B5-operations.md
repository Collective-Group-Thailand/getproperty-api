# B5 — Operations (R2): maintenance, access control, community, staff tasks

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, `docs/schema-design.md` ก่อน · ต้องทำ B1–B4 เสร็จแล้ว · ทำทีละ Deliverable (5.1 → 5.4) ต่อ 1 session · Plan Mode ทุกครั้ง
> R2 scope (D-014) — เริ่มหลัง pilot ของ R1 ขึ้นระบบแล้ว

---

You are a senior backend engineer on **`getproperty-api`**. Decisions D-024, D-034, D-070–D-073 rule here.

## Deliverable 5.1 — Maintenance
1. `maintenance_categories` (org-editable with platform defaults: electrical, plumbing, aircon, appliance, structure, pest, cleaning, other; default SLA hours per category), `tickets` (property, room nullable for common areas, lease nullable, reporter `tenant | staff | owner | system`, category, priority, description, photos, state `new → triaged → assigned → in_progress → waiting_parts → done → closed | cancelled`, assignee, cost lines, tenant rating + comment), `ticket_events`.
2. Tenant: create with photos in LIFF, follow progress, rate on close; owner/manager: triage, assign to staff or an external vendor (contact record), SLA timers, cost capture (feeds the expense summary B4.5); staff: my tickets, update with photos; auto-tickets from `maintenance.auto_ticket_requested` (meter stale/silent, gateway offline, D-034) with dedup per device per 24 h.
3. Notifications: tenant on each state change (quiet hours), staff on assignment, owner on SLA breach.
4. Acceptance: e2e tenant → owner triage → staff done with photo → tenant rates; SLA breach event; auto-ticket from a stale meter; cross-org 404s.

## Deliverable 5.2 — Access control (D-070, D-071)
1. `LockVendorAdapter` interface (create/revoke credential, time-boxed code, read unlock log, lock status/battery) with TTLock and Tuya implementations behind feature flags (fakes in tests); `access_credentials` (device, subject `tenant | staff | visitor | owner`, lease ref for tenants, type `app | pin | card | fingerprint`, valid_from/to, state), `unlock_events` (hypertable; subject, device, result, source).
2. Rules: credentials for tenants are created on lease activation and revoked on lease end/termination **only** (never from billing — a unit test asserts no dependency from `access` on `receivables`); visitor/staff codes time-boxed; owner revocation requires a reason and notifies the tenant; battery low → auto-ticket.
3. Endpoints: owner manage locks per room, issue visitor codes; staff temporary access for assigned tickets (auto-created for the ticket window); tenant: own credentials, own room's unlock log (D-025), building door access.
4. Acceptance: e2e lease activate → credential; lease end → revoked; unlock log visible only to the tenant and owner; a ticket assignment creates a time-boxed staff code; overdue bill changes nothing.

## Deliverable 5.3 — Community: announcements, parcels, rules, contacts
1. `announcements` (property or org, audience filter, content th + translations, pinned, read receipts per tenant), `parcels` (property, room, photo, received_by, state `received → notified → picked_up`, pick-up confirmation by tenant PIN or staff), `building_rules` (versioned, acknowledgement at move-in), `contacts` (emergency, building, vendors).
2. Endpoints for owner/staff/tenant; LINE push on announcement (quiet hours) and parcel received.
3. Acceptance: e2e announcement → read receipts; parcel flow; rules acknowledged at lease signing (hook into B2.3).

## Deliverable 5.4 — Staff tasks
1. A unified `staff_tasks` projection over reading rounds (B3.3), inspections (B2.4), install work orders (B3.1), tickets (5.1), parcels (5.3): `GET /v1/staff/tasks?property=&date=` grouped by type and floor, with priorities; completion writes back to the source aggregate.
2. Install work orders: generated from HaaS subscriptions (B6.1) — list of devices to install per room with the binding wizard (B3.1); progress visible to platform Field engineers.
3. Acceptance: e2e a day of tasks for a staff user; completing a task updates the source; property scope enforced for Staff limited to properties.

After each deliverable: `docs/PROGRESS.md`, contract regenerated, commit.
