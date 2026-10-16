# B5 — Operations (R2): service requests & work orders (A4), access control, community, staff tasks

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, `docs/schema-design.md` (v2) ก่อน · ต้องทำ B1–B4 เสร็จแล้ว · ทำทีละ Deliverable (5.1 → 5.4) ต่อ 1 session · Plan Mode ทุกครั้ง
> R2 scope (D-014, D-150 — maintenance stays R2) — เริ่มหลัง pilot ของ R1 ขึ้นระบบแล้ว

---

You are a senior backend engineer on **`getproperty-api`**. Decisions D-024, D-034, D-070–D-073, D-151, D-153, D-157, D-159 rule here. Requesters, assignees and recipients are **parties**; anything with an SLA runs on the **workflow engine** (`ops.workflow_instance`, D-159); external technicians use `getproperty-liff` through `/v1/technician/*` (audience `technician`, scopes `work_order:<uuid>`).

## Deliverable 5.1 — Service requests & work orders (blueprint A4)
1. `ops.service_category` (tenant-editable with platform defaults: electrical, plumbing, aircon, appliance, structure, pest, cleaning, other; default SLA hours per category), `ops.service_request` (building, unit nullable for common areas, `requester_party_id`, reporter kind `resident | staff | owner | system`, category, priority, description, photos, status `new → triaged → assigned → in_progress → waiting_parts → done → closed | cancelled`, `workflow_instance_id`, rating + comment, warranty flag), `ops.work_order` (service request nullable, `asset_item_id` nullable (preventive maintenance), kind `repair | preventive | install | deinstall | inspection`, `assignee_party_id` (internal staff or external technician), scheduled_at, cost, before/after photos, status, `workflow_instance_id`), `ops.work_order_cost_line`.
2. Resident: create with photos in LIFF, follow progress, rate on close; owner/manager: triage, create work orders, assign to staff or an external technician (party with a LINE link → technician token with `work_order:` scope), SLA timers (workflow), cost capture (feeds the expense summary B4.5); staff: my work orders, update with photos; technician (LIFF, `/v1/technician/*`): my work orders, check-in, before/after photos, parts/costs, close; auto-requests from `service.auto_request_requested` (meter stale/silent, gateway offline, D-034) with dedup per device per 24 h.
3. **Warranty hook** (blueprint A4.6, D-153): when the unit or asset item came from getbuild and the request falls inside its warranty, write an outbound `bridge.integration_event` `warranty.defect.reported` (contract from `collective-asset-core`) instead of assigning the building's technician; consume `warranty.defect.closed` to close the request. Until getbuild exists the event is stored and never sent (no consumer).
4. Notifications: resident on each state change (quiet hours), assignee on assignment, owner on SLA breach (workflow breach event).
5. Acceptance: e2e resident → owner triage → work order → technician done with photo (technician token sees only that work order) → resident rates; SLA breach event once; auto-request from a stale meter; warranty request writes one integration event; cross-tenant 404s + RLS.

## Deliverable 5.2 — Access control (D-070, D-071)
1. `LockVendorAdapter` interface (create/revoke credential, time-boxed code, read unlock log, lock status/battery) with TTLock and Tuya implementations behind feature flags (fakes in tests); locks are `core.asset_item` (category `lock`) + `smart.device`; `smart.access_credential` (device, holder party, kind `resident | staff | visitor | owner | technician`, lease ref for residents, work order ref for technicians, type `app | pin | card | fingerprint`, valid_from/to, state), `smart.access_event` (hypertable; holder, device, result, source).
2. Rules: credentials for residents are created on lease activation and revoked on lease end/termination **only** (never from billing — a unit test asserts no dependency from `smart-access` on `ops-receivables`; D-024, D-071, D-157); visitor/staff/technician codes time-boxed; owner revocation requires a reason and notifies the resident; battery low → auto service request.
3. Endpoints: owner manage locks per unit, issue visitor codes; technician/staff temporary access for assigned work orders (auto-created for the work-order window); resident: own credentials, own unit's access log (D-025), building door access.
4. Acceptance: e2e lease activate → credential; lease end → revoked; access log visible only to the resident and owner; a work-order assignment creates a time-boxed code; an overdue invoice changes nothing.

## Deliverable 5.3 — Community: announcements, parcels, facility booking, rules, contacts
1. `ops.announcement` (building or tenant-wide, audience filter, content th + translations, pinned, read receipts per party — `ops.announcement_read`), `ops.parcel` (building, unit, recipient party, photo, received_by, state `received → notified → picked_up | returned`, pick-up confirmation by resident PIN or staff), `ops.facility` + `ops.facility_booking` (common facilities per building, slots, quota per unit, approval optional — blueprint A1.6 / condo use later), `ops.building_rule` (versioned, acknowledgement at move-in — `ops.building_rule_ack`), `ops.contact` (emergency, building, vendors).
2. Endpoints for owner/staff/resident; LINE push on announcement (quiet hours) and parcel received.
3. Acceptance: e2e announcement → read receipts; parcel flow; booking within quota, double booking refused (exclusion constraint); rules acknowledged at lease signing (hook into B2.3).

## Deliverable 5.4 — Staff tasks
1. A unified `ops.staff_task` view over reading rounds (B3.3), inspections (B2.4), install/deinstall work orders (B3.1/B6.1), service work orders (5.1), parcels (5.3): `GET /v1/staff/tasks?building=&date=` grouped by type and floor, with priorities; completion writes back to the source aggregate.
2. Install work orders: generated from HaaS subscriptions (B6.1, `platform.install_order`) — list of devices to install per unit with the install wizard (B3.1); progress visible to platform Field engineers.
3. Acceptance: e2e a day of tasks for a staff user; completing a task updates the source; building scope enforced for Staff limited to buildings.

After each deliverable: `docs/PROGRESS.md`, contract regenerated, commit.
