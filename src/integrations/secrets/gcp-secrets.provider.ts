import { GoogleAuth } from 'google-auth-library';

import { type SecretsProvider } from './secrets.port';

/**
 * Secret Manager ids allow `[A-Za-z0-9_-]` only: getproperty's path-like ids (`getproperty/payments/platform/kbank/M-1`)
 * map to `getproperty--payments--platform--kbank--M-1`; any other character becomes `_`.
 */
export function gcpSecretId(secretId: string): string {
  return secretId
    .split('/')
    .map((s) => s.replace(/[^A-Za-z0-9_-]/g, '_'))
    .join('--')
    .slice(0, 255);
}

/**
 * Google Secret Manager (D-160, B6.5) behind the secrets port: reads the latest version of a JSON secret over the
 * REST API with the runtime service account (ADC; `roles/secretmanager.secretAccessor`). Values are never logged.
 * // UNVERIFIED against live provider
 */
export class GcpSecretsProvider implements SecretsProvider {
  private readonly auth: GoogleAuth;

  constructor(private readonly options: { projectId: string; auth?: GoogleAuth }) {
    this.auth =
      options.auth ?? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }

  async getJsonSecret(secretId: string): Promise<Record<string, string>> {
    const name = `projects/${this.options.projectId}/secrets/${gcpSecretId(secretId)}/versions/latest`;
    const client = await this.auth.getClient();
    const res = await client.request<{ payload?: { data?: string } }>({
      url: `https://secretmanager.googleapis.com/v1/${name}:access`,
      method: 'GET',
    });
    const data = res.data.payload?.data;
    if (!data) throw new Error(`Secret ${secretId} has no payload`);
    const parsed: unknown = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error(`Secret ${secretId} is not a JSON object`);
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }
}
