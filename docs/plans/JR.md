# JR — Resident identity by unit (plan + record)

Step JR of `docs/prompts/J-juristic-api.md` (pack J, D-309 = D-J08), read with the "J0:" corrections and `docs/juristic-gap.md` (row JR, §3). Branch `feat/JR-resident-units` from `main` `23fbd84` (asset-core 0.8.0).

## Part 0 — clock-pinned integration tests (separate commit)
Seven integration tests failed once the real date passed 2026-11-01: the seed starts `platform.setting_version` and `platform.consent_purpose_version` at the seeding instant, so suites whose fake clock sits before it (billing at 2026-11-01, loss at 2026-11-03, smart-metering 3.3 at 2026-10-27) found no version in force. `test/support/int-db.ts` `backdateSeededVersions()` moves the seeded versions to 2026-01-01 (test setup only, like `load.int-spec`); smart-metering 3.3 pins its clock to 2026-10-27 (instead of `max(now, 10-27)`) after clearing the OTP challenges of the earlier wall-clock tests (resend gap). No assertion changed.

## What exists (J0 findings, re-verified)
- `SubjectService.resident` gives `lease:<id>` (every visible lease of a linked party) and `unit:<id>` (current **occupancy** only). A co-owner who does not live in the unit gets no `unit:` scope → no notices / parcels / rules / contacts / facilities.
- Invoices, receipts, payments are already party-scoped (`billedPartyId ∈ my parties`, or a lease party when the lease has no payer).
- Community, service requests, CSAT, access read `unit:` scopes; parcels / bookings / unit requests are windowed by `occupancyWindows` (start of my current occupancy, review #9).
- Usage is reachable only through `GET /v1/resident/leases/{leaseId}/usage`.
- Only `lease_resident` / `tenant_member` invitations exist; `/v1/resident/link` accepts lease invitations only.

## Design
1. **Unit roles** (`src/core/identity/resident-units.ts`, one computation for the token, `/me`, `/me/units`):
   - ownership (current `core.unit_ownership` of a linked party: `valid_from ≤ today < valid_to`) → `co_owner`, source `ownership`;
   - occupancy (current `core.occupancy`) → `tenant` / `co_tenant` / `family` (`family`, `staff`) / `co_owner` (`owner_occupier`), source `occupancy`;
   - leases in force on the unit (`active`, `notice_given`, `ending`, dates covering today) → `tenant` (lessee) / `co_tenant` / `family` (occupant) and `payer` (`lease.payer_party_id`), source `lease` — context only;
   - `today` = the Bangkok business date (review #15). Bill-to (`payer` from `juristic.bill_to`) arrives with J1.1.
   - `unit:` scopes = units with an **ownership or occupancy** role (a lease alone never adds a unit: unchanged for apartments). `lease:` scopes unchanged.
   - `unitsHash` = sha256 of the sorted `unitId:role:source` set; `GET /v1/resident/me/units` answers it with `refreshRequired` = the token's `unit:` scopes differ from the current set (the LIFF refreshes). The JWT format is not changed.
2. **Windows** (`occupancyWindows`, review #9 kept): occupancy → from its start (unchanged). Ownership only → from `max(ownership start, end of the last occupancy of another party)` and **no window while another party occupies the unit** (the occupant's parcels / requests / bookings stay theirs, PDPA D-025).
3. **Occupant-only features**: unit usage, visitor codes and the unit's door log need a current occupancy of mine (a non-resident co-owner gets 404 / no policy) — usage and door logs are the occupant's personal data and a door code lets someone into an occupied home.
4. **Lease-bound endpoints** (the 13 paths of gap §3) stay bound to the parties of that lease (404 otherwise) — unchanged, so a co-owner who is not on the lease gets 404.
5. **Invoices**: rule unchanged (billed party, or lease party without a payer) → a co-owner sees the invoices billed to them (common fees) only, a family occupant (not on a lease, not billed) sees none; new optional `unitId` filter (unit switcher). A former owner keeps seeing invoices **billed to them** (they are the debtor); unit data (notices, parcels, usage) ends at the ownership end.
6. **Co-owner onboarding**: migration 0069 — `platform.invitation_kind` + `unit_resident`, `platform.invitation.unit_id → core.unit`, CHECK extended (unit_resident ⇒ unit_id and party_id), `platform.otp_purpose` + `unit_invitation`; setting `juristic.resident_invite_days` (14, platform + tenant). `POST /v1/owner/units/{unitId}/resident-invites` (`unit.manage`, Idempotency-Key, audit + outbox `unit.resident_invited`) for a party with a current ownership of the unit (default: the only current owner) whose party has a phone (422 `invitation.phone_missing`); channels `line_qr` (QR, also printed) / `sms` (sent inline like the lease invitation — the code is a credential, never in the outbox) / `link`; a new invite revokes the pending ones of the same unit + party. `GET` lists them (codes never shown again).
   Resident: `GET /v1/resident/unit-invitations/{code}` (preview, masked name + phone), `POST …/{code}/otp` (OTP to the phone of the ownership party, purpose `unit_invitation`), `POST …/{code}/accept` `{challengeId, code}` (consent first, OTP verified, link `linked_via invitation`, invitation accepted, audit + outbox `unit.resident_linked`). Single use (409 `invitation.not_pending`), 14 days, wrong OTP 401 `auth.otp_invalid`.
7. **Endpoints**: `GET /v1/resident/me/units`, `GET /v1/resident/units/{unitId}/usage`, the 5 invitation operations; `/me` gains `unitRoles[]` (additive), its `entitlements` count ownership units for bills / modules (not lease / usage / access).
8. **Not in JR**: owner register / transfer UI (J1.1), bill-to (J1.1), LINE push of the invite (the QR is shown / printed; LINE needs the co-owner's LINE id, which they get by redeeming).

## Tests
- Unit: role derivation, windows rule, hash stability, SubjectService (Bangkok date, ownership scopes).
- Integration `resident-units.int-spec.ts`: co-owner without lease (invite → OTP → accept → `unit:` scope, notices + parcels, own common-fee invoice only, no rent invoice, usage 404, lease paths 404); co-owner of two units in two tenants (both in `/me/units`, invoices filter by unit); family occupant (notices / parcels, no invoices; payer sees); former owner after the ownership end (scope, parcels, `/me/units` gone; old token windows empty); invite single use / expiry / wrong OTP / revoked by a newer invite; cross-tenant 404 on every new endpoint.
- Every existing resident integration spec unchanged.

## Gates
lint · format:check · typecheck · unit · contract build + lint · integration full (0 failed) · build.

## Done (2026-11-05)
- Part 0 commit `test: pin clock-dependent integration tests` (integration 70 suites, 513 passed, 1 skipped).
- `src/core/identity/resident-units.ts` (roles, scope units, occupied units, hash); `SubjectService.resident` scopes ownership units; `occupancyWindows` ownership rule; access views / unit usage occupant-only; `myParty` falls back to the owning party (announcement reads, requests, bookings).
- Migration 0069 (`unit_resident`, `unit_invitation`, `invitation.unit_id`); setting `juristic.resident_invite_days`; audit + events `unit.resident_invited` / `unit.resident_linked`; error `invitation.phone_missing` (422, th/en).
- Endpoints: `GET /v1/resident/me/units`, `GET /v1/resident/units/{unitId}/usage`, `GET /v1/resident/unit-invitations/{code}`, `POST …/{code}/otp`, `POST …/{code}/accept`, `POST|GET /v1/owner/units/{unitId}/resident-invites`; `/me` + `unitRoles`; `/resident/invoices?unitId=`.
- Tests: `resident-units.spec.ts`, `subjects.service.spec.ts` (ownership), `test/integration/resident-units.int-spec.ts` (5 cases).
- Decision D-322 (JR implementation details); schema-design row 203.
