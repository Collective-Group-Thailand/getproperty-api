import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { type SecretsProvider } from './secrets.port';

export class AwsSecretsProvider implements SecretsProvider {
  private readonly client: SecretsManagerClient;

  constructor(options: { region: string; endpoint?: string }) {
    this.client = new SecretsManagerClient({
      region: options.region,
      endpoint: options.endpoint,
      maxAttempts: 3,
    });
  }

  async getJsonSecret(secretId: string): Promise<Record<string, string>> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!result.SecretString) throw new Error(`Secret ${secretId} has no SecretString`);
    const parsed: unknown = JSON.parse(result.SecretString);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Secret ${secretId} is not a JSON object`);
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }
}
