import { SURFACE_DESCRIPTIONS, SURFACES } from '../../surfaces/surfaces';

/**
 * Every OpenAPI tag with its description (contract §5). An operation tag missing here fails the
 * contract build. Tags are `<surface>.<resource>` (`owner.bills`) or `ops.<area>`.
 * Business modules add their tags here in their own deliverable (B2–B6).
 */
export const API_TAGS: Record<string, string> = {
  'ops.health': 'Liveness and readiness of the API and its dependencies, for load balancers and ops.',
  'auth.system': `${SURFACE_DESCRIPTIONS[SURFACES.auth]} Placeholder until B1.3 (ping only).`,
  'owner.system': `${SURFACE_DESCRIPTIONS[SURFACES.owner]} Placeholder until B1.3 (ping only).`,
  'staff.system': `${SURFACE_DESCRIPTIONS[SURFACES.staff]} Placeholder until B1.3 (ping only).`,
  'resident.system': `${SURFACE_DESCRIPTIONS[SURFACES.resident]} Placeholder until B1.3 (ping only).`,
  'technician.system': `${SURFACE_DESCRIPTIONS[SURFACES.technician]} Placeholder until B5 (ping only).`,
  'admin.system': `${SURFACE_DESCRIPTIONS[SURFACES.admin]} System: ping and build information.`,
  'device.system': `${SURFACE_DESCRIPTIONS[SURFACES.device]} Placeholder until B1.3 (ping only).`,
  'webhooks.system': `${SURFACE_DESCRIPTIONS[SURFACES.webhooks]} Placeholder until B4 (ping only).`,
  'webhooks.placeholder':
    'PLACEHOLDER provider callback shape (payload, signature header, expected response); the real providers (payment QR, slip verification, LINE) arrive in B4.',
};
