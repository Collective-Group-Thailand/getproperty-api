/**
 * Feature flags (platform.feature_flag, seeded): switches for modules that arrive in later releases, so the web can
 * hide them per tenant without a deploy. Not business values (those are settings, ADR-0004).
 */
export interface FeatureFlagDef {
  key: string;
  description: string;
  defaultEnabled: boolean;
  rolloutPct: number;
}

export const FEATURE_FLAGS: readonly FeatureFlagDef[] = [
  {
    key: 'module.service_requests',
    description: 'R2 service requests & work orders (B5.1, D-072); off until the module ships.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
  {
    key: 'module.community',
    description: 'R2 announcements, parcels, facilities (B5.3, D-073); off until the module ships.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
  {
    key: 'module.smart_access',
    description: 'R2 smart locks (B5.2, D-070/D-071); off until the module ships.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
  {
    key: 'channel.web_push',
    description: 'Web push notifications for operators (B1.3).',
    defaultEnabled: true,
    rolloutPct: 100,
  },
  {
    key: 'resident.daily_usage',
    description: 'Daily electricity/water usage in the resident app where IoT meters exist (D-063, B3).',
    defaultEnabled: false,
    rolloutPct: 0,
  },
];
