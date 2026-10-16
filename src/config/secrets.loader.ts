import { AwsSecretsProvider } from '@integrations/secrets/aws-secrets.provider';
import { FakeSecretsProvider } from '@integrations/secrets/fake-secrets.provider';
import { type SecretsProvider } from '@integrations/secrets/secrets.port';

import { IntegrationsMode } from './env.schema';

export interface SecretsLoadResult {
  /** Names of the variables filled from the secret (never the values). */
  loadedKeys: string[];
}

/**
 * Runs before Nest boots and before env validation. When `AWS_SECRETS_ID` is set, reads that JSON
 * secret and fills the variables that are not already set: an explicit environment variable wins,
 * so a value can be overridden per deployment without editing the secret.
 */
export async function loadSecretsIntoEnv(
  env: NodeJS.ProcessEnv = process.env,
  provider: SecretsProvider = defaultProvider(env),
): Promise<SecretsLoadResult> {
  const secretId = env.AWS_SECRETS_ID;
  if (!secretId) return { loadedKeys: [] };

  const secret = await provider.getJsonSecret(secretId);
  const loadedKeys: string[] = [];
  for (const [key, value] of Object.entries(secret)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      loadedKeys.push(key);
    }
  }
  return { loadedKeys };
}

function defaultProvider(env: NodeJS.ProcessEnv): SecretsProvider {
  const mode: string | undefined = env.INTEGRATIONS_MODE;
  if (mode !== String(IntegrationsMode.Real)) return new FakeSecretsProvider();
  return new AwsSecretsProvider({
    region: env.AWS_REGION ?? 'ap-southeast-1',
    endpoint: env.AWS_ENDPOINT_URL,
  });
}
