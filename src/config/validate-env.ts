import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { DataStoresMode, EnvironmentVariables, IntegrationsMode, NodeEnv } from './env.schema';

export class InvalidEnvironmentError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

/**
 * Validates and types the environment. Fails fast listing every problem.
 * Messages name the variable and the rule only — never the value (it may be a secret).
 */
export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  // An empty string in .env means "not set", so defaults and @IsOptional apply.
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const env = plainToInstance(EnvironmentVariables, cleaned, { enableImplicitConversion: false });
  const errors = validateSync(env, { whitelist: true, skipMissingProperties: false });

  const problems = errors.flatMap((error) =>
    Object.keys(error.constraints ?? {}).map((rule) => `${error.property}: failed "${rule}"`),
  );

  if (env.DATA_STORES_MODE === DataStoresMode.Real && !env.DATABASE_URL)
    problems.push('DATABASE_URL: required when DATA_STORES_MODE=real');
  if ((env.REDIS_MODE ?? env.DATA_STORES_MODE) === DataStoresMode.Real && !env.REDIS_URL)
    problems.push('REDIS_URL: required when Redis is real (DATA_STORES_MODE / REDIS_MODE)');
  if ((env.MQTT_MODE ?? env.DATA_STORES_MODE) === DataStoresMode.Real && !env.MQTT_URL)
    problems.push('MQTT_URL: required when the broker is real (DATA_STORES_MODE / MQTT_MODE)');

  if (env.PDF_RENDERER_MODE === 'queue' && !env.PDF_RENDER_REDIS_URL && !env.REDIS_URL)
    problems.push('PDF_RENDER_REDIS_URL: required (or REDIS_URL) when PDF_RENDERER_MODE=queue');

  for (const p of ['GETBUILD', 'GETPACK'] as const) {
    if (env[`INTEGRATION_${p}_TRANSPORT`] === 'webhook') {
      if (!env[`INTEGRATION_${p}_WEBHOOK_URL`])
        problems.push(`INTEGRATION_${p}_WEBHOOK_URL: required when INTEGRATION_${p}_TRANSPORT=webhook`);
      const keys = (env[`INTEGRATION_${p}_SIGNING_KEYS`] ?? '').split(',').filter((k) => k.trim());
      if (keys.length === 0 || keys.some((k) => k.trim().length < 32))
        problems.push(
          `INTEGRATION_${p}_SIGNING_KEYS: one or more keys of ≥ 32 characters required for the webhook transport`,
        );
    }
  }

  if (env.NODE_ENV === NodeEnv.Production) {
    if (env.PDF_RENDERER_MODE === 'fake')
      problems.push('PDF_RENDERER_MODE: must be "real" or "queue" when NODE_ENV=production');
    if (env.INTEGRATIONS_MODE === IntegrationsMode.Fake)
      problems.push('INTEGRATIONS_MODE: must be "real" when NODE_ENV=production');
    if (env.DATA_STORES_MODE === DataStoresMode.Fake)
      problems.push('DATA_STORES_MODE: must be "real" when NODE_ENV=production');
    if (!env.FIELD_ENCRYPTION_KEY || Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64').length !== 32)
      problems.push('FIELD_ENCRYPTION_KEY: 32 bytes base64 required when NODE_ENV=production');
    if (env.PUBLIC_API_BASE_URL.includes('localhost'))
      problems.push('PUBLIC_API_BASE_URL: set the real origin when NODE_ENV=production');
    if (env.MQTT_PUBLIC_WS_URL && !env.MQTT_PUBLIC_WS_URL.startsWith('wss://'))
      problems.push('MQTT_PUBLIC_WS_URL: wss:// only when NODE_ENV=production (or leave it unset, D-231)');
    if (env.DEVICE_PUBLIC_BASE_URL && !env.DEVICE_PUBLIC_BASE_URL.startsWith('https://'))
      problems.push(
        'DEVICE_PUBLIC_BASE_URL: https:// only when NODE_ENV=production (or leave it empty, D-231)',
      );
    if (env.REDIS_MODE === DataStoresMode.Fake)
      problems.push('REDIS_MODE: must not be "fake" when NODE_ENV=production');
    if (env.MQTT_MODE === DataStoresMode.Fake)
      problems.push('MQTT_MODE: must not be "fake" when NODE_ENV=production');
    for (const key of [
      'FIELD_HASH_KEY',
      'AUTH_JWT_PRIVATE_KEY',
      'DEVICE_CA_CERT',
      'DEVICE_CA_KEY',
      'LINE_LOGIN_CHANNEL_IDS',
      'LINE_MESSAGING_ACCESS_TOKEN',
      'SMS_API_URL',
      'SMS_API_KEY',
      'WEB_PUSH_VAPID_PUBLIC_KEY',
      'WEB_PUSH_VAPID_PRIVATE_KEY',
      'CLAMAV_HOST',
    ] as const) {
      if (!env[key]) problems.push(`${key}: required when NODE_ENV=production`);
    }
  }

  if (problems.length > 0) throw new InvalidEnvironmentError(problems);
  return env;
}
