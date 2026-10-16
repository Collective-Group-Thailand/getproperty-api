# ADR-0003 — Auth audiences & tokens (operator, resident, technician, platform, device)

**Status:** Accepted (2026-10-16, B1.1) — **amended 2026-10-16 by ADR-0009** (platform blueprint naming, D-151) — implemented in B1.3
**Decision ids:** D-004 (superseded in naming by D-151), D-025, D-060, D-061, D-090, D-091, D-130, D-151, D-152, D-154 · contract: `docs/contract/api-conventions.md` §2, §4, §7, §8

> **Amendment (ADR-0009, D-151).** The audiences were `org`, `tenant`, `platform`, `device`. "Tenant" now means only the SaaS customer organisation (`core.tenant`), so the people who live in units can no longer be called tenants in the API. The audiences are renamed and split: `org` → **`operator`**, `tenant` → **`resident`**, new **`technician`** (R2). Scopes `org:<uuid>` → **`tenant:<uuid>`**, `property:<uuid>` → **`building:<uuid>`**; header `X-Org-Id` → **`X-Tenant-Id`**; `OrgContext` → **`TenantContext`**; the surface `/v1/tenant/*` → **`/v1/resident/*`** (served by the separate `getproperty-liff` repo, D-154). The text below is the amended decision; the B1.1 code was renamed in the same change.

## Context
Five kinds of principals use one API, with sharply different data visibility:
- **operators** — the people working for a tenant (owner, manager, accountant, building staff — D-090), who must only ever see their tenant's rows and the buildings/units other tenants granted them (D-152 `asset_access_grant`);
- **residents** — lessees, co-occupants and condo owners using the LINE Mini App (`getproperty-liff`, D-154), who must only see their own leases, units and invoices (D-060);
- **technicians** — external technicians and contractors receiving work orders in LIFF (R2, blueprint A4.3), who must only see the work orders assigned to them;
- **platform staff** of Collective Group, who see every tenant but whose reads into a tenant are audited and, for Support, time-boxed (D-090);
- **devices** — gateways in buildings that publish telemetry over MQTT and call a few HTTPS endpoints (D-130).
The browser and LIFF apps run behind BFFs, so the backend never deals with cookies.

## Decision
- **Audiences:** `operator`, `resident`, `technician`, `platform`, `device`. Each access token carries exactly one `aud`; a guard on each surface prefix rejects any other audience:
  | Prefix | Audience | Consumer |
  |---|---|---|
  | `/v1/owner/*`, `/v1/staff/*` | `operator` | `getproperty-web` owner console and staff PWA |
  | `/v1/resident/*` | `resident` | `getproperty-liff` (resident pages) |
  | `/v1/technician/*` | `technician` | `getproperty-liff` (technician pages), R2 — placeholder ping until B5 |
  | `/v1/admin/*` | `platform` | `getproperty-web` platform admin zone |
  | `/v1/device/*` | `device` | `getproperty-edge` |
  `/v1/auth` issues tokens; `/webhooks` uses provider signatures, not tokens. The OpenAPI security schemes are named after the audiences: `operatorBearer`, `residentBearer`, `technicianBearer`, `platformBearer`, `deviceBearer`.
