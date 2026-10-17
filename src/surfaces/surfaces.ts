import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiExtension } from '@nestjs/swagger';

/**
 * The API surfaces (contract §2) and their token audiences (ADR-0003 as amended by ADR-0009, D-151).
 * Every operation id and tag is prefixed by its surface (`owner.invoices.issue`, tag `owner.invoices`);
 * `ops` is the ungated health tag. "Tenant" means the SaaS customer organisation only — the people who
 * live in units are *residents* (D-151).
 */
export const SURFACES = {
  auth: 'auth',
  owner: 'owner',
  staff: 'staff',
  resident: 'resident',
  technician: 'technician',
  admin: 'admin',
  device: 'device',
  webhooks: 'webhooks',
  public: 'public',
} as const;
export type Surface = (typeof SURFACES)[keyof typeof SURFACES];

/**
 * Token audiences: `operator` (people working for a tenant: owner, manager, accountant, building staff),
 * `resident` (lessees, co-occupants, condo owners — LIFF), `technician` (external contractors — LIFF, R2),
 * `platform` (Collective Group staff), `device` (gateways).
 */
export const AUDIENCES = ['operator', 'resident', 'technician', 'platform', 'device'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** OpenAPI security scheme name per audience (`operatorBearer`, …). */
export const SECURITY_SCHEMES: Record<Audience, string> = {
  operator: 'operatorBearer',
  resident: 'residentBearer',
  technician: 'technicianBearer',
  platform: 'platformBearer',
  device: 'deviceBearer',
};

/** URL prefix of each surface; `auth` issues tokens and `webhooks` verifies signatures (no audience). */
export const SURFACE_PREFIX: Record<Surface, string> = {
  auth: '/v1/auth/',
  owner: '/v1/owner/',
  staff: '/v1/staff/',
  resident: '/v1/resident/',
  technician: '/v1/technician/',
  admin: '/v1/admin/',
  device: '/v1/device/',
  webhooks: '/webhooks/',
  public: '/v1/public/',
};

export const SURFACE_AUDIENCE: Record<Surface, Audience | null> = {
  auth: null,
  owner: 'operator',
  staff: 'operator',
  resident: 'resident',
  technician: 'technician',
  admin: 'platform',
  device: 'device',
  webhooks: null,
  public: null,
};

export const SURFACE_DESCRIPTIONS: Record<Surface, string> = {
  auth: 'Token issuance for every audience: OTP, LINE, platform TOTP, device bootstrap, refresh, JWKS (contract §4).',
  owner:
    'Owner console of getproperty-web — Owner, Manager, Accountant and Staff roles of one tenant (`operator` audience, D-090, D-151).',
  staff:
    'Staff PWA of getproperty-web — readings, inspections, installs, service requests, parcels (`operator` audience with the Staff role).',
  resident:
    'Resident LINE Mini App (getproperty-liff, D-154) — lessees, co-occupants and condo owners, scoped to their leases and units (`resident` audience, D-060, D-151).',
  technician:
    'Technician LINE Mini App (getproperty-liff) — external technicians and contractors, scoped to the work orders assigned to them (`technician` audience; R2).',
  admin:
    'Platform admin zone — Collective Group staff: tenants, subscriptions, device fleet, tariffs, support, AI usage cost (`platform` audience, D-161).',
  device:
    'Gateways (`getproperty-edge`) over HTTPS: bootstrap, config, OTA manifests, uploads; telemetry goes over MQTT (`device` audience, D-130).',
  webhooks:
    'Inbound provider callbacks (payment gateways, slip verification, LINE, lock vendors, e-Tax), signature-verified, no token.',
  public:
    'Anonymous, cacheable reads for the marketing site of getproperty-web: price plans (D-156) and the published utility tariff ceiling (D-021a). No token, no personal data.',
};

export const SURFACE_EXTENSION = 'x-getproperty-surface';

/**
 * Declares the surface of a controller: the bearer scheme of its audience (so the contract shows the
 * right security) and the surface the audience guard enforces (B1.3). Surfaces without an audience
 * (`auth`, `webhooks`) get no scheme; their operations are public or signature-verified.
 */
export function ApiSurface(surface: Surface) {
  const audience = SURFACE_AUDIENCE[surface];
  const decorators = [ApiExtension(SURFACE_EXTENSION, surface)];
  if (audience) decorators.push(ApiBearerAuth(SECURITY_SCHEMES[audience]));
  return applyDecorators(...decorators);
}

/** The surface a route belongs to, from its path. */
export function surfaceOfPath(path: string): Surface | undefined {
  return (Object.keys(SURFACE_PREFIX) as Surface[]).find((s) => path.startsWith(SURFACE_PREFIX[s]));
}
