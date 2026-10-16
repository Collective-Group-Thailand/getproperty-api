import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiExtension } from '@nestjs/swagger';

/**
 * The API surfaces (contract §2) and their token audiences (ADR-0003). Every operation id and tag is
 * prefixed by its surface (`owner.bills.issue`, tag `owner.bills`); `ops` is the ungated health tag.
 */
export const SURFACES = {
  auth: 'auth',
  owner: 'owner',
  tenant: 'tenant',
  staff: 'staff',
  admin: 'admin',
  device: 'device',
  webhooks: 'webhooks',
} as const;
export type Surface = (typeof SURFACES)[keyof typeof SURFACES];

export const AUDIENCES = ['org', 'tenant', 'platform', 'device'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** OpenAPI security scheme name per audience (`orgBearer`, …). */
export const SECURITY_SCHEMES: Record<Audience, string> = {
  org: 'orgBearer',
  tenant: 'tenantBearer',
  platform: 'platformBearer',
  device: 'deviceBearer',
};

/** URL prefix of each surface; `auth` issues tokens and `webhooks` verifies signatures (no audience). */
export const SURFACE_PREFIX: Record<Surface, string> = {
  auth: '/v1/auth/',
  owner: '/v1/owner/',
  tenant: '/v1/tenant/',
  staff: '/v1/staff/',
  admin: '/v1/admin/',
  device: '/v1/device/',
  webhooks: '/webhooks/',
};

export const SURFACE_AUDIENCE: Record<Surface, Audience | null> = {
  auth: null,
  owner: 'org',
  tenant: 'tenant',
  staff: 'org',
  admin: 'platform',
  device: 'device',
  webhooks: null,
};

export const SURFACE_DESCRIPTIONS: Record<Surface, string> = {
  auth: 'Token issuance for every audience: OTP, LINE, platform TOTP, device bootstrap, refresh, JWKS (contract §4).',
  owner:
    'Owner zone of getproperty-web — Owner, Manager, Accountant and Staff roles of one org (`org` audience, D-090).',
  tenant:
    'Tenant zone — LINE Mini App / mobile web, scoped to the tenant’s leases (`tenant` audience, D-060).',
  staff:
    'Staff PWA — readings, inspections, installs, repairs, parcels (`org` audience with the Staff role).',
  admin:
    'Platform admin zone — Collective Group staff: orgs, subscriptions, device fleet, tariffs, support (`platform` audience).',
  device:
    'Gateways (`getproperty-edge`) over HTTPS: bootstrap, config, OTA manifests, uploads; telemetry goes over MQTT (`device` audience, D-130).',
  webhooks:
    'Inbound provider callbacks (payment gateways, slip verification, LINE, lock vendors, e-Tax), signature-verified, no token.',
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