- **One person, several audiences.** A `core.user_account` may hold a tenant membership (operator), be linked to parties that rent or own units (resident) and be assigned work orders (technician). Each login asks for one audience and gets one token; switching zones is a new token exchange, never a token with several audiences.
- **Access token:** signed JWT, **EdDSA (Ed25519)**, 10–15 minutes. Claims: `sub` (user or device uuid), `aud`, `sid` (session family, enables revocation), `scp` — scopes `tenant:<uuid>` (every tenant the operator is a member of), `building:<uuid>` (a Staff role limited to buildings), `lease:<uuid>` and `unit:<uuid>` (a resident's leases, and units they own or occupy without a lease — condo owners), `work_order:<uuid>` (a technician's assignments), `iat`, `exp`, `kid`. Public keys at `/v1/auth/.well-known/jwks.json`; the private keys come from the secret store (`JWT_SIGNING_KEYS`, a JSON array: the first signs, the others still verify, so rotation publishes the new `kid` before signing with it).
- **Refresh token:** opaque random value, stored **hashed** in `platform.auth_session`, single-use and rotating; presenting an already-rotated token revokes the whole session family (theft detection). Logout revokes the session. Revoked families are also marked in Redis for the access-token lifetime so their access tokens stop at once; when Redis is unreachable the guard fails closed (503).
- **Tokens in bodies, not cookies:** login endpoints return `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, subject }`; the web and LIFF BFFs keep them in httpOnly cookies and forward `Authorization: Bearer`. Browsers never hold tokens in JS-readable storage.
- **Login methods per audience:** operators — phone OTP (6 digits; rate and attempt limits; primary) or email + password (argon2id) + optional TOTP; residents and technicians — LINE Login / LIFF id-token exchange with account linking (primary) or phone-OTP magic link; platform — email + password + **mandatory TOTP**; devices — **mTLS bootstrap**: `POST /v1/device/bootstrap` with the one-time provisioning code mints the X.509 client certificate (CN `gw-<gatewayId>`, 12-month rotation) and a short-lived device JWT; the certificate is the MQTT identity and an EMQX ACL row (`gp/v1/<gatewayId>/+`) is written at bootstrap.
- **Tenant context (contract §8):** every owner/staff request runs in exactly one tenant — the single `tenant:` scope of the token, or `X-Tenant-Id` when the operator has several (it must be one of the token's tenant scopes). `TenantContextMiddleware` → `TenantContext` → repositories add `tenant_id` to every query **and** set `app.tenant_id` for the transaction so PostgreSQL row-level security applies (schema-design v2 §4.5); a cross-tenant id anywhere (URL, filter, file key, cursor) is a **404**, and every module's test suite proves it. Resident and technician requests derive the tenant from the lease / unit / work order named in the path and set `app.tenant_id` the same way. B1.1 ships the resolver and the header checks; B1.3 wires the token scopes.
- **Authorisation is separate from authentication:** permissions `resource.action` (D-091) checked by `@Can()`; tenant roles Owner / Manager / Staff / Accountant on `core.membership` (with optional module and building scopes) and platform roles Platform admin / Support / Field engineer / Finance on `platform.platform_role_assignment` (D-090); **support grants** gate Support reads into a tenant (time-boxed, approved by the tenant Owner or granted by a Platform admin for incidents, every read audited). Resident and technician are audiences, not roles: their data is scoped by `lease:` / `unit:` / `work_order:` scopes, not permissions.
- **Never logged:** tokens, OTPs, passwords, TOTP secrets, provisioning codes, national ids, passport numbers, bank accounts (pino redaction list, `src/common/logging/redaction.ts`; PDPA, D-025).

## Alternatives considered
- **One audience with roles only:** a resident token could reach owner endpoints by a permission bug; audiences fail closed at the prefix before any business code runs.
- **Keep `tenant` as the resident audience and call the customer `org`:** contradicts the blueprint naming that getbuild and `collective-asset-core` share (D-151); "tenant" meaning two things is the bug the blueprint warns about.
- **Technicians as an operator role:** external contractors are not members of the tenant and must not see anything outside their work orders; a separate audience with `work_order:` scopes keeps that structural.
- **Sessions in cookies on the API:** ties the API to browsers; the LIFF app, the staff PWA and the BFFs all prefer bearer tokens.
- **Shared broker password per building** instead of per-gateway certificates: one leaked credential would let any device publish for any meter; per-device certificates make the ACL (`gp/v1/<gatewayId>/+`) enforceable by the broker.

## Consequences
- Every protected controller declares its surface with `ApiSurface()` so the contract shows the right scheme; `@Public()` and `@OptionalAuth(audience)` are the only ways to relax it and both are visible in the document (`security: []` / `[{}, { scheme: [] }]`).
- `core.user_account`, `core.user_identity`, `core.membership`, `platform.auth_session`, `platform.user_credential`, `platform.role`/`permission`/`role_permission`, `platform.platform_role_assignment`, `platform.support_grant` and the device certificate columns are part of schema-design v2.
- Token lifetimes, OTP policy and lockout rules are **settings** (ADR-0004), seeded as proposed values and confirmed by the security review before launch.
- The rename was a breaking contract change (B1.1 placeholders only, no consumers yet).
