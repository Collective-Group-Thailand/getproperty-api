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
    description:
      'R2 service requests & work orders (B5.1, D-072): shows the menu entries per tenant; default off until the tenant starts R2.',
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
    description:
      'R2 smart locks (B5.2, D-070/D-071): shows the access menu entries per tenant; default off until the tenant installs locks.',
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
  {
    key: 'locks.vendor.ttlock',
    description:
      'B5.2 (D-070): TTLock cloud for this tenant’s locks — real adapter UNVERIFIED against the live API.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
  {
    key: 'locks.vendor.tuya',
    description:
      'B5.2 (D-070): Tuya cloud for this tenant’s locks — real adapter UNVERIFIED against the live API.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
  {
    key: 'payments.provider.kbank',
    description:
      'B4.4 (D-042, O-001): Thai QR through KBank for this tenant — real adapter UNVERIFIED against the live API.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
  {
    key: 'payments.provider.scb',
    description:
      'B4.4 (D-042, O-001): Thai QR through SCB for this tenant — real adapter UNVERIFIED against the live API.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
  {
    key: 'payments.provider.opn',
    description:
      'B4.4 (D-042, O-001): Thai QR (PromptPay) through Opn Payments — real adapter UNVERIFIED against the live API.',
    defaultEnabled: false,
    rolloutPct: 0,
  },
];
